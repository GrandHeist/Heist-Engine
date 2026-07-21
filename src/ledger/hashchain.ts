// Shared hash-chain helpers. Every backend — memory, sqlite, postgres and the
// on-chain ones — must produce byte-identical payloads here, otherwise the same
// history hashed on two backends would not compare equal and the conformance
// suite would be meaningless. Nothing in this file may depend on a backend.

import { createHash } from 'node:crypto';

import type { Memo, Tx } from '../types.ts';
import { InvalidAmount } from '../errors.ts';

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

/** Canonical decimal string -> bigint. Rejects every non-canonical form. */
export function decodeAmount(text: string): bigint {
  if (typeof text !== 'string' || text.length === 0) {
    throw new InvalidAmount('Amount must be a non-empty canonical base-10 string');
  }
  if (!CANONICAL_AMOUNT.test(text)) {
    throw new InvalidAmount(
      `Amount ${JSON.stringify(text)} is not canonical base-10 ` +
        '(no leading zeros, "+", whitespace, separators or decimal points)',
    );
  }
  return BigInt(text);
}

/** JSON-escapes a string, or emits the bare token `null`. */
function field(value: string | null): string {
  return value === null ? 'null' : JSON.stringify(value);
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
