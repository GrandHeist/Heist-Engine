# ADR 0001 — Swappable ledger backend, with memory and SQLite first

Date: 2026-07-21
Status: Accepted

## Context

`docs/SPEC.md` names Postgres as the default backend, with Solana and BNB Chain gated behind a config
flag pending platform approval. The swappability itself is the architectural bet: every backend sits
behind one `LedgerBackend` interface, and the game adapter cannot tell them apart.

Reality check on the build machine (2026-07-21): **Postgres is not installed, and neither is Docker.**
Homebrew is available, so installing it is possible but is a system-level change and a prerequisite
before any code could run.

Meanwhile Node 26 ships `node:sqlite` and ed25519 in `node:crypto` as built-ins, both verified working.

## Decision

Ship three off-chain backends behind the single interface, in this order:

1. **`MemoryBackend`** — for tests and CI. No I/O, no setup, fast.
2. **`SqliteBackend`** — real persistence via built-in `node:sqlite`. The default for local servers.
3. **`PostgresBackend`** — written against the same SQL shape, activated when `DATABASE_URL` is set.
   Requires the optional `pg` dependency. Untested until Postgres is installed.

Solana and BNB Chain remain unimplemented and gated, per the spec.

## Consequences

**Good**
- Nothing is blocked on a database install. The full economy runs end to end today.
- Having three backends from day one *proves* the swappable claim instead of asserting it. A single
  backend behind an interface is an untested abstraction.
- Zero required runtime dependencies — `node:sqlite` and `node:crypto` are built in. `pg` is optional.
- Small servers can run SQLite and never touch Postgres at all, which is a better default for the
  "drop it into your server" use case than requiring a database install.

**Bad**
- `PostgresBackend` ships unverified until someone installs Postgres. It must be treated as unproven
  and must not be presented as tested.
- Three implementations of one interface means three places every future ledger change must land.
  The shared conformance test suite exists to make that cost visible rather than silent.
- `node:sqlite` is comparatively new; behaviour may shift across Node releases.

**Reversal cost**

Low. The interface is the contract; dropping a backend is deleting a file and a config branch.
