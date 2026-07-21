# Heist Engine

[@GTAHeistEngine](https://x.com/GTAHeistEngine)

A drop-in economy engine for GTA RP servers, built around a swappable ledger backend.
Same engine, three deploy modes:

- **Postgres mode** — off-chain, append-only, tamper-evident ledger. Ships today, no platform-ToS friction.
- **Solana mode** — SPL token "HD," server-custodied wallets, sub-second settlement. Gated until platform approval.
- **BNB Chain mode** — ERC-20 HD, server-custodied wallets. Gated until platform approval.

Runs on **FiveM** (Lua adapter), **RageMP** (JS adapter), or **standalone simulator** (CLI/web).

The core idea: every economic action in the world (rent a bike, pay the hospital, get a payout, fines)
is a typed, signed transfer between wallets. Players are server-custodied — zero in-game friction.

The in-game currency is **HD** — Heist Dollars.

## For server owners

Heist Engine is meant to drop into your server: install the adapter for your framework, point it at the
engine, and your economy becomes an auditable ledger instead of a number in a database.

Status: **in development.** See [`docs/SPEC.md`](docs/SPEC.md) for the architecture and intent catalog,
and [`docs/adr/`](docs/adr/) for decisions that are expensive to reverse.
