# ADR 0001 — Swappable ledger backend, with memory and SQLite first

Date: 2026-07-21
Status: Accepted — **amended 2026-09-24**: only two of the three backends were built; the Postgres
sections below describe intent, not code. **Amended 2026-10-03**: BNB Chain dropped from scope —
Solana only, for now. **Amended 2026-10-03 (later same day): PostgresBackend is now built**, closing
the gap the first amendment opened. Corrections are marked *Amended*.

## Context

`docs/SPEC.md` names Postgres as the default backend, with Solana gated behind a config
flag pending platform approval. The swappability itself is the architectural bet: every backend sits
behind one `LedgerBackend` interface, and the game adapter cannot tell them apart.

Reality check on the build machine (2026-07-21): **Postgres is not installed, and neither is Docker.**
Homebrew is available, so installing it is possible but is a system-level change and a prerequisite
before any code could run.

Meanwhile Node 26 ships `node:sqlite` and ed25519 in `node:crypto` as built-ins, both verified working.
(*Amended:* `package.json` requires Node >= 24, where `node:sqlite` is also available.)

## Decision

Put every ledger behind the single interface. The planned order was three off-chain backends:

1. **`MemoryBackend`** — for tests and CI. No I/O, no setup, fast. **Built.**
2. **`SqliteBackend`** — real persistence via built-in `node:sqlite`. The default for local servers. **Built.**
3. **`PostgresBackend`** — to be written against the same SQL shape, activated when `DATABASE_URL` is set,
   using the optional `pg` dependency. ***Amended 2026-09-24: not written.*** No file, no test, no `pg`
   import exists. `postgres` is a valid backend *name* in config and in `BackendName`, and `createBackend`
   refuses it with `BACKEND_UNAVAILABLE`. The `optionalDependencies.pg` entry in `package.json` is
   unused and can be dropped until this is built.
   ***Amended 2026-10-03: built*** — `src/ledger/postgres.ts`, passing the same conformance suite as
   the other two. One deviation from this ADR's original plan: activated via `config.databaseUrl` (a
   config field, validated the same way `dbPath` is for sqlite), not a `DATABASE_URL` environment
   variable — keeps every backend's connection info in the same place instead of sqlite reading config
   and postgres reading the environment. `pg` stays an optionalDependency, imported lazily inside
   `init()` so memory/sqlite-only users are never made to install it. The one real correctness wrinkle
   `node:sqlite`'s synchronous API doesn't have: see the file's header comment on why its write paths
   are wrapped in the engine's `Mutex`.

Solana remains unimplemented and gated, per the spec. Custody refuses to construct for
it (`ONCHAIN_CUSTODY_BLOCKED`); enabling it takes an ADR and human sign-off, not a config change.
*Amended 2026-10-03:* BNB Chain was dropped from scope entirely, not just deprioritised — it is no
longer a valid `BackendName`, config value, or `ONCHAIN_BACKENDS` entry. Solana only, for now.

## Consequences

**Good**
- Nothing was ever blocked on a database install. The full economy ran end to end on memory/sqlite
  alone the whole time Postgres was unbuilt, and still does for anyone who wants it.
- Having three backends running the same conformance suite (and the whole engine suite) *proves* the
  swappable claim instead of asserting it. A single backend behind an interface is an untested
  abstraction. *Amended 2026-10-03:* now proven for all three real backends.
- Zero required runtime dependencies — `node:sqlite` and `node:crypto` are built in. `pg` is optional,
  and now actually exercised rather than sitting unused.
- Small servers can run SQLite and never touch Postgres at all, which is still the better default for
  the "drop it into your server" use case; Postgres is there for whoever outgrows that.

**Bad**
- Each implementation of the interface is another place every ledger change must land (now three:
  memory, sqlite, postgres). The shared conformance test suite exists to make that cost visible rather
  than silent, and it just grew by a third.
- `node:sqlite` is comparatively new; behaviour may shift across Node releases.
- Postgres's write paths need their own `Mutex` to get the atomicity sqlite gets for free from being
  synchronous (see `src/ledger/postgres.ts`'s header comment) — a real, not cosmetic, difference between
  the two that anyone adding a fourth backend needs to think about on its own terms, not copy blindly
  from whichever of the existing two looks most similar.

**Reversal cost**

Low. The interface is the contract; dropping a backend is deleting a file and a config branch.
