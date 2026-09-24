# ADR 0006 — Store hardening, structural verification and head checkpoints

Date: 2026-09-24
Status: Accepted

## Context

The hash chain proves *internal consistency*, and only that. A review found the store and verifier
trusting far more than that:

- SQLite tables had no `NOT NULL` or `CHECK`, and nothing stopped a stray `UPDATE`/`DELETE` on
  `transactions`.
- `verifyIntegrity` checked hashes and one balance fold. A row with a mint that names a source wallet,
  a zero or negative amount, or a wallet spending more than it held would verify if its hash was
  recomputed. A negative stored balance was only caught if it happened to differ from the fold.
- A hash chain can be cut at any point and still verify: deleting the last N rows leaves a valid,
  shorter chain. Nothing could notice.
- `decodeAmount` accepts a leading `-` (the codec is general), so a stored `-50` decoded as a tx
  amount and turned a debit into a credit.
- WAL mode's default `synchronous=NORMAL` can lose the newest commits on power loss; there was no
  `busy_timeout`, so a second writer failed instantly.
- `verifyIntegrity` *threw* on any undecodable row instead of reporting it.

## Decisions

### Schema (`SqliteBackend`)

- Every column `NOT NULL` except the two that are meaningfully null (`from_wallet`/`to_wallet` per kind,
  `signature`). `CHECK`s: amount is canonical positive base-10 text; `kind` is one of three; the
  kind/from/to combination is valid (mint: no source; burn: no destination; transfer: both, distinct);
  hashes are 64 chars; `seq >= 0`; balances are canonical non-negative text. Foreign keys from
  transactions, balances, nonces and memo_keys to their targets.
- `BEFORE UPDATE` / `BEFORE DELETE` triggers that `RAISE(ABORT)` on `transactions`, `nonces`,
  `memo_keys` and `wallets`. Only `balances` is ever updated.
- `PRAGMA synchronous = FULL` on file databases, `busy_timeout = 5000`.

### Verification (every backend, via `hashchain.ts`)

`verifyIntegrity(expected?)` runs in one read transaction and reports, without throwing on odd stored
types (BLOB keys, wrong column types) in the tables it reads:

1. hash and `prevHash` linkage (`brokenAt`);
2. `violations`: rules a *re-hashed* row can still break — amount > 0, mint/burn/transfer shape, known
   wallets, valid memo, no reused nonce or key, no wallet spending more than it held, no negative end
   balance (`verifyStructure`);
3. `balanceMismatches`: the maintained balances against an independent fold, plus any negative or
   undecodable stored balance;
4. SQLite only: the replay-guard tables (`nonces`, `memo_keys`) must match the ledger row for row. A
   deleted nonce row silently re-opens a replay, so it is a violation;
5. `checkpoint`: `'none' | 'ok' | 'truncated' | 'rewritten'`, when the caller passes a `Checkpoint`.

`backend.checkpoint()` returns the head as `{ seq, hash }`. A ledger shorter than the checkpoint is
`truncated`; a different hash at the checkpoint's `seq` is `rewritten`; a longer chain that still
contains it is `ok`.

`decodeAmount(text, min?)`: callers that know the domain pass `1n` (tx amount) or `0n` (balance). The
SQLite reader does, and a violating row surfaces as corruption.

The sim verifies at startup and refuses to serve a failing ledger. For a sqlite database it keeps the
latest head in `<db>.head` and checks against it on every start.

## What this does and does not protect against

| Attack / fault | Caught by |
|---|---|
| Stray `UPDATE`/`DELETE`, bad amounts, malformed rows via this schema | triggers + `CHECK`s |
| Edited row, hash not recomputed | hash chain |
| Edited row, chain re-hashed, balances not fixed | balance fold |
| Chain re-hashed and balances fixed, but the edit breaks a rule (overdraft, mint with source) | `verifyStructure` |
| Deleted nonce/key row (replay re-opened) | replay-guard check |
| Tail deleted, balances left alone | balance fold |
| **Tail deleted (or history rewritten), everything made self-consistent** | **only a checkpoint stored outside the ledger** |
| **Forged rows appended to the end, valid hashes, balances updated** | **nothing yet** (needs signatures; ADR 0003) |
| **Edits to the `wallets` table (swap `owner_id`s, rewrite `pubkey`/`address`) or to a tx `id` together with its `nonces` row** | **nothing yet.** The hash covers a row's payload, not its `id`, and nothing hashes the wallet registry. Needs signed wallet-registration rows or an owner manifest (ADR 0003) |

Two honest limits:

- **The checkpoint is only as good as where it lives.** The sim's `<db>.head` sits next to the
  database, so it catches accidents and careless edits, not someone who can write both files. Copy the
  head somewhere the ledger's writer cannot reach (another host, an append-only log, a periodic public
  post) to get the real guarantee.
- **The triggers are speed bumps.** Anyone with write access to the file can `DROP TRIGGER`. The tests do
  exactly that and show `verifyIntegrity` still catches it.
- Constraints and triggers apply to tables created by this schema. `CREATE TABLE IF NOT EXISTS` leaves
  an existing (pre-hardening) database's tables alone; the triggers do reach it. There is no released
  data, so no migration is provided. Throw away old dev databases.

## Consequences

- `IntegrityReport` gains `violations`, `head`, `checkpoint`; `LedgerBackend` gains `checkpoint()`.
- Any future backend must return the same report shape (Postgres can use the same SQL; on-chain
  backends can derive the checkpoint from block height and hash).
- Verification is O(ledger). Fine for a friends server; run it at start and on a schedule, not per intent.
