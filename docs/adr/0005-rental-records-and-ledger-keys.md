# ADR 0005 — Rentals are ledger records; `memo.key` makes "once" a ledger property

Date: 2026-09-24
Status: Accepted

## Context

`ReturnVehicle` reconstructed what a rental cost by paging through the player's history and
`startsWith`-matching the memo's display text (`"bike — "`). Problems the review found:

- **Race.** Read history, decide the cap, write the refund: three awaits, no lock. Concurrent returns
  each saw the same outstanding amount and each refunded (3 of 3 settled in the regression test).
- **Fail-open.** A history scan that hit its 50-page cap returned `null` and the code carried on with
  *no* cap.
- **Text as data.** A vehicle named `"bike — x"` or any memo that happened to share the prefix counted.
- **Blind flat fee.** For vehicles with no per-minute rate the full flat fee was refunded whatever
  `minutesUnused` said.
- **Repricing.** The refund used today's config rate, not what the player paid.

## Options considered

1. **Engine-side rental table** surviving restart. The engine has no store of its own; this means
   adding rental persistence to every backend interface, written in a *second* operation next to the
   ledger append (not atomic with it).
2. **Keep scanning history**, but bound it and fail closed. Still O(history), still needs a lock for
   correctness, and still trusts memo text unless a structured field is added anyway.
3. **The ledger row is the record.** Extend the memo with structured fields; let a backend enforce
   "at most one tx per key" the same way it already enforces nonces.

## Decision: option 3

`Memo` gains two optional fields, both validated by `validateMemo` in every backend and covered by the
tx hash:

- `meta: Record<string,string>` — machine-read fields (max 8 entries, keys `[a-z][A-Za-z0-9_]{0,31}`,
  values ≤128 chars, no control characters). Engine logic reads these and never `detail`.
- `key: string` — at most one tx in the ledger may carry a given key. Enforced atomically inside the
  same write as the nonce (memory: a Set; sqlite: a `memo_keys` PRIMARY KEY in the same transaction).
  Violation is `DUPLICATE_KEY`.

Uses:

| Intent | `key` | `meta` |
|---|---|---|
| `RentVehicle` | — | `vehicle`, `minutes` |
| `ReturnVehicle` | `return:<rentalTxId>` | `rental`, `minutesUnused` |
| `OpenAccount` | `welcome:<ownerId>` | — |

`ReturnVehicle` now takes `rentalId` (the `txId` the `RentVehicle` result returned) and no `vehicle`.
The engine loads that tx and requires it to be a `RentVehicle` transfer from *this* player to the
rental entity with well-formed `meta.minutes`; anything else is `UNKNOWN_RENTAL` (same message for every
mismatch, so it does not reveal whether someone else's tx id exists). Then:

- `refund = paid * minutesUnused / minutesRented`, integer division, from the amount actually paid.
  Works for per-minute and flat-fee rentals alike and ignores later config changes. A refund that
  floors to 0 is `INVALID_AMOUNT`; `minutesUnused > minutesRented` is `INVALID_INTENT`.
- The refund carries `key = return:<rentalId>`, so the ledger itself refuses a second refund
  (`RENTAL_CLOSED`), across restarts and even across processes. No history scan exists any more, so
  there is nothing to truncate.
- If the rental entity cannot cover the refund the transfer fails with `INSUFFICIENT_FUNDS` and the
  rental stays open. The old code silently paid less than owed and, with the cap it kept, could mark
  the rental as settled.

Also decided here:

- **Serialization.** The engine runs intents one at a time behind an in-process mutex
  (`src/engine/mutex.ts`). Simplest thing that is correct. It does not protect two processes sharing a
  database; the backend-level guards (nonce, key, balance) still hold there, engine read-then-write
  logic does not. Run one engine per ledger.
- **Replay returns the original result.** A nonce that already settled, submitted again with the same
  intent type by the same initiating party, returns `ok: true` with the original `txId`/`hash` and
  `replayed: true` (`Backend.getTxByNonce`). Any other reuse is `DUPLICATE_NONCE`. The engine does not
  compare the rest of the request, so a retry with a *different amount* under the same nonce gets the
  original result back rather than an error; adapters must generate a fresh nonce per logical action.
- **No `ok:false` after settlement.** The post-write balance read cannot fail the intent any more: a
  failed read yields `newBalance: null` and is logged.
- **No internal detail to the adapter.** Only errors in a fixed allow-list of codes reach the adapter
  with their message. Everything else (unexpected errors, `LEDGER_CORRUPT`) is `INTERNAL` or
  `LEDGER_CORRUPT` with a generic message and a short `ref`; the cause goes to `onInternalError`
  (default `console.error`) tagged with the same `ref`.

## Consequences

- **Hash format.** `memo.key` and `memo.meta` lines are appended to the canonical payload only when
  present, so a memo without them hashes exactly as before and older ledgers still verify.
- **Adapter contract change.** `ReturnVehicle { rentalId, minutesUnused }` replaces
  `{ vehicle, minutesUnused }`; `IntentResult.newBalance` may be `null`; new codes `ACCOUNT_EXISTS`,
  `UNKNOWN_RENTAL`, `RENTAL_CLOSED`, `DUPLICATE_KEY` (internal only). No adapters exist yet, so the
  break is free now and expensive later.
- **Every backend must implement `key` uniqueness.** On-chain backends will need an on-chain or
  side-table registry, exactly as they already need one for nonces.
- One return per rental. Multiple partial returns of one rental are not supported.
- Rentals never expire and the engine does not know "now" relative to the rental: `minutesUnused`
  is still adapter-reported. It is bounded by what was rented and paid, but not verified against a clock.
