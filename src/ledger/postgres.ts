// Postgres ledger backend. Same SQL shape as SqliteBackend (ADR 0001), same money rule (ADR 0002):
// amounts are canonical base-10 TEXT end to end, decoded to bigint only at this boundary. Never
// SUM() or ORDER BY an amount column — Postgres would do it numerically "correctly" and silently
// stop matching the hash chain's bigint arithmetic the moment anyone typos a cast.
//
// `pg` is an optionalDependency (see package.json): importing it eagerly would force every
// memory/sqlite-only user to install a Postgres driver they never use, so it is loaded lazily in
// `init()`, not at module load time.
//
// One real difference from SqliteBackend that isn't just dialect: `node:sqlite` is synchronous, so
// SqliteBackend's whole safety story for `append`/`createWallet` is "no `await` between the check
// and the write, so nothing else can run in between." `pg` is unavoidably async — every query is a
// Promise — so two concurrent calls on the same instance really could interleave mid-write without
// something stopping them. The engine already serializes intents behind its own `Mutex` (ADR 0005),
// which covers normal use, but a backend used directly (as the conformance suite does) has no such
// guarantee. This backend wraps its own write paths in the same `Mutex` class so the guarantee holds
// here too, independent of any caller.

import { randomUUID } from 'node:crypto';
import { Mutex } from '../engine/mutex.ts';
import type { Memo, OwnerId, Tx, TxId, TxKind, TxRef, Wallet, WalletId } from '../types.ts';
import type {
  BackendName,
  CreateWalletOptions,
  HistoryPage,
  IntegrityReport,
  LedgerBackend,
  WalletKeyInfo,
} from './backend.ts';
import {
  DuplicateKey,
  DuplicateNonce,
  InsufficientFunds,
  InvalidAmount,
  InvalidIntent,
  LedgerCorrupt,
  UnknownWallet,
} from '../errors.ts';
import {
  GENESIS_HASH,
  canonicalTxPayload,
  decodeAmount,
  compareCheckpoint,
  encodeAmount,
  hashTx,
  headOf,
  validateMemo,
  verifyChain,
  verifyStructure,
} from './hashchain.ts';
import type { Checkpoint, Violation } from './hashchain.ts';

// Structurally compatible with pg.Client / pg.PoolClient, without a hard import at the type level
// so `@types/pg` stays a devDependency and this file still typechecks if it is ever absent.
interface PgRow {
  [column: string]: unknown;
}
interface PgResult {
  rows: PgRow[];
}
interface PgClientLike {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(text: string, values?: readonly unknown[]): Promise<PgResult>;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

// Postgres equivalent of SqliteBackend's GLOB check: digits only, no leading zero unless "0" alone.
const NON_NEGATIVE_TEXT = (col: string): string =>
  `${col} ~ '^[0-9]+$' AND (${col} = '0' OR ${col} !~ '^0')`;

function schemaFor(explicit: string | undefined): string {
  if (explicit !== undefined) {
    if (!/^[a-z_][a-z0-9_]*$/.test(explicit)) {
      throw new InvalidIntent(`PostgresBackend schema name is not a safe identifier: ${explicit}`);
    }
    return explicit;
  }
  // No explicit schema: a fresh one per instance, so tests (and anything else that wants
  // isolation) get it automatically, and a real deployment just always passes one.
  return `heist_${randomUUID().replace(/-/g, '')}`;
}

function quoteIdent(id: string): string {
  return `"${id.replace(/"/g, '""')}"`;
}

function schemaDdl(schema: string): string {
  const s = quoteIdent(schema);
  return `
CREATE SCHEMA IF NOT EXISTS ${s};

CREATE TABLE IF NOT EXISTS ${s}.wallets (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL UNIQUE CHECK (length(owner_id) > 0),
  address    TEXT NOT NULL CHECK (length(address) > 0),
  pubkey     TEXT NOT NULL CHECK (length(pubkey) > 0),
  is_entity  BOOLEAN NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ${s}.transactions (
  id          TEXT PRIMARY KEY,
  seq         INTEGER NOT NULL UNIQUE CHECK (seq >= 0),
  kind        TEXT NOT NULL CHECK (kind IN ('transfer', 'mint', 'burn')),
  from_wallet TEXT NULL REFERENCES ${s}.wallets(id),
  to_wallet   TEXT NULL REFERENCES ${s}.wallets(id),
  amount      TEXT NOT NULL CHECK (amount <> '0' AND (${NON_NEGATIVE_TEXT('amount')})),
  memo        TEXT NOT NULL,
  prev_hash   TEXT NOT NULL CHECK (length(prev_hash) = 64),
  hash        TEXT NOT NULL CHECK (length(hash) = 64),
  signature   TEXT NULL,
  created_at  TEXT NOT NULL,
  CHECK (
    (kind = 'mint'     AND from_wallet IS NULL     AND to_wallet IS NOT NULL) OR
    (kind = 'burn'     AND from_wallet IS NOT NULL AND to_wallet IS NULL) OR
    (kind = 'transfer' AND from_wallet IS NOT NULL AND to_wallet IS NOT NULL AND from_wallet <> to_wallet)
  )
);

CREATE TABLE IF NOT EXISTS ${s}.balances (
  wallet_id TEXT PRIMARY KEY REFERENCES ${s}.wallets(id),
  amount    TEXT NOT NULL CHECK (${NON_NEGATIVE_TEXT('amount')})
);

CREATE TABLE IF NOT EXISTS ${s}.nonces (
  nonce      TEXT PRIMARY KEY,
  tx_id      TEXT NOT NULL REFERENCES ${s}.transactions(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ${s}.memo_keys (
  key        TEXT PRIMARY KEY,
  tx_id      TEXT NOT NULL REFERENCES ${s}.transactions(id),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transactions_from_wallet ON ${s}.transactions(from_wallet);
CREATE INDEX IF NOT EXISTS idx_transactions_to_wallet   ON ${s}.transactions(to_wallet);
CREATE INDEX IF NOT EXISTS idx_transactions_seq         ON ${s}.transactions(seq);

-- Append-only, same intent as the sqlite triggers: stops accidents and casual tampering through
-- this schema. Anyone with write access to the database can drop the trigger; the hash chain and a
-- stored checkpoint are what actually catch tampering.
CREATE OR REPLACE FUNCTION ${s}.forbid_mutation() RETURNS trigger AS $BODY$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$BODY$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER transactions_no_update BEFORE UPDATE ON ${s}.transactions
  FOR EACH ROW EXECUTE FUNCTION ${s}.forbid_mutation();
CREATE OR REPLACE TRIGGER transactions_no_delete BEFORE DELETE ON ${s}.transactions
  FOR EACH ROW EXECUTE FUNCTION ${s}.forbid_mutation();
CREATE OR REPLACE TRIGGER nonces_no_update BEFORE UPDATE ON ${s}.nonces
  FOR EACH ROW EXECUTE FUNCTION ${s}.forbid_mutation();
CREATE OR REPLACE TRIGGER nonces_no_delete BEFORE DELETE ON ${s}.nonces
  FOR EACH ROW EXECUTE FUNCTION ${s}.forbid_mutation();
CREATE OR REPLACE TRIGGER memo_keys_no_update BEFORE UPDATE ON ${s}.memo_keys
  FOR EACH ROW EXECUTE FUNCTION ${s}.forbid_mutation();
CREATE OR REPLACE TRIGGER memo_keys_no_delete BEFORE DELETE ON ${s}.memo_keys
  FOR EACH ROW EXECUTE FUNCTION ${s}.forbid_mutation();
CREATE OR REPLACE TRIGGER wallets_no_update BEFORE UPDATE ON ${s}.wallets
  FOR EACH ROW EXECUTE FUNCTION ${s}.forbid_mutation();
CREATE OR REPLACE TRIGGER wallets_no_delete BEFORE DELETE ON ${s}.wallets
  FOR EACH ROW EXECUTE FUNCTION ${s}.forbid_mutation();
`;
}

// --- row coercion ------------------------------------------------------------

function readText(row: PgRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new LedgerCorrupt(`Column "${column}" is not TEXT (got ${typeof value})`);
  }
  return value;
}

function readNullableText(row: PgRow, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new LedgerCorrupt(`Column "${column}" is not TEXT or NULL (got ${typeof value})`);
  }
  return value;
}

function readBool(row: PgRow, column: string): boolean {
  const value = row[column];
  if (typeof value !== 'boolean') {
    throw new LedgerCorrupt(`Column "${column}" is not BOOLEAN (got ${typeof value})`);
  }
  return value;
}

/** `seq` is a Postgres INTEGER, which `pg` already returns as a JS number. Never for money. */
function readSmallInt(row: PgRow, column: string): number {
  const value = row[column];
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  throw new LedgerCorrupt(`Column "${column}" is not a small INTEGER (got ${typeof value})`);
}

function readAmount(row: PgRow, column: string, min: bigint): bigint {
  const text = readText(row, column);
  try {
    return decodeAmount(text, min);
  } catch {
    throw new LedgerCorrupt(`Column "${column}" does not hold a canonical amount of at least ${min}`);
  }
}

function textOrViolation(row: PgRow, column: string, violations: Violation[], what: string): string | null {
  const value = row[column];
  if (typeof value === 'string') return value;
  violations.push({ seq: null, reason: `${what} is not TEXT (got ${typeof value})` });
  return null;
}

function isTxKind(value: string): value is TxKind {
  return value === 'transfer' || value === 'mint' || value === 'burn';
}

// --- memo serialization (identical to SqliteBackend; memo is TEXT here too) -------------------

function encodeMemo(memo: Memo): string {
  const out: Record<string, unknown> = { intent: memo.intent };
  if (memo.detail !== undefined) out['detail'] = memo.detail;
  if (memo.nonce !== undefined) out['nonce'] = memo.nonce;
  if (memo.key !== undefined) out['key'] = memo.key;
  if (memo.meta !== undefined) out['meta'] = memo.meta;
  return JSON.stringify(out);
}

function decodeMemo(raw: string): Memo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LedgerCorrupt(`Stored memo is not valid JSON: ${raw}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new LedgerCorrupt('Stored memo is not an object');
  }
  const record = parsed as Record<string, unknown>;
  const intent = record['intent'];
  if (typeof intent !== 'string') {
    throw new LedgerCorrupt('Stored memo has no string "intent"');
  }
  const memo: Memo = { intent };
  const detail = record['detail'];
  if (typeof detail === 'string') memo.detail = detail;
  const nonce = record['nonce'];
  if (typeof nonce === 'string') memo.nonce = nonce;
  const key = record['key'];
  if (typeof key === 'string') memo.key = key;
  const meta = record['meta'];
  if (meta !== undefined) {
    if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
      throw new LedgerCorrupt('Stored memo has a malformed "meta"');
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(meta)) {
      if (typeof v !== 'string') throw new LedgerCorrupt('Stored memo has a non-string meta value');
      out[k] = v;
    }
    memo.meta = out;
  }
  return memo;
}

// --- cursors (identical scheme to SqliteBackend) ------------------------------------------------

function encodeCursor(seq: number): string {
  return Buffer.from(`v1:${seq}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^v1:(\d+)$/.exec(decoded);
  if (match === null) throw new InvalidIntent(`Malformed history cursor: ${cursor}`);
  const seq = Number(match[1]);
  if (!Number.isSafeInteger(seq)) throw new InvalidIntent(`Malformed history cursor: ${cursor}`);
  return seq;
}

interface ChainTail {
  seq: number;
  hash: string;
}

export class PostgresBackend implements LedgerBackend {
  readonly name: BackendName = 'postgres';

  private readonly connectionString: string;
  private readonly schema: string;
  private readonly ephemeral: boolean;
  private client: PgClientLike | undefined;
  private open = false;
  private readonly mutex = new Mutex();

  /**
   * `schema` lets a real deployment pin a stable name across restarts (so `init()` finds its own
   * tables again rather than making a new empty schema each boot) — that schema outlives `close()`.
   * Omit it and this instance gets a fresh, random schema that `close()` drops automatically: a
   * throwaway database for tests or anything else that wants one.
   */
  constructor(connectionString: string, schema?: string) {
    this.connectionString = connectionString;
    this.ephemeral = schema === undefined;
    this.schema = schemaFor(schema);
  }

  async init(): Promise<void> {
    // Lazy: an optionalDependency should never be required just to import this file.
    const pg = await import('pg');
    const client = new pg.Client({ connectionString: this.connectionString }) as unknown as PgClientLike;
    await client.connect();
    this.client = client;
    this.open = true;
    await this.exec(schemaDdl(this.schema));
    // One dedicated connection per instance (never a pool — see the header comment), so
    // `search_path` set here holds for every query this instance ever runs. That is what lets
    // every query below use plain, unqualified table names instead of rewriting SQL text.
    await this.exec(`SET search_path TO ${quoteIdent(this.schema)}`);
  }

  async close(): Promise<void> {
    if (!this.open) return;
    if (this.ephemeral) {
      try {
        await this.exec(`DROP SCHEMA IF EXISTS ${quoteIdent(this.schema)} CASCADE`);
      } catch {
        // best-effort cleanup; closing still proceeds either way
      }
    }
    // Grab the client before flipping `open`: `database()` refuses once it is false, so ending
    // the connection has to happen first or this throws on itself every single time.
    const client = this.database();
    this.open = false;
    await client.end();
  }

  // --- wallets ----------------------------------------------------------------------------------

  async createWallet(ownerId: OwnerId, key: WalletKeyInfo, opts?: CreateWalletOptions): Promise<Wallet> {
    if (typeof ownerId !== 'string' || ownerId.length === 0 || !ownerId.isWellFormed()) {
      throw new InvalidIntent('ownerId must be a non-empty, well-formed string');
    }
    if (key === null || typeof key !== 'object') {
      throw new InvalidIntent('key must be a WalletKeyInfo');
    }
    if (typeof key.pubkey !== 'string' || key.pubkey.length === 0) {
      throw new InvalidIntent('key.pubkey must be a non-empty string');
    }
    if (typeof key.address !== 'string' || key.address.length === 0) {
      throw new InvalidIntent('key.address must be a non-empty string');
    }

    return this.mutex.run(async () => {
      const wallet: Wallet = {
        id: randomUUID(),
        ownerId,
        address: key.address,
        pubkey: key.pubkey,
        isEntity: opts?.isEntity ?? false,
        createdAt: new Date().toISOString(),
      };

      await this.exec('BEGIN');
      try {
        const existing = await this.query('SELECT * FROM wallets WHERE owner_id = $1', [ownerId]);
        if (existing.rows.length > 0) {
          await this.exec('COMMIT');
          return this.toWallet(existing.rows[0] as PgRow);
        }
        await this.query(
          `INSERT INTO wallets (id, owner_id, address, pubkey, is_entity, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (owner_id) DO NOTHING`,
          [wallet.id, wallet.ownerId, wallet.address, wallet.pubkey, wallet.isEntity, wallet.createdAt],
        );
        await this.query('INSERT INTO balances (wallet_id, amount) VALUES ($1, $2)', [
          wallet.id,
          encodeAmount(0n),
        ]);
        await this.exec('COMMIT');
      } catch (error) {
        await this.rollback();
        throw error;
      }
      return wallet;
    });
  }

  async getWallet(id: WalletId): Promise<Wallet | null> {
    const result = await this.query('SELECT * FROM wallets WHERE id = $1', [id]);
    return result.rows.length === 0 ? null : this.toWallet(result.rows[0] as PgRow);
  }

  async getWalletByOwner(ownerId: OwnerId): Promise<Wallet | null> {
    const result = await this.query('SELECT * FROM wallets WHERE owner_id = $1', [ownerId]);
    return result.rows.length === 0 ? null : this.toWallet(result.rows[0] as PgRow);
  }

  async listWallets(): Promise<Wallet[]> {
    const result = await this.query('SELECT * FROM wallets ORDER BY created_at, id', []);
    return result.rows.map((row) => this.toWallet(row));
  }

  async getBalance(id: WalletId): Promise<bigint> {
    const result = await this.query('SELECT amount FROM balances WHERE wallet_id = $1', [id]);
    if (result.rows.length === 0) throw new UnknownWallet(id);
    return readAmount(result.rows[0] as PgRow, 'amount', 0n);
  }

  // --- ledger writes ------------------------------------------------------------------------------

  async transfer(from: WalletId, to: WalletId, amount: bigint, memo: Memo): Promise<TxRef> {
    if (from === to) throw new InvalidIntent('Cannot transfer a wallet to itself');
    return this.append('transfer', from, to, amount, memo);
  }

  async mint(to: WalletId, amount: bigint, memo: Memo): Promise<TxRef> {
    return this.append('mint', null, to, amount, memo);
  }

  async burn(from: WalletId, amount: bigint, memo: Memo): Promise<TxRef> {
    return this.append('burn', from, null, amount, memo);
  }

  /**
   * The single write path, same shape as SqliteBackend.append. Wrapped in `this.mutex` (see the
   * header comment) because, unlike sqlite, nothing here is synchronous.
   */
  private async append(kind: TxKind, from: WalletId | null, to: WalletId | null, amount: bigint, memo: Memo): Promise<TxRef> {
    if (typeof amount !== 'bigint') {
      throw new InvalidAmount('Amount must be a bigint of whole HD');
    }
    if (amount <= 0n) {
      throw new InvalidAmount(`Amount must be positive, got ${amount} HD`);
    }
    validateMemo(memo);

    return this.mutex.run(async () => {
      await this.exec('BEGIN');
      try {
        const nonce = memo.nonce;
        if (nonce !== undefined && (await this.nonceExists(nonce))) {
          throw new DuplicateNonce(nonce);
        }
        const key = memo.key;
        if (key !== undefined && (await this.keyExists(key))) {
          throw new DuplicateKey(key);
        }

        if (from !== null) await this.assertWalletExists(from);
        if (to !== null) await this.assertWalletExists(to);

        if (from !== null) {
          const available = await this.balanceOf(from);
          if (available < amount) throw new InsufficientFunds(from, amount, available);
        }

        const tail = await this.chainTail();
        const seq = tail === null ? 0 : tail.seq + 1;
        const prevHash = tail === null ? GENESIS_HASH : tail.hash;
        const createdAt = new Date().toISOString();
        const id: TxId = randomUUID();

        const tx: Tx = {
          id,
          kind,
          from,
          to,
          amount,
          memo,
          prevHash,
          hash: '',
          signature: null,
          createdAt,
          seq,
        };
        tx.hash = hashTx(canonicalTxPayload(tx));

        await this.query(
          `INSERT INTO transactions
             (id, seq, kind, from_wallet, to_wallet, amount, memo, prev_hash, hash, signature, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            tx.id,
            tx.seq,
            tx.kind,
            tx.from,
            tx.to,
            encodeAmount(tx.amount),
            encodeMemo(tx.memo),
            tx.prevHash,
            tx.hash,
            tx.signature,
            tx.createdAt,
          ],
        );

        if (from !== null) await this.setBalance(from, (await this.balanceOf(from)) - amount);
        if (to !== null) await this.setBalance(to, (await this.balanceOf(to)) + amount);

        if (nonce !== undefined) {
          await this.query('INSERT INTO nonces (nonce, tx_id, created_at) VALUES ($1, $2, $3)', [
            nonce,
            tx.id,
            createdAt,
          ]);
        }
        if (key !== undefined) {
          await this.query('INSERT INTO memo_keys (key, tx_id, created_at) VALUES ($1, $2, $3)', [
            key,
            tx.id,
            createdAt,
          ]);
        }

        await this.exec('COMMIT');
        return { txId: tx.id, hash: tx.hash, seq: tx.seq };
      } catch (error) {
        await this.rollback();
        throw error;
      }
    });
  }

  // --- reads ----------------------------------------------------------------------------------

  async history(id: WalletId, cursor?: string, limit = DEFAULT_LIMIT): Promise<HistoryPage> {
    await this.assertWalletExists(id);
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new InvalidIntent(`History limit must be a positive integer, got ${limit}`);
    }
    const size = Math.min(limit, MAX_LIMIT);

    const result =
      cursor === undefined
        ? await this.query(
            `SELECT * FROM transactions
              WHERE from_wallet = $1 OR to_wallet = $1
              ORDER BY seq DESC
              LIMIT $2`,
            [id, size + 1],
          )
        : await this.query(
            `SELECT * FROM transactions
              WHERE (from_wallet = $1 OR to_wallet = $1) AND seq < $2
              ORDER BY seq DESC
              LIMIT $3`,
            [id, decodeCursor(cursor), size + 1],
          );

    const page = result.rows.slice(0, size).map((row) => this.toTx(row));
    const last = page[page.length - 1];
    const nextCursor = result.rows.length > size && last !== undefined ? encodeCursor(last.seq) : null;
    return { txs: page, cursor: nextCursor };
  }

  async getTx(txId: string): Promise<Tx | null> {
    const result = await this.query('SELECT * FROM transactions WHERE id = $1', [txId]);
    return result.rows.length === 0 ? null : this.toTx(result.rows[0] as PgRow);
  }

  async hasNonce(nonce: string): Promise<boolean> {
    return this.nonceExists(nonce);
  }

  async getTxByNonce(nonce: string): Promise<Tx | null> {
    const result = await this.query(
      'SELECT t.* FROM nonces n JOIN transactions t ON t.id = n.tx_id WHERE n.nonce = $1',
      [nonce],
    );
    return result.rows.length === 0 ? null : this.toTx(result.rows[0] as PgRow);
  }

  // --- integrity --------------------------------------------------------------------------------

  async checkpoint(): Promise<Checkpoint | null> {
    const tail = await this.chainTail();
    return tail === null ? null : { seq: tail.seq, hash: tail.hash };
  }

  /** Same five checks as SqliteBackend.verifyIntegrity; see that file's doc comment. */
  async verifyIntegrity(expected?: Checkpoint): Promise<IntegrityReport> {
    // REPEATABLE READ so the several SELECTs below see one consistent snapshot, the same property
    // SqliteBackend gets from running them inside one `BEGIN .. COMMIT`.
    await this.exec('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    try {
      return await this.verifyIntegrityInTx(expected);
    } finally {
      try {
        await this.exec('COMMIT');
      } catch {
        // nothing to release
      }
    }
  }

  private async verifyIntegrityInTx(expected?: Checkpoint): Promise<IntegrityReport> {
    const txRows = await this.query('SELECT * FROM transactions ORDER BY seq ASC', []);

    const txs: Tx[] = [];
    const violations: Violation[] = [];
    for (const row of txRows.rows) {
      try {
        txs.push(this.toTx(row));
      } catch (error) {
        const seq = row['seq'];
        violations.push({
          seq: typeof seq === 'number' ? seq : null,
          reason: `row cannot be decoded: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    const { brokenAt } = verifyChain(txs);

    const walletIds = new Set<WalletId>();
    const walletRows = await this.query('SELECT id FROM wallets', []);
    for (const walletRow of walletRows.rows) {
      const id = textOrViolation(walletRow, 'id', violations, 'wallets.id');
      if (id !== null) walletIds.add(id);
    }
    violations.push(...verifyStructure(txs, walletIds));

    const folded = new Map<WalletId, bigint>();
    for (const id of walletIds) folded.set(id, 0n);
    for (const tx of txs) {
      if (tx.from !== null) folded.set(tx.from, (folded.get(tx.from) ?? 0n) - tx.amount);
      if (tx.to !== null) folded.set(tx.to, (folded.get(tx.to) ?? 0n) + tx.amount);
    }

    const stored = new Map<WalletId, bigint>();
    const undecodable = new Set<WalletId>();
    const balanceRows = await this.query('SELECT wallet_id, amount FROM balances', []);
    for (const row of balanceRows.rows) {
      const id = textOrViolation(row, 'wallet_id', violations, 'balances.wallet_id');
      if (id === null) continue;
      try {
        stored.set(id, readAmount(row, 'amount', 0n));
      } catch (error) {
        undecodable.add(id);
        violations.push({
          seq: null,
          reason: `balance of ${id} is invalid: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    const balanceMismatches: WalletId[] = [];
    for (const walletId of new Set([...folded.keys(), ...stored.keys(), ...undecodable])) {
      if (undecodable.has(walletId) || (folded.get(walletId) ?? 0n) !== (stored.get(walletId) ?? 0n)) {
        balanceMismatches.push(walletId);
      }
    }
    balanceMismatches.sort();

    violations.push(...(await this.replayGuardViolations(txs)));

    const checkpoint = expected === undefined ? 'none' : compareCheckpoint(txs, expected);

    return {
      ok:
        brokenAt.length === 0 &&
        balanceMismatches.length === 0 &&
        violations.length === 0 &&
        (checkpoint === 'none' || checkpoint === 'ok'),
      checked: txRows.rows.length,
      brokenAt,
      balanceMismatches,
      violations,
      head: headOf(txs),
      checkpoint,
    };
  }

  private async replayGuardViolations(txs: readonly Tx[]): Promise<Violation[]> {
    const out: Violation[] = [];
    const txIds = new Set(txs.map((tx) => tx.id));

    const guards = [
      { table: 'nonces', column: 'nonce', of: (tx: Tx) => tx.memo.nonce },
      { table: 'memo_keys', column: 'key', of: (tx: Tx) => tx.memo.key },
    ] as const;

    for (const guard of guards) {
      const recorded = new Map<string, string>();
      const rows = await this.query(`SELECT ${guard.column} AS k, tx_id FROM ${guard.table}`, []);
      for (const row of rows.rows) {
        const k = textOrViolation(row, 'k', out, `${guard.table} key`);
        const txId = textOrViolation(row, 'tx_id', out, `${guard.table}.tx_id`);
        if (k !== null && txId !== null) recorded.set(k, txId);
      }
      for (const tx of txs) {
        const value = guard.of(tx);
        if (value === undefined) continue;
        if (recorded.get(value) !== tx.id) {
          out.push({ seq: tx.seq, reason: `${guard.table} has no matching row for ${JSON.stringify(value)}` });
        }
      }
      const valuesInLedger = new Set(txs.map(guard.of).filter((v): v is string => v !== undefined));
      for (const [value, txId] of recorded) {
        if (!txIds.has(txId) || !valuesInLedger.has(value)) {
          out.push({ seq: null, reason: `${guard.table} row ${JSON.stringify(value)} points at no ledger tx` });
        }
      }
    }
    return out;
  }

  // --- internals --------------------------------------------------------------------------------

  private database(): PgClientLike {
    if (!this.open || this.client === undefined) throw new InvalidIntent('PostgresBackend is closed');
    return this.client;
  }

  private async exec(sql: string): Promise<void> {
    await this.database().query(sql);
  }

  private async query(sql: string, values: readonly unknown[]): Promise<PgResult> {
    // Plain, unqualified table names: safe because this instance owns one dedicated connection
    // (never a pool) with `search_path` pinned to its schema in `init()`, so there is no "which
    // session is this" ambiguity for it to depend on.
    return this.database().query(sql, values as unknown[]);
  }

  private async rollback(): Promise<void> {
    try {
      await this.exec('ROLLBACK');
    } catch {
      // no active transaction — nothing to undo
    }
  }

  private async nonceExists(nonce: string): Promise<boolean> {
    const result = await this.query('SELECT 1 FROM nonces WHERE nonce = $1', [nonce]);
    return result.rows.length > 0;
  }

  private async keyExists(key: string): Promise<boolean> {
    const result = await this.query('SELECT 1 FROM memo_keys WHERE key = $1', [key]);
    return result.rows.length > 0;
  }

  private async assertWalletExists(id: WalletId): Promise<void> {
    const result = await this.query('SELECT 1 FROM wallets WHERE id = $1', [id]);
    if (result.rows.length === 0) throw new UnknownWallet(id);
  }

  private async balanceOf(id: WalletId): Promise<bigint> {
    const result = await this.query('SELECT amount FROM balances WHERE wallet_id = $1', [id]);
    if (result.rows.length === 0) throw new UnknownWallet(id);
    return readAmount(result.rows[0] as PgRow, 'amount', 0n);
  }

  private async setBalance(id: WalletId, amount: bigint): Promise<void> {
    await this.query('UPDATE balances SET amount = $1 WHERE wallet_id = $2', [encodeAmount(amount), id]);
  }

  private async chainTail(): Promise<ChainTail | null> {
    const result = await this.query('SELECT seq, hash FROM transactions ORDER BY seq DESC LIMIT 1', []);
    if (result.rows.length === 0) return null;
    const row = result.rows[0] as PgRow;
    return { seq: readSmallInt(row, 'seq'), hash: readText(row, 'hash') };
  }

  private toWallet(row: PgRow): Wallet {
    return {
      id: readText(row, 'id'),
      ownerId: readText(row, 'owner_id'),
      address: readText(row, 'address'),
      pubkey: readText(row, 'pubkey'),
      isEntity: readBool(row, 'is_entity'),
      createdAt: readText(row, 'created_at'),
    };
  }

  private toTx(row: PgRow): Tx {
    const kind = readText(row, 'kind');
    if (!isTxKind(kind)) throw new LedgerCorrupt(`Unknown tx kind "${kind}"`);
    return {
      id: readText(row, 'id'),
      kind,
      from: readNullableText(row, 'from_wallet'),
      to: readNullableText(row, 'to_wallet'),
      amount: readAmount(row, 'amount', 1n),
      memo: decodeMemo(readText(row, 'memo')),
      prevHash: readText(row, 'prev_hash'),
      hash: readText(row, 'hash'),
      signature: readNullableText(row, 'signature'),
      createdAt: readText(row, 'created_at'),
      seq: readSmallInt(row, 'seq'),
    };
  }
}
