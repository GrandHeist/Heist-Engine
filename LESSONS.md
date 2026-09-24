# Heist Engine — Lessons

Project-specific learnings. Written by `/retro`, editable by hand.
Cross-project patterns live in `~/project-workspace/LESSONS.md`.

## Preferences
<!-- What the user liked in this project. -->
- **Docs say what the code does.** The overnight hardening job (2026-09-24) explicitly asked for the README,
  ADR 0001 and SPEC to be corrected rather than left aspirational. Tag every claim built / planned, and
  grep the code before writing "ships", "signed" or "config flip".
- **Overnight jobs:** tests first (or with the fix), `npm run check` green, one small commit per step,
  `NOTES.md` (git-ignored) with what changed / what's left / anything risky, and a list of disputed findings.
  Never push, never touch anything outside the worktree.

## Rejected
<!-- Approaches turned down here, and why. -->
- **Welcome grant as a transfer out of `treasury`.** Bounds the grant by the treasury balance, so a fresh
  world can't open accounts until someone funds it. It stays a mint attributed to the treasury (ADR 0004).
- **Mint-into-treasury-then-transfer (two rows).** Not atomic on the current interface; a crash between
  rows inflates the treasury on retry.
- **Reconstructing rentals by scanning history and matching memo text (ADR 0005).** Racy, fail-open when
  the page cap hit, and it trusted display text. Replaced by a structured rental record and a ledger key.
- **Required `authorizedBy` on `Payout` and `Fine`.** API churn that adds no security while the adapter is
  unauthenticated. Adapter capabilities (ADR 0003) are the real fix.
- **Pessimistic reserve-then-commit signing** (hold the chain head across the signer call): blocks every
  write for a network round trip. If async signing is ever needed, use the optimistic (head-CAS) variant.

## Mistakes to not repeat
<!-- What broke, root cause, what to do instead. -->
- **Docs claimed things that did not exist.** README said "Postgres ships today", the SPEC said every tx is
  signed and that on-chain modes are "a config flip", ADR 0001 described a `PostgresBackend`. None existed:
  `signature` was always null and `custody.sign` was never called. Root cause: docs written from the design.
  Before claiming a capability, `grep` for the code that does it.
- **Idempotency that lived only in the nonce.** `OpenAccount` minted the grant on every call because each
  call had a fresh nonce. A fact that must happen once (a grant, a refund) needs its own ledger-enforced key
  (`Memo.key`), not "the adapter won't retry".
- **Read-then-write across `await`s.** Every backend method is async, so even the in-memory backend
  interleaves: three concurrent `ReturnVehicle` intents all refunded. Serialize in the engine (mutex) and
  keep the atomic guard in the backend; the test must fail before the fix (it did: 3 of 3 settled).
- **Returning `ok:false` after money moved.** A post-write balance read that threw turned a settled transfer
  into a failure. Reads after settlement must not throw (`newBalance: null`).
- **Leaking `cause.message` to the adapter.** Raw SQLite errors (`UNIQUE constraint failed: wallets.owner_id`)
  were reaching callers. Allow-list the codes whose messages are meant for players; log the rest with a ref.
- **Entity ids and player ids shared one namespace** and nothing checked `isEntity`, so `Transfer` to
  `treasury` or `OpenAccount` as `hospital` worked. Reserve entity ids (case-insensitively) at the engine.
- **Believing a hash chain proves more than it does.** It survives truncation and re-hashed rewrites. Only
  an external checkpoint catches those, and only signatures stop forged appends (ADR 0006).
- **When a tamper test fails, read the report before touching the verifier.** Twice the test helper was
  wrong (it did not persist `from`/`to`, and left an orphaned wallet's balance) and the verifier was right.

## Stack notes
<!-- Versions, config, and commands that actually work in this project. -->
- Node 26.9 is installed; `engines` says `>=24`. No build step: `node --test` and `node src/cli/sim.ts` run
  TypeScript directly (type stripping), so `erasableSyntaxOnly` applies: no enums, no parameter properties.
- **Gate:** `npm run check` (= `tsc --noEmit` + `node --test 'tests/**/*.test.ts'`). Shared test code must NOT
  be named `*.test.ts` or the runner picks it up on its own (`tests/engine.suite.ts` is exported and run
  over each backend by `tests/engine.test.ts`).
- **Sim:** `npm run sim` (memory) or `npm run sim -- --backend=sqlite --db=./heist.sqlite`; `--config=` to load
  another config. `seed` funds the payout entities. Use `fund <entity> <amt>` for admin funding.
  With sqlite it writes a `<db>.head` checkpoint file next to the database (git-ignored).
- **`node:sqlite`:** `DatabaseSync` is synchronous, so you cannot `await` inside a transaction and a signer
  called from a write must be sync. Foreign keys are ON by default on a new connection. WAL's default
  `synchronous` is NORMAL; set FULL. `PRAGMA ignore_check_constraints = ON` on a second connection lets a
  test insert rows the schema would refuse. Anyone with file access can `DROP TRIGGER`; the tests do.
- Amounts are TEXT in SQLite (ADR 0002), so CHECKs use `GLOB`, and `ORDER BY amount` is wrong.
- `exactOptionalPropertyTypes` is on: omit optional fields, never set them to `undefined`. Spreading
  `{ ...memo, key }` is fine.
- `JSON.stringify` throws on `bigint`, and `assert` message arguments are evaluated eagerly, so stringify
  results with a bigint-safe replacer before passing them as a message.
- Shell on this machine is zsh: an unmatched glob in `rm -f path*` is an error, not a no-op. macOS `sed -i`
  needs `-i ''`. Multi-line source edits were done with small Python scripts.
- `.gitignore` already covers `NOTES.md`, `*.sqlite`, `*.sqlite.head`, `keys/`, `.env*`.
