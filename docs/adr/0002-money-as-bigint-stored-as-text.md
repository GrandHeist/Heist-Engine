# ADR 0002 — Money is bigint in memory, decimal TEXT on disk

Date: 2026-07-21
Status: Accepted

## Context

`docs/SPEC.md` types ledger amounts as `bigint`. That part is not negotiable: floats in a money path
produce balances that do not reconcile, and this ledger is hash-chained specifically so it can be
audited.

While probing `node:sqlite` on Node 26, a concrete failure surfaced:

```js
db.prepare('SELECT n FROM t').get()
// RangeError: Value is too large to be represented as a JavaScript number: 9007199254740993
```

`setReadBigInts(true)` fixes it — but it is set **per prepared statement, not per connection**. A newly
prepared statement silently reverts to number mode and throws on any value past `2^53`. Every future
query would have to remember the flag, and forgetting it is a runtime crash on large balances rather
than a compile error.

An INTEGER column is also capped at signed 64-bit, which a long-lived economy with a minting treasury
could plausibly approach.

## Decision

- **In memory:** amounts are `bigint`. No `number`, no float, anywhere in the money path.
- **On disk:** amounts are stored as **TEXT**, canonical base-10, no separators, optional leading `-`.
- Conversion happens only at the backend boundary, in one helper per backend.
- Balances are maintained in a `balances` table, written inside the same transaction as the ledger
  append, rather than derived with SQL `SUM()`.

## Consequences

**Good**
- Unbounded precision. No 64-bit ceiling, no `2^53` cliff, no per-statement flag to forget.
- Identical representation across SQLite and Postgres, so the conformance suite is genuinely shared.
- The failure mode moves from "silent corruption or a crash under load" to "impossible by construction".

**Bad**
- No SQL-side arithmetic. `SUM(amount)` is unavailable, which is why balances are maintained rather
  than derived.
- The maintained balance can in principle drift from the folded history. `verifyIntegrity()` exists to
  detect exactly that and reports mismatches per wallet.
- Text comparison is not numeric ordering — never `ORDER BY amount`; order by `seq`.

**Reversal cost**

Moderate. Changing the storage type means a migration over the whole `transactions` table. Cheap now
while the ledger is empty; expensive once a real server has history.
