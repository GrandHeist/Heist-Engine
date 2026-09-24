// Unit tests for the shared hash-chain primitives. Everything here is pure —
// no backend, no clock, no randomness — so a failure points at the encoding
// itself rather than at storage.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { EngineError } from '../src/errors.ts';
import {
  GENESIS_HASH,
  canonicalTxPayload,
  computeHash,
  decodeAmount,
  encodeAmount,
  hashTx,
  verifyChain,
} from '../src/ledger/hashchain.ts';
import type { SignableTx } from '../src/ledger/hashchain.ts';
import type { Tx } from '../src/types.ts';

function rejectsAmount(text: string): void {
  assert.throws(
    () => decodeAmount(text),
    (error: unknown) => {
      assert.ok(error instanceof EngineError, `expected EngineError for ${JSON.stringify(text)}`);
      assert.equal(error.code, 'INVALID_AMOUNT');
      return true;
    },
    `decodeAmount(${JSON.stringify(text)}) should have been rejected`,
  );
}

/** Builds a chain of `count` linked txs with deterministic content. */
function buildChain(count: number): Tx[] {
  const txs: Tx[] = [];
  let prevHash = GENESIS_HASH;
  for (let seq = 0; seq < count; seq++) {
    const signable: SignableTx = {
      kind: 'transfer',
      from: 'wallet-a',
      to: 'wallet-b',
      amount: BigInt(seq + 1) * 10n,
      memo: { intent: 'Test', nonce: `n${seq}` },
      prevHash,
      seq,
      createdAt: `2026-07-21T00:00:0${seq}.000Z`,
    };
    const hash = computeHash(signable);
    txs.push({ id: `tx-${seq}`, ...signable, hash, signature: null });
    prevHash = hash;
  }
  return txs;
}

describe('encodeAmount / decodeAmount', () => {
  test('round-trips zero, positives, negatives and very large values', () => {
    const values: bigint[] = [
      0n,
      1n,
      -1n,
      500n,
      -500n,
      9007199254740991n, // Number.MAX_SAFE_INTEGER
      9007199254740993n, // MAX_SAFE_INTEGER + 2, unrepresentable as a double
      9007199254740993000n,
      -9007199254740993000n,
      (1n << 256n) + 7n,
      -((1n << 256n) + 7n),
    ];

    for (const value of values) {
      const encoded = encodeAmount(value);
      assert.equal(typeof encoded, 'string');
      assert.equal(decodeAmount(encoded), value, `round trip failed for ${value}`);
    }
  });

  test('encodeAmount emits canonical base-10 with no separators or exponent', () => {
    assert.equal(encodeAmount(0n), '0');
    assert.equal(encodeAmount(-0n), '0');
    assert.equal(encodeAmount(1234567890n), '1234567890');
    assert.equal(encodeAmount(-42n), '-42');
    assert.equal(encodeAmount(9007199254740993000n), '9007199254740993000');
  });

  test('non-canonical inputs are rejected', () => {
    for (const bad of [
      '',
      ' ',
      '05',
      '007',
      '-05',
      '+5',
      ' 5',
      '5 ',
      '5.0',
      '5.',
      '.5',
      '1e3',
      '1E3',
      '-0',
      '-00',
      '1_000',
      '1,000',
      '0x10',
      'five',
      '5n',
      'NaN',
      'Infinity',
    ]) {
      rejectsAmount(bad);
    }
  });

  test('decodeAmount accepts a bare zero but nothing dressed up as one', () => {
    assert.equal(decodeAmount('0'), 0n);
    rejectsAmount('-0');
    rejectsAmount('00');
    rejectsAmount('0.0');
  });
});

describe('canonicalTxPayload', () => {
  const base: SignableTx = {
    kind: 'transfer',
    from: 'wallet-a',
    to: 'wallet-b',
    amount: 9007199254740993000n,
    memo: { intent: 'Transfer', detail: 'rent', nonce: 'n-1' },
    prevHash: GENESIS_HASH,
    seq: 3,
    createdAt: '2026-07-21T10:00:00.000Z',
  };

  test('is deterministic for the same content', () => {
    assert.equal(canonicalTxPayload(base), canonicalTxPayload(base));
    assert.equal(computeHash(base), computeHash(base));
  });

  test('does not depend on the order the object literal was written in', () => {
    // Same fields, deliberately reversed construction order — and the memo keys
    // reversed too, since JSON.stringify over the memo would leak that order.
    const reversed: SignableTx = {
      createdAt: '2026-07-21T10:00:00.000Z',
      seq: 3,
      prevHash: GENESIS_HASH,
      memo: { nonce: 'n-1', detail: 'rent', intent: 'Transfer' },
      amount: 9007199254740993000n,
      to: 'wallet-b',
      from: 'wallet-a',
      kind: 'transfer',
    };

    assert.equal(canonicalTxPayload(reversed), canonicalTxPayload(base));
    assert.equal(computeHash(reversed), computeHash(base));
  });

  test('changing any signable field changes the payload and the hash', () => {
    const mutations: SignableTx[] = [
      { ...base, kind: 'mint' },
      { ...base, from: null },
      { ...base, to: null },
      { ...base, amount: base.amount + 1n },
      { ...base, memo: { intent: 'Fine', detail: 'rent', nonce: 'n-1' } },
      { ...base, memo: { intent: 'Transfer', detail: 'other', nonce: 'n-1' } },
      { ...base, memo: { intent: 'Transfer', detail: 'rent', nonce: 'n-2' } },
      { ...base, memo: { intent: 'Transfer', detail: 'rent' } },
      { ...base, prevHash: '1'.repeat(64) },
      { ...base, seq: 4 },
      { ...base, createdAt: '2026-07-21T10:00:00.001Z' },
    ];

    const reference = canonicalTxPayload(base);
    for (const mutated of mutations) {
      assert.notEqual(canonicalTxPayload(mutated), reference);
      assert.notEqual(computeHash(mutated), computeHash(base));
    }
  });

  test('hashTx is sha256 hex of the payload', () => {
    const hash = hashTx(canonicalTxPayload(base));
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(hash, computeHash(base));
  });

  test('an absent memo detail is distinguishable from an empty one', () => {
    const absent: SignableTx = { ...base, memo: { intent: 'Transfer', nonce: 'n-1' } };
    const empty: SignableTx = { ...base, memo: { intent: 'Transfer', detail: '', nonce: 'n-1' } };
    assert.notEqual(canonicalTxPayload(absent), canonicalTxPayload(empty));
  });
});

describe('canonicalTxPayload — memo key and meta', () => {
  const base: SignableTx = {
    kind: 'mint',
    from: null,
    to: 'w',
    amount: 5n,
    memo: { intent: 'Test', nonce: 'n' },
    prevHash: GENESIS_HASH,
    seq: 0,
    createdAt: '2026-07-21T00:00:00.000Z',
  };

  test('a memo without key or meta hashes exactly as before they existed', () => {
    assert.ok(!canonicalTxPayload(base).includes('memo.key'));
    assert.ok(!canonicalTxPayload(base).includes('memo.meta'));
  });

  test('key and meta change the hash', () => {
    const plain = computeHash(base);
    assert.notEqual(computeHash({ ...base, memo: { ...base.memo, key: 'k' } }), plain);
    assert.notEqual(computeHash({ ...base, memo: { ...base.memo, meta: { a: '1' } } }), plain);
    assert.notEqual(
      computeHash({ ...base, memo: { ...base.memo, meta: { a: '1' } } }),
      computeHash({ ...base, memo: { ...base.memo, meta: { a: '2' } } }),
    );
  });

  test('meta is canonical: insertion order does not matter', () => {
    const one = computeHash({ ...base, memo: { ...base.memo, meta: { a: '1', b: '2' } } });
    const two = computeHash({ ...base, memo: { ...base.memo, meta: { b: '2', a: '1' } } });
    assert.equal(one, two);
  });

  test('meta cannot smuggle a second line into the payload', () => {
    const payload = canonicalTxPayload({ ...base, memo: { ...base.memo, meta: { a: 'x\nkind="burn"' } } });
    assert.equal(payload.split('\n').filter((l) => l.startsWith('kind=')).length, 1);
  });
});

describe('verifyChain', () => {
  test('accepts an empty chain and a healthy chain', () => {
    assert.deepEqual(verifyChain([]), { ok: true, brokenAt: [] });

    const healthy = verifyChain(buildChain(5));
    assert.equal(healthy.ok, true);
    assert.deepEqual(healthy.brokenAt, []);
  });

  test('detects a tampered amount and reports the right index', () => {
    const txs = buildChain(5);
    const victim = txs[2];
    assert.ok(victim !== undefined);

    // Rewrite the amount but leave the stored hash alone — exactly what a
    // hand-edited database row looks like.
    txs[2] = { ...victim, amount: victim.amount + 1n };

    const result = verifyChain(txs);
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.brokenAt,
      [2],
      'only the tampered position should be reported — its hash is unchanged, so the links still match',
    );
  });

  test('detects a re-hashed tamper as a broken link in the successor', () => {
    const txs = buildChain(5);
    const victim = txs[2];
    assert.ok(victim !== undefined);

    // A more careful attacker recomputes the hash. The chain then breaks at the
    // NEXT tx, whose prevHash no longer matches.
    const signable: SignableTx = { ...victim, amount: victim.amount + 1n };
    txs[2] = { ...victim, amount: signable.amount, hash: computeHash(signable) };

    const result = verifyChain(txs);
    assert.equal(result.ok, false);
    assert.deepEqual(result.brokenAt, [3]);
  });

  test('detects a gap in seq', () => {
    const txs = buildChain(4).filter((tx) => tx.seq !== 1);
    const result = verifyChain(txs);
    assert.equal(result.ok, false);
    assert.ok(result.brokenAt.includes(2), 'the tx after the gap must be flagged');
  });

  test('sorts by seq before walking, so input order does not matter', () => {
    const txs = buildChain(5);
    const shuffled = [txs[3], txs[0], txs[4], txs[1], txs[2]].filter(
      (tx): tx is Tx => tx !== undefined,
    );
    assert.equal(shuffled.length, 5);
    assert.deepEqual(verifyChain(shuffled), { ok: true, brokenAt: [] });
  });
});
