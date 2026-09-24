// Shared hash-chain helpers. Every backend — memory, sqlite, postgres and the
// on-chain ones — must produce byte-identical payloads here, otherwise the same
// history hashed on two backends would not compare equal and the conformance
// suite would be meaningless. Nothing in this file may depend on a backend.

import { createHash } from 'node:crypto';

import type { Memo, Tx } from '../types.ts';
import { InvalidAmount, InvalidIntent } from '../errors.ts';

/** prevHash of the first tx in a chain. */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * The signable content of a transaction: everything except the fields that are
 * derived from it (`id`, `hash`, `signature`).
 */
export type SignableTx = Pick<
  Tx,
  'kind' | 'from' | 'to' | 'amount' | 'memo' | 'prevHash' | 'seq' | 'createdAt'
>;

// Canonical base-10: optional leading '-', then '0' or a digit string with no
// leading zero. No '+', no whitespace, no separators, no decimal point, no
// exponent, and no '-0'.
const CANONICAL_AMOUNT = /^(0|-?[1-9][0-9]*)$/;

/** bigint -> canonical decimal string, for storage and for hashing. */
export function encodeAmount(value: bigint): string {
  return value.toString(10);
}

/**
 * Canonical decimal string -> bigint. Rejects every non-canonical form.
 *
 * The canonical grammar allows a leading '-' (the codec is general), so a caller that knows the
 * value's domain MUST pass `min`: 1n for a tx amount, 0n for a balance. Without it a stored
 * "-5" decodes happily and turns a debit into a credit downstream.
 */
export function decodeAmount(text: string, min?: bigint): bigint {
  if (typeof text !== 'string' || text.length === 0) {
    throw new InvalidAmount('Amount must be a non-empty canonical base-10 string');
  }
  if (!CANONICAL_AMOUNT.test(text)) {
    throw new InvalidAmount(
      `Amount ${JSON.stringify(text)} is not canonical base-10 ` +
        '(no leading zeros, "+", whitespace, separators or decimal points)',
    );
  }
  const value = BigInt(text);
  if (min !== undefined && value < min) {
    throw new InvalidAmount(`Amount ${text} is below the minimum ${min.toString(10)}`);
  }
  return value;
}

// --- memo validation ---------------------------------------------------------
// Every backend runs this before writing, so the stored memo is bounded and free of control
// characters (log/terminal injection) no matter which adapter or engine path produced it.

export const MAX_MEMO_INTENT = 64;
export const MAX_MEMO_DETAIL = 512;
export const MAX_MEMO_NONCE = 128;
export const MAX_MEMO_KEY = 200;
export const MAX_MEMO_META_ENTRIES = 8;
export const MAX_MEMO_META_VALUE = 128;

export const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const META_KEY = /^[a-z][A-Za-z0-9_]{0,31}$/;

function checkText(value: unknown, field: string, max: number, allowEmpty: boolean): void {
  if (typeof value !== 'string') throw new InvalidIntent(`${field} must be a string`);
  if (value.length === 0 && !allowEmpty) throw new InvalidIntent(`${field} must not be empty`);
  if (value.length > max) throw new InvalidIntent(`${field} must be at most ${max} characters`);
  if (CONTROL_CHARS.test(value)) throw new InvalidIntent(`${field} must not contain control characters`);
  // A lone UTF-16 surrogate is stored by sqlite as U+FFFD, so two different strings would collide there.
  if (!value.isWellFormed()) throw new InvalidIntent(`${field} must be well-formed Unicode`);
}

export function validateMemo(memo: unknown): asserts memo is Memo {
  if (typeof memo !== 'object' || memo === null || Array.isArray(memo)) {
    throw new InvalidIntent('memo must be an object');
  }
  const m = memo as Record<string, unknown>;
  checkText(m['intent'], 'memo.intent', MAX_MEMO_INTENT, false);
  if (m['detail'] !== undefined) checkText(m['detail'], 'memo.detail', MAX_MEMO_DETAIL, true);
  if (m['nonce'] !== undefined) checkText(m['nonce'], 'memo.nonce', MAX_MEMO_NONCE, false);
  if (m['key'] !== undefined) checkText(m['key'], 'memo.key', MAX_MEMO_KEY, false);
  const meta = m['meta'];
  if (meta !== undefined) {
    if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
      throw new InvalidIntent('memo.meta must be an object of string values');
    }
    const entries = Object.entries(meta);
    if (entries.length > MAX_MEMO_META_ENTRIES) {
      throw new InvalidIntent(`memo.meta may hold at most ${MAX_MEMO_META_ENTRIES} entries`);
    }
    for (const [k, v] of entries) {
      if (!META_KEY.test(k)) throw new InvalidIntent(`memo.meta key ${JSON.stringify(k)} is not allowed`);
      checkText(v, `memo.meta.${k}`, MAX_MEMO_META_VALUE, true);
    }
  }
}

/** Defensive copy: only known fields, so nothing extra can ride along into storage. */
export function cloneMemo(memo: Memo): Memo {
  const out: Memo = { intent: memo.intent };
  if (memo.detail !== undefined) out.detail = memo.detail;
  if (memo.nonce !== undefined) out.nonce = memo.nonce;
  if (memo.key !== undefined) out.key = memo.key;
  if (memo.meta !== undefined) out.meta = { ...memo.meta };
  return out;
}

/** JSON-escapes a string, or emits the bare token `null`. */
function field(value: string | null): string {
  return value === null ? 'null' : JSON.stringify(value);
}

/** Entries sorted by key, as a JSON array of pairs: no dependence on object key order. */
function canonicalMeta(meta: Record<string, string>): string {
  return JSON.stringify(Object.keys(meta).sort().map((k) => [k, meta[k]]));
}

/**
 * Deterministic serialization of a transaction's signable content.
 *
 * The key order below is the wire format. It is written out explicitly, one
 * line per field, and never produced by `JSON.stringify` over an object —
 * object key order is an implementation detail we refuse to depend on.
 */
export function canonicalTxPayload(tx: SignableTx): string {
  const memo: Memo = tx.memo;
  return [
    `kind=${field(tx.kind)}`,
    `from=${field(tx.from)}`,
    `to=${field(tx.to)}`,
    `amount=${field(encodeAmount(tx.amount))}`,
    `memo.intent=${field(memo.intent)}`,
    `memo.detail=${field(memo.detail ?? null)}`,
    `memo.nonce=${field(memo.nonce ?? null)}`,
    // key and meta are appended only when present, so a memo without them hashes exactly as it
    // did before they existed and older ledgers still verify.
    ...(memo.key === undefined ? [] : [`memo.key=${field(memo.key)}`]),
    ...(memo.meta === undefined ? [] : [`memo.meta=${field(canonicalMeta(memo.meta))}`]),
    `prevHash=${field(tx.prevHash)}`,
    `seq=${field(String(tx.seq))}`,
    `createdAt=${field(tx.createdAt)}`,
  ].join('\n');
}

/** sha256 of a canonical payload, lowercase hex. */
export function hashTx(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/** Convenience: canonicalize and hash in one step. */
export function computeHash(tx: SignableTx): string {
  return hashTx(canonicalTxPayload(tx));
}

/** The head of the chain: enough to notice later that the tail was cut off or rewritten. */
export interface Checkpoint {
  seq: number;
  hash: string;
}

/** A row that may hash correctly and still break a ledger rule. `seq` is null when not row-specific. */
export interface Violation {
  seq: number | null;
  reason: string;
}

export type CheckpointStatus = 'none' | 'ok' | 'truncated' | 'rewritten';

/** The checkpoint of a chain, or null when it is empty. */
export function headOf(txs: readonly Tx[]): Checkpoint | null {
  let head: Tx | undefined;
  for (const tx of txs) if (head === undefined || tx.seq > head.seq) head = tx;
  return head === undefined ? null : { seq: head.seq, hash: head.hash };
}

/**
 * Does this chain still agree with a checkpoint taken earlier? A chain shorter than the
 * checkpoint was truncated; a different hash at the checkpoint's seq was rewritten. Neither is
 * visible to the hash chain alone: a valid chain can be cut at any point and still verify.
 */
export function compareCheckpoint(txs: readonly Tx[], checkpoint: Checkpoint): CheckpointStatus {
  const at = txs.find((tx) => tx.seq === checkpoint.seq);
  if (at === undefined) return 'truncated';
  return at.hash === checkpoint.hash ? 'ok' : 'rewritten';
}

/**
 * Ledger rules a correctly hashed row can still break (someone with database access can
 * recompute hashes): amounts positive, mint has no source, burn no destination, transfer both
 * and distinct, every wallet known, memo well-formed, no reused nonce/key, and no wallet ever
 * spending more than it held. `wallets` is the set of wallet ids that exist.
 */
export function verifyStructure(txs: readonly Tx[], wallets: ReadonlySet<string>): Violation[] {
  const ordered = [...txs].sort((a, b) => a.seq - b.seq);
  const violations: Violation[] = [];
  const balances = new Map<string, bigint>();
  const nonces = new Set<string>();
  const keys = new Set<string>();

  for (const tx of ordered) {
    const bad = (reason: string): void => {
      violations.push({ seq: tx.seq, reason });
    };

    if (typeof tx.amount !== 'bigint' || tx.amount <= 0n) bad('amount must be a positive bigint');
    if (tx.kind === 'mint') {
      if (tx.from !== null) bad('a mint must have no source wallet');
      if (tx.to === null) bad('a mint must have a destination wallet');
    } else if (tx.kind === 'burn') {
      if (tx.from === null) bad('a burn must have a source wallet');
      if (tx.to !== null) bad('a burn must have no destination wallet');
    } else if (tx.kind === 'transfer') {
      if (tx.from === null || tx.to === null) bad('a transfer needs both wallets');
      else if (tx.from === tx.to) bad('a transfer cannot be to the same wallet');
    } else {
      bad(`unknown kind ${JSON.stringify(String(tx.kind))}`);
    }
    for (const id of [tx.from, tx.to]) {
      if (id !== null && !wallets.has(id)) bad(`references unknown wallet ${id}`);
    }
    try {
      validateMemo(tx.memo);
    } catch (error) {
      bad(`memo invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    const nonce = tx.memo?.nonce;
    if (nonce !== undefined) {
      if (nonces.has(nonce)) bad(`nonce ${JSON.stringify(nonce)} reused`);
      nonces.add(nonce);
    }
    const key = tx.memo?.key;
    if (key !== undefined) {
      if (keys.has(key)) bad(`key ${JSON.stringify(key)} reused`);
      keys.add(key);
    }

    if (typeof tx.amount === 'bigint') {
      if (tx.from !== null) {
        const held = balances.get(tx.from) ?? 0n;
        if (held < tx.amount) bad(`wallet ${tx.from} spends ${tx.amount} but held ${held}`);
        balances.set(tx.from, held - tx.amount);
      }
      if (tx.to !== null) balances.set(tx.to, (balances.get(tx.to) ?? 0n) + tx.amount);
    }
  }

  for (const [id, balance] of balances) {
    if (balance < 0n) violations.push({ seq: null, reason: `wallet ${id} ends with a negative balance` });
  }
  return violations;
}

/**
 * Walk a chain in seq order, recompute every hash and check prevHash linkage.
 * `brokenAt` lists the seq numbers that failed, in ascending order.
 */
export function verifyChain(txs: Tx[]): { ok: boolean; brokenAt: number[] } {
  const ordered = [...txs].sort((a, b) => a.seq - b.seq);
  const brokenAt: number[] = [];

  let expectedSeq = 0;
  let expectedPrev = GENESIS_HASH;

  for (const tx of ordered) {
    let broken = false;

    // Positions must be contiguous from 0: a gap or a duplicate is a break.
    if (tx.seq !== expectedSeq) broken = true;
    if (tx.prevHash !== expectedPrev) broken = true;
    if (computeHash(tx) !== tx.hash) broken = true;

    if (broken) brokenAt.push(tx.seq);

    expectedSeq = tx.seq + 1;
    expectedPrev = tx.hash;
  }

  return { ok: brokenAt.length === 0, brokenAt };
}
