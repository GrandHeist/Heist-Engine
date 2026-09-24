// SQLite ledger backend, built on the BUILT-IN `node:sqlite` module. No external deps.
//
// Two things drive nearly every decision in this file, both from ADR 0002:
//
//   1. `setReadBigInts(true)` is per-PREPARED-STATEMENT, not per-connection. Any statement that
//      forgets it throws `RangeError: Value is too large to be represented as a JavaScript number`
//      the moment an INTEGER column holds more than 2^53. So no money ever lives in an INTEGER
//      column here — amounts are canonical base-10 TEXT, decoded to bigint at this boundary and
//      nowhere else. The flag is therefore never needed and never used.
//   2. Because amounts are TEXT, SQL cannot do arithmetic on them: no `SUM(amount)`, and no
//      `ORDER BY amount` (text ordering is not numeric ordering). Balances are maintained in a
//      `balances` table written inside the same SQLite transaction as the ledger append, and all
//      ordering is by `seq`.
//
// The only INTEGER columns are `seq` (a chain position, bounded by row count) and `is_entity`
// (0/1). Neither can approach 2^53.

import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { SQLOutputValue } from 'node:sqlite';

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

const BUSY_TIMEOUT_MS = 5000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

// Canonical non-negative base-10 text (no sign, no leading zero, digits only), as a CHECK body.
// SQLite has no regex, so GLOB: first char a digit, no non-digit anywhere, and "0" only alone.
const NON_NEGATIVE_TEXT = (col: string): string =>
  `${col} GLOB '[0-9]*' AND ${col} NOT GLOB '*[^0-9]*' AND (${col} = '0' OR ${col} NOT GLOB '0*')`;

// Constraints only bind on tables created by this SCHEMA; `CREATE TABLE IF NOT EXISTS` leaves a
// pre-existing table alone. Triggers are `IF NOT EXISTS` too, so they do reach an old database.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS wallets (
  id         TEXT NOT NULL PRIMARY KEY,
  owner_id   TEXT NOT NULL UNIQUE CHECK (length(owner_id) > 0),
  address    TEXT NOT NULL CHECK (length(address) > 0),
  pubkey     TEXT NOT NULL CHECK (length(pubkey) > 0),
  is_entity  INTEGER NOT NULL CHECK (is_entity IN (0, 1)),
  created_at TEXT NOT NULL
);

-- amount is TEXT. See ADR 0002. Never SUM() it, never ORDER BY it.
CREATE TABLE IF NOT EXISTS transactions (
  id          TEXT NOT NULL PRIMARY KEY,
  seq         INTEGER NOT NULL UNIQUE CHECK (seq >= 0),
  kind        TEXT NOT NULL CHECK (kind IN ('transfer', 'mint', 'burn')),
  from_wallet TEXT NULL REFERENCES wallets(id),
  to_wallet   TEXT NULL REFERENCES wallets(id),
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

-- A balance can never be negative: the overdraft check in append() is backed by the schema.
CREATE TABLE IF NOT EXISTS balances (
  wallet_id TEXT NOT NULL PRIMARY KEY REFERENCES wallets(id),
  amount    TEXT NOT NULL CHECK (${NON_NEGATIVE_TEXT('amount')})
);

CREATE TABLE IF NOT EXISTS nonces (
  nonce      TEXT NOT NULL PRIMARY KEY,
  tx_id      TEXT NOT NULL REFERENCES transactions(id),
  created_at TEXT NOT NULL
);

-- Business-object keys (Memo.key): at most one tx per key, enforced by the PRIMARY KEY.
CREATE TABLE IF NOT EXISTS memo_keys (
  key        TEXT NOT NULL PRIMARY KEY,
  tx_id      TEXT NOT NULL REFERENCES transactions(id),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transactions_from_wallet ON transactions(from_wallet);
CREATE INDEX IF NOT EXISTS idx_transactions_to_wallet   ON transactions(to_wallet);
CREATE INDEX IF NOT EXISTS idx_transactions_seq         ON transactions(seq);

-- Append-only. These stop accidents and casual tampering through this schema; anyone with write
-- access to the file can DROP TRIGGER. That is what the hash chain and a stored checkpoint are for.
CREATE TRIGGER IF NOT EXISTS transactions_no_update BEFORE UPDATE ON transactions
  BEGIN SELECT RAISE(ABORT, 'transactions is append-only'); END;
CREATE TRIGGER IF NOT EXISTS transactions_no_delete BEFORE DELETE ON transactions
  BEGIN SELECT RAISE(ABORT, 'transactions is append-only'); END;
CREATE TRIGGER IF NOT EXISTS nonces_no_update BEFORE UPDATE ON nonces
  BEGIN SELECT RAISE(ABORT, 'nonces is append-only'); END;
CREATE TRIGGER IF NOT EXISTS nonces_no_delete BEFORE DELETE ON nonces
  BEGIN SELECT RAISE(ABORT, 'nonces is append-only'); END;
CREATE TRIGGER IF NOT EXISTS memo_keys_no_update BEFORE UPDATE ON memo_keys
  BEGIN SELECT RAISE(ABORT, 'memo_keys is append-only'); END;
CREATE TRIGGER IF NOT EXISTS memo_keys_no_delete BEFORE DELETE ON memo_keys
  BEGIN SELECT RAISE(ABORT, 'memo_keys is append-only'); END;
CREATE TRIGGER IF NOT EXISTS wallets_no_update BEFORE UPDATE ON wallets
  BEGIN SELECT RAISE(ABORT, 'wallets is append-only'); END;
CREATE TRIGGER IF NOT EXISTS wallets_no_delete BEFORE DELETE ON wallets
  BEGIN SELECT RAISE(ABORT, 'wallets is append-only'); END;
`;

// --- row coercion -----------------------------------------------------------
// node:sqlite hands back `SQLOutputValue` (null | number | bigint | string | Uint8Array).
// Everything crossing back into domain types goes through these, so a schema drift surfaces
// as LEDGER_CORRUPT rather than as a silently wrong type.

function readText(row: Record<string, SQLOutputValue>, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new LedgerCorrupt(`Column "${column}" is not TEXT (got ${typeof value})`);
  }
  return value;
}

function readNullableText(row: Record<string, SQLOutputValue>, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new LedgerCorrupt(`Column "${column}" is not TEXT or NULL (got ${typeof value})`);
  }
  return value;
}

/** Only for small, bounded INTEGER columns (`seq`, `is_entity`). Never for money. */
function readSmallInt(row: Record<string, SQLOutputValue>, column: string): number {
  const value = row[column];
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new LedgerCorrupt(`Column "${column}" exceeds the safe integer range`);
    }
    return Number(value);
  }
  throw new LedgerCorrupt(`Column "${column}" is not a small INTEGER (got ${typeof value})`);
}

/** A stored amount, decoded, and required to be >= min. A row that breaks that is corruption. */
function readAmount(row: Record<string, SQLOutputValue>, column: string, min: bigint): bigint {
  const text = readText(row, column);
  try {
    return decodeAmount(text, min);
  } catch {
    throw new LedgerCorrupt(`Column "${column}" does not hold a canonical amount of at least ${min}`);
  }
}

/** A TEXT column read for verification: a non-text value is reported as a violation, never thrown. */
function textOrViolation(
  row: Record<string, SQLOutputValue>,
  column: string,
  violations: Violation[],
  what: string,
): string | null {
  const value = row[column];
  if (typeof value === 'string') return value;
  violations.push({ seq: null, reason: `${what} is not TEXT (got ${typeof value})` });
  return null;
}

function isTxKind(value: string): value is TxKind {
  return value === 'transfer' || value === 'mint' || value === 'burn';
}

// --- memo serialization -----------------------------------------------------
// Fixed key order so the stored form is stable, and absent keys are omitted rather than written
// as null — `exactOptionalPropertyTypes` means `{ detail: undefined }` is not a valid Memo.

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

// --- cursors ----------------------------------------------------------------
// Opaque to callers: base64url over a versioned payload. Only ever carries a seq, because seq is
// the sole ordering key (ADR 0002 forbids ordering by amount).

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

export class SqliteBackend implements LedgerBackend {
  readonly name: BackendName = 'sqlite';

  readonly path: string;
  private db: DatabaseSync;
  private open = true;

  constructor(path = ':memory:') {
    this.path = path;
    this.db = new DatabaseSync(path);
  }

  async init(): Promise<void> {
    const db = this.database();
    // Wait for another writer (a second process, a backup) instead of failing at once.
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec('PRAGMA journal_mode = WAL');
    // In WAL mode SQLite's default (NORMAL) can lose the newest committed transactions on power
    // loss. Money is not allowed to be that casual: fsync every commit on a real file.
    if (this.path !== ':memory:') db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(SCHEMA);
  }

  async close(): Promise<void> {
    if (!this.open) return;
    this.open = false;
    this.db.close();
  }

  // --- wallets --------------------------------------------------------------

  /**
   * The keypair is minted by Custody and arrives already split: this backend receives the public
   * half only and persists it verbatim. It never generates, derives or stores private key
   * material — a self-generated keypair here would yield a pubkey nothing can sign for.
   * Idempotent per owner: a second call returns the existing wallet and ignores `key`.
   */
  async createWallet(
    ownerId: OwnerId,
    key: WalletKeyInfo,
    opts?: CreateWalletOptions,
  ): Promise<Wallet> {
    const db = this.database();
    if (typeof ownerId !== 'string' || ownerId.length === 0 || !ownerId.isWellFormed()) {
      throw new InvalidIntent('ownerId must be a non-empty, well-formed string');
    }
    // A wallet with no pubkey/address is one nothing can ever sign for — see the WalletKeyInfo
    // doc comment in backend.ts. Reject before anything is persisted.
    if (key === null || typeof key !== 'object') {
      throw new InvalidIntent('key must be a WalletKeyInfo');
    }
    if (typeof key.pubkey !== 'string' || key.pubkey.length === 0) {
      throw new InvalidIntent('key.pubkey must be a non-empty string');
    }
    if (typeof key.address !== 'string' || key.address.length === 0) {
      throw new InvalidIntent('key.address must be a non-empty string');
    }

    // No await between the existence check and the insert: this whole method body is synchronous
    // from here, so two in-process callers cannot interleave, and BEGIN IMMEDIATE makes a second
    // process wait for the write lock. ON CONFLICT covers any path that still slips through.
    const wallet: Wallet = {
      id: randomUUID(),
      ownerId,
      address: key.address,
      pubkey: key.pubkey,
      isEntity: opts?.isEntity ?? false,
      createdAt: new Date().toISOString(),
    };

    db.exec('BEGIN IMMEDIATE');
    try {
      const existingRow = db.prepare('SELECT * FROM wallets WHERE owner_id = ?').get(ownerId);
      if (existingRow !== undefined) {
        db.exec('COMMIT');
        return this.toWallet(existingRow);
      }
      db.prepare(
        `INSERT INTO wallets (id, owner_id, address, pubkey, is_entity, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner_id) DO NOTHING`,
      ).run(
        wallet.id,
        wallet.ownerId,
        wallet.address,
        wallet.pubkey,
        wallet.isEntity ? 1 : 0,
        wallet.createdAt,
      );
      db.prepare('INSERT INTO balances (wallet_id, amount) VALUES (?, ?)').run(
        wallet.id,
        encodeAmount(0n),
      );
      db.exec('COMMIT');
    } catch (error) {
      this.rollback();
      throw error;
    }

    return wallet;
  }

  async getWallet(id: WalletId): Promise<Wallet | null> {
    const row = this.database().prepare('SELECT * FROM wallets WHERE id = ?').get(id);
    return row === undefined ? null : this.toWallet(row);
  }

  async getWalletByOwner(ownerId: OwnerId): Promise<Wallet | null> {
    const row = this.database().prepare('SELECT * FROM wallets WHERE owner_id = ?').get(ownerId);
    return row === undefined ? null : this.toWallet(row);
  }

  async listWallets(): Promise<Wallet[]> {
    const rows = this.database().prepare('SELECT * FROM wallets ORDER BY created_at, id').all();
    return rows.map((row) => this.toWallet(row));
  }

  async getBalance(id: WalletId): Promise<bigint> {
    const row = this.database().prepare('SELECT amount FROM balances WHERE wallet_id = ?').get(id);
    if (row === undefined) throw new UnknownWallet(id);
    return readAmount(row, 'amount', 0n);
  }

  // --- ledger writes --------------------------------------------------------

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
   * The single write path. Appending the tx, moving both balances and recording the nonce all
   * happen inside one `BEGIN IMMEDIATE` .. `COMMIT`, so a partially applied transfer cannot exist.
   * Any throw rolls the whole thing back.
   */
  private append(
    kind: TxKind,
    from: WalletId | null,
    to: WalletId | null,
    amount: bigint,
    memo: Memo,
  ): TxRef {
    const db = this.database();
    // Same guards, same codes as MemoryBackend. A JS number that slips through here would be
    // hashed and stored as text before anything noticed it was not a bigint.
    if (typeof amount !== 'bigint') {
      throw new InvalidAmount('Amount must be a bigint of whole HD');
    }
    if (amount <= 0n) {
      throw new InvalidAmount(`Amount must be positive, got ${amount} HD`);
    }
    // Includes "an empty nonce is not a nonce": stored, it would occupy the nonces PRIMARY KEY
    // once and make every later empty-nonce write collide. Rejected outside the transaction.
    validateMemo(memo);

    db.exec('BEGIN IMMEDIATE');
    try {
      const nonce = memo.nonce;
      if (nonce !== undefined && this.nonceExists(nonce)) {
        throw new DuplicateNonce(nonce);
      }
      const key = memo.key;
      if (key !== undefined && this.keyExists(key)) {
        throw new DuplicateKey(key);
      }

      if (from !== null) this.assertWalletExists(from);
      if (to !== null) this.assertWalletExists(to);

      if (from !== null) {
        const available = this.balanceOf(from);
        if (available < amount) throw new InsufficientFunds(from, amount, available);
      }

      const tail = this.chainTail();
      const seq = tail === null ? 0 : tail.seq + 1;
      const prevHash = tail === null ? GENESIS_HASH : tail.hash;
      const createdAt = new Date().toISOString();
      const id: TxId = randomUUID();

      // hash is filled in from the canonical payload below; it is not part of what is hashed.
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
      const hash = hashTx(canonicalTxPayload(tx));
      tx.hash = hash;

      db.prepare(
        `INSERT INTO transactions
           (id, seq, kind, from_wallet, to_wallet, amount, memo, prev_hash, hash, signature, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
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
      );

      if (from !== null) this.setBalance(from, this.balanceOf(from) - amount);
      if (to !== null) this.setBalance(to, this.balanceOf(to) + amount);

      if (nonce !== undefined) {
        db.prepare('INSERT INTO nonces (nonce, tx_id, created_at) VALUES (?, ?, ?)').run(
          nonce,
          tx.id,
          createdAt,
        );
      }

      if (key !== undefined) {
        db.prepare('INSERT INTO memo_keys (key, tx_id, created_at) VALUES (?, ?, ?)').run(
          key,
          tx.id,
          createdAt,
        );
      }

      db.exec('COMMIT');
      return { txId: tx.id, hash: tx.hash, seq: tx.seq };
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  // --- reads ----------------------------------------------------------------

  async history(id: WalletId, cursor?: string, limit = DEFAULT_LIMIT): Promise<HistoryPage> {
    const db = this.database();
    // An unknown wallet is an error, not an empty page — otherwise a caller cannot tell
    // "no history" from "no such wallet". Matches getBalance and MemoryBackend.
    this.assertWalletExists(id);
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new InvalidIntent(`History limit must be a positive integer, got ${limit}`);
    }
    const size = Math.min(limit, MAX_LIMIT);

    // Newest first. Ordered by seq (never by amount — amount is TEXT, ADR 0002).
    // One extra row tells us whether another page exists without a second count query.
    const rows =
      cursor === undefined
        ? db
            .prepare(
              `SELECT * FROM transactions
                WHERE from_wallet = ? OR to_wallet = ?
                ORDER BY seq DESC
                LIMIT ?`,
            )
            .all(id, id, size + 1)
        : db
            .prepare(
              `SELECT * FROM transactions
                WHERE (from_wallet = ? OR to_wallet = ?) AND seq < ?
                ORDER BY seq DESC
                LIMIT ?`,
            )
            .all(id, id, decodeCursor(cursor), size + 1);

    const page = rows.slice(0, size).map((row) => this.toTx(row));
    const last = page[page.length - 1];
    const nextCursor = rows.length > size && last !== undefined ? encodeCursor(last.seq) : null;
    return { txs: page, cursor: nextCursor };
  }

  async getTx(txId: string): Promise<Tx | null> {
    const row = this.database().prepare('SELECT * FROM transactions WHERE id = ?').get(txId);
    return row === undefined ? null : this.toTx(row);
  }

  async hasNonce(nonce: string): Promise<boolean> {
    return this.nonceExists(nonce);
  }

  async getTxByNonce(nonce: string): Promise<Tx | null> {
    const row = this.database()
      .prepare('SELECT t.* FROM nonces n JOIN transactions t ON t.id = n.tx_id WHERE n.nonce = ?')
      .get(nonce);
    return row === undefined ? null : this.toTx(row);
  }

  // --- integrity ------------------------------------------------------------

  async checkpoint(): Promise<Checkpoint | null> {
    const tail = this.chainTail();
    return tail === null ? null : { seq: tail.seq, hash: tail.hash };
  }

  /**
   * Reads every row LENIENTLY (a row that cannot be decoded is reported, not thrown), then checks
   *   1. hashes and prev_hash links (hashchain.verifyChain: same breaks on every backend),
   *   2. ledger rules a re-hashed row can still break (hashchain.verifyStructure),
   *   3. the maintained `balances` table against an independent fold of the history (ADR 0002
   *      accepts that it can drift; this is what detects it), and no negative stored balance,
   *   4. that the replay-guard tables (`nonces`, `memo_keys`) still match the ledger row for row,
   *      because a deleted nonce row quietly re-opens a replay,
   *   5. optionally, a checkpoint kept outside the database (truncation / rewritten tail).
   */
  async verifyIntegrity(expected?: Checkpoint): Promise<IntegrityReport> {
    // One read transaction, so a writer committing in another process cannot land between the
    // separate SELECTs and show up as a false balance mismatch.
    const db = this.database();
    db.exec('BEGIN');
    try {
      return this.verifyIntegrityInTx(expected);
    } finally {
      try {
        db.exec('COMMIT');
      } catch {
        // nothing to release
      }
    }
  }

  private verifyIntegrityInTx(expected?: Checkpoint): IntegrityReport {
    const db = this.database();
    const rows = db.prepare('SELECT * FROM transactions ORDER BY seq ASC').all();

    const txs: Tx[] = [];
    const violations: Violation[] = [];
    for (const row of rows) {
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

    // Hash and linkage checks live in hashchain.ts so every backend reports identical breaks.
    // An undecodable row leaves a gap in seq, which shows up here as a break too.
    const { brokenAt } = verifyChain(txs);

    const walletIds = new Set<WalletId>();
    for (const walletRow of db.prepare('SELECT id FROM wallets').all()) {
      const id = textOrViolation(walletRow, 'id', violations, 'wallets.id');
      if (id !== null) walletIds.add(id);
    }
    violations.push(...verifyStructure(txs, walletIds));

    // Every known wallet starts at zero, so a wallet with a stored balance but no history is
    // still checked.
    const folded = new Map<WalletId, bigint>();
    for (const id of walletIds) folded.set(id, 0n);
    for (const tx of txs) {
      if (tx.from !== null) folded.set(tx.from, (folded.get(tx.from) ?? 0n) - tx.amount);
      if (tx.to !== null) folded.set(tx.to, (folded.get(tx.to) ?? 0n) + tx.amount);
    }

    const stored = new Map<WalletId, bigint>();
    const undecodable = new Set<WalletId>();
    for (const row of db.prepare('SELECT wallet_id, amount FROM balances').all()) {
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

    violations.push(...this.replayGuardViolations(txs));

    const checkpoint = expected === undefined ? 'none' : compareCheckpoint(txs, expected);

    return {
      ok:
        brokenAt.length === 0 &&
        balanceMismatches.length === 0 &&
        violations.length === 0 &&
        (checkpoint === 'none' || checkpoint === 'ok'),
      checked: rows.length,
      brokenAt,
      balanceMismatches,
      violations,
      head: headOf(txs),
      checkpoint,
    };
  }

  /** `nonces` and `memo_keys` must list exactly the nonces/keys the ledger rows carry. */
  private replayGuardViolations(txs: readonly Tx[]): Violation[] {
    const db = this.database();
    const out: Violation[] = [];
    const txIds = new Set(txs.map((tx) => tx.id));

    const guards = [
      { table: 'nonces', column: 'nonce', of: (tx: Tx) => tx.memo.nonce },
      { table: 'memo_keys', column: 'key', of: (tx: Tx) => tx.memo.key },
    ] as const;

    for (const guard of guards) {
      const recorded = new Map<string, string>();
      for (const row of db.prepare(`SELECT ${guard.column} AS k, tx_id FROM ${guard.table}`).all()) {
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

  // --- internals ------------------------------------------------------------

  private database(): DatabaseSync {
    if (!this.open) throw new InvalidIntent('SqliteBackend is closed');
    return this.db;
  }

  /** Best-effort unwind. A failed ROLLBACK (no active transaction) must not mask the real error. */
  private rollback(): void {
    try {
      this.db.exec('ROLLBACK');
    } catch {
      // no active transaction — nothing to undo
    }
  }

  private nonceExists(nonce: string): boolean {
    return this.database().prepare('SELECT 1 FROM nonces WHERE nonce = ?').get(nonce) !== undefined;
  }

  private keyExists(key: string): boolean {
    return this.database().prepare('SELECT 1 FROM memo_keys WHERE key = ?').get(key) !== undefined;
  }

  private assertWalletExists(id: WalletId): void {
    const row = this.database().prepare('SELECT 1 FROM wallets WHERE id = ?').get(id);
    if (row === undefined) throw new UnknownWallet(id);
  }

  private balanceOf(id: WalletId): bigint {
    const row = this.database()
      .prepare('SELECT amount FROM balances WHERE wallet_id = ?')
      .get(id);
    if (row === undefined) throw new UnknownWallet(id);
    return readAmount(row, 'amount', 0n);
  }

  private setBalance(id: WalletId, amount: bigint): void {
    this.database()
      .prepare('UPDATE balances SET amount = ? WHERE wallet_id = ?')
      .run(encodeAmount(amount), id);
  }

  private chainTail(): ChainTail | null {
    const row = this.database()
      .prepare('SELECT seq, hash FROM transactions ORDER BY seq DESC LIMIT 1')
      .get();
    if (row === undefined) return null;
    return { seq: readSmallInt(row, 'seq'), hash: readText(row, 'hash') };
  }

  private toWallet(row: Record<string, SQLOutputValue>): Wallet {
    return {
      id: readText(row, 'id'),
      ownerId: readText(row, 'owner_id'),
      address: readText(row, 'address'),
      pubkey: readText(row, 'pubkey'),
      isEntity: readSmallInt(row, 'is_entity') !== 0,
      createdAt: readText(row, 'created_at'),
    };
  }

  private toTx(row: Record<string, SQLOutputValue>): Tx {
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
