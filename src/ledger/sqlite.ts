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
  encodeAmount,
  hashTx,
  verifyChain,
} from './hashchain.ts';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wallets (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT UNIQUE,
  address    TEXT,
  pubkey     TEXT,
  is_entity  INTEGER,
  created_at TEXT
);

-- amount is TEXT. See ADR 0002. Never SUM() it, never ORDER BY it.
CREATE TABLE IF NOT EXISTS transactions (
  id          TEXT PRIMARY KEY,
  seq         INTEGER UNIQUE,
  kind        TEXT,
  from_wallet TEXT NULL,
  to_wallet   TEXT NULL,
  amount      TEXT,
  memo        TEXT,
  prev_hash   TEXT,
  hash        TEXT,
  signature   TEXT NULL,
  created_at  TEXT
);

CREATE TABLE IF NOT EXISTS balances (
  wallet_id TEXT PRIMARY KEY,
  amount    TEXT
);

CREATE TABLE IF NOT EXISTS nonces (
  nonce      TEXT PRIMARY KEY,
  tx_id      TEXT,
  created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_transactions_from_wallet ON transactions(from_wallet);
CREATE INDEX IF NOT EXISTS idx_transactions_to_wallet   ON transactions(to_wallet);
CREATE INDEX IF NOT EXISTS idx_transactions_seq         ON transactions(seq);
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

function isTxKind(value: string): value is TxKind {
  return value === 'transfer' || value === 'mint' || value === 'burn';
}

// --- memo serialization -----------------------------------------------------
// Fixed key order so the stored form is stable, and absent keys are omitted rather than written
// as null — `exactOptionalPropertyTypes` means `{ detail: undefined }` is not a valid Memo.

function encodeMemo(memo: Memo): string {
  const out: Record<string, string> = { intent: memo.intent };
  if (memo.detail !== undefined) out['detail'] = memo.detail;
  if (memo.nonce !== undefined) out['nonce'] = memo.nonce;
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
    db.exec('PRAGMA journal_mode = WAL');
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
    if (ownerId.length === 0) throw new InvalidIntent('ownerId must not be empty');

    const existing = await this.getWalletByOwner(ownerId);
    if (existing !== null) return existing;

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
      db.prepare(
        `INSERT INTO wallets (id, owner_id, address, pubkey, is_entity, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
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
    return decodeAmount(readText(row, 'amount'));
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
    if (amount <= 0n) {
      throw new InvalidAmount(`Amount must be positive, got ${amount} HD`);
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      const nonce = memo.nonce;
      if (nonce !== undefined && this.nonceExists(nonce)) {
        throw new DuplicateNonce(nonce);
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

  // --- integrity ------------------------------------------------------------

  /**
   * Walks the chain in seq order, recomputes every hash and every prev_hash link, and independently
   * folds the whole history into per-wallet totals to compare against the maintained `balances`
   * table. ADR 0002 accepts that the maintained balance can drift; this is what detects it.
   */
  async verifyIntegrity(): Promise<IntegrityReport> {
    const db = this.database();
    const txs = db
      .prepare('SELECT * FROM transactions ORDER BY seq ASC')
      .all()
      .map((row) => this.toTx(row));

    // Hash and linkage checks live in hashchain.ts so every backend reports identical breaks.
    const { brokenAt } = verifyChain(txs);

    const folded = new Map<WalletId, bigint>();

    // Every known wallet starts at zero, so a wallet with a stored balance but no history is
    // still checked.
    for (const walletRow of db.prepare('SELECT id FROM wallets').all()) {
      folded.set(readText(walletRow, 'id'), 0n);
    }

    for (const tx of txs) {
      if (tx.from !== null) folded.set(tx.from, (folded.get(tx.from) ?? 0n) - tx.amount);
      if (tx.to !== null) folded.set(tx.to, (folded.get(tx.to) ?? 0n) + tx.amount);
    }

    const stored = new Map<WalletId, bigint>();
    for (const row of db.prepare('SELECT wallet_id, amount FROM balances').all()) {
      stored.set(readText(row, 'wallet_id'), decodeAmount(readText(row, 'amount')));
    }

    const balanceMismatches: WalletId[] = [];
    for (const walletId of new Set([...folded.keys(), ...stored.keys()])) {
      if ((folded.get(walletId) ?? 0n) !== (stored.get(walletId) ?? 0n)) {
        balanceMismatches.push(walletId);
      }
    }
    balanceMismatches.sort();

    return {
      ok: brokenAt.length === 0 && balanceMismatches.length === 0,
      checked: txs.length,
      brokenAt,
      balanceMismatches,
    };
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

  private assertWalletExists(id: WalletId): void {
    const row = this.database().prepare('SELECT 1 FROM wallets WHERE id = ?').get(id);
    if (row === undefined) throw new UnknownWallet(id);
  }

  private balanceOf(id: WalletId): bigint {
    const row = this.database()
      .prepare('SELECT amount FROM balances WHERE wallet_id = ?')
      .get(id);
    if (row === undefined) throw new UnknownWallet(id);
    return decodeAmount(readText(row, 'amount'));
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
      amount: decodeAmount(readText(row, 'amount')),
      memo: decodeMemo(readText(row, 'memo')),
      prevHash: readText(row, 'prev_hash'),
      hash: readText(row, 'hash'),
      signature: readNullableText(row, 'signature'),
      createdAt: readText(row, 'created_at'),
      seq: readSmallInt(row, 'seq'),
    };
  }
}
