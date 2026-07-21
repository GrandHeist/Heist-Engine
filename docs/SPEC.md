# Heist Engine — Spec

## What it is

A plugin that replaces a GTA RP server's in-game economy with a transparent, auditable ledger of player and NPC-entity wallets. Players spawn with a wallet, every economic action (rent a bike, pay hospital, get paid for a job, fines, robberies) is a signed transfer between wallets. The ledger backend is swappable: **Postgres** (off-chain, ToS-safe today) or **Solana / BNB Chain** (real on-chain, pending platform approval).

This is a private friends server. No real-money entry/exit, no sale of HD, no advertised public listing. HD = "Heist Dollar," the only currency in the world.

## Goals

- One plugin codebase that runs on **FiveM**, **RageMP**, and a **standalone Postgres mode** (for dev/dry-run and ToS-safe operation).
- Ledger backend is a swappable adapter — Postgres / Solana / BSC behind the same interface.
- Every economic action is a signed, auditable transaction. Nothing changes a balance except a transfer, mint, or burn.
- Server-custodial wallets — players never sign anything in-game. Zero friction.
- Talking-point ready: when we meet Cfx.re / RageMP / Take-Two, we can demo the Postgres mode and explain the on-chain modes as a config flip.

## Non-goals (v1)

- No real-money on/off-ramp. HD is not redeemable for fiat.
- No DEX, no AMM, no lending — closed economy.
- No NFTs for items (vehicles, houses) in v1. Items live in the game DB. Maybe v2.
- No anti-cheat hardening beyond signed intents — this is a trusted-friends server.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Game World (FiveM / RageMP / standalone sim)                │
│  ┌─────────────────────────────────────────────────┐        │
│  │ Game Adapter  (Lua resource for FiveM,           │        │
│  │                JS package for RageMP,            │        │
│  │                CLI sim for standalone)           │        │
│  └────────────────────┬────────────────────────────┘        │
└───────────────────────┼─────────────────────────────────────┘
                        │  Intent (HTTP/WS, signed by server key)
                        ▼
┌─────────────────────────────────────────────────────────────┐
│ Economy Engine  (Node.js / TypeScript service)              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ Intent Router│  │ Pricing/Rules│  │ Custody (MPC/KV) │   │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘   │
│         └──── validates, prices, signs ────────┘            │
└────────────────────────────┬────────────────────────────────┘
                             │  Ledger op (transfer/mint/burn)
                             ▼
┌─────────────────────────────────────────────────────────────┐
│ Ledger Backend (swappable, single interface)                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │  Postgres    │  │   Solana     │  │  BNB Chain       │   │
│  │  append-only │  │   SPL HD     │  │  ERC-20 HD       │   │
│  └──────────────┘  └──────────────┘  └──────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 1. Game Adapter (in-game)

A thin layer that runs inside the GTA server framework. Its only job: turn in-game events into typed economy **Intents** and ship them to the Economy Engine over local HTTP/WS.

| Event | Intent |
|---|---|
| Player joins for the first time | `OpenAccount(player)` → engine creates wallet, mints welcome grant |
| Player interacts with bike rental NPC | `RentVehicle(player, "bike", duration)` |
| Player enters hospital | `BuyService(player, "hospital", "full-heal")` |
| Player completes a paying job | `Payout(employer="taxi-co", player, amount)` |
| Player robs another player | `Transfer(victim, robber, amount, reason="theft")` |
| Cop fines player | `Fine(player, treasury, amount)` |

Adapter implementations:
- **FiveM**: Lua resource. Uses `PerformHttpRequest` to talk to the engine. Subscribes to standard events (`playerJoining`, `onResourceStart`, plus framework events from ESX/QBCore for shops, vehicles, etc.).
- **RageMP**: JavaScript package, uses native `fetch`. Same intent contracts.
- **Standalone sim**: a CLI / web UI that simulates player events. Useful for dev, demos, and arguing with companies without booting a real GTA server.

The adapter never touches balances directly. It only emits intents and renders the engine's response (e.g., "✓ Paid $10 HD. Bike spawning…").

### 2. Economy Engine (Node.js service)

The brain. Owns:
- **Intent router** — validates each intent against the world rules (does the player have enough? Is the NPC entity real? Is the price right?).
- **Pricing/rules** — config-driven prices for services. JSON/YAML, hot-reloadable.
- **Custody** — manages player wallet keys server-side. Two modes:
  - *Encrypted KV* (v1): private keys encrypted at rest with a server master key. Simple, fine for friends server.
  - *MPC* (v2): threshold signature so no single key can move funds. Overkill for v1 but the interface should support it.
- **Settlement** — produces a ledger operation (transfer/mint/burn) and hands it to the backend.

Intent flow:
```
1. Adapter POSTs Intent {type, payload, sig=server_key(adapter)}
2. Engine validates: schema, balance, entity exists, price matches catalog
3. Engine signs the resulting ledger op with the payer's custodial key
4. Engine calls LedgerBackend.transfer(...)
5. Engine returns {ok, txId, newBalance} to adapter
6. Adapter triggers the in-game effect (spawn bike, restore health)
```

If the ledger op fails, the in-game effect does NOT happen. Atomicity is engine-side: don't spawn the bike before the transfer settles.

### 3. Ledger Backend (swappable)

Single TypeScript interface:

```ts
interface LedgerBackend {
  createWallet(ownerId: string): Promise<Wallet>;          // { id, address, pubkey }
  getBalance(walletId: string): Promise<bigint>;
  transfer(from: WalletId, to: WalletId, amount: bigint, memo: Memo): Promise<TxRef>;
  mint(to: WalletId, amount: bigint, memo: Memo): Promise<TxRef>;   // admin-only
  burn(from: WalletId, amount: bigint, memo: Memo): Promise<TxRef>;
  history(walletId: string, cursor?: string): Promise<Tx[]>;
}
```

Three implementations:

**Postgres backend** (default, ToS-safe):
- `wallets(id, owner_id, address, pubkey, created_at)`
- `transactions(id, from_wallet, to_wallet, amount, memo, prev_hash, hash, signature, created_at)` — append-only, hash-chained for tamper evidence
- `balances` view = sum of credits − debits per wallet
- Wallets are ed25519 keypairs; transfers signed by sender's custodial key — exactly like an on-chain tx, just settled in SQL
- Public read endpoint so the whole ledger is auditable

**Solana backend**:
- HD = SPL token, mint authority = server multisig
- Player wallet = Solana keypair, custodied by engine
- `transfer` = SPL transfer tx, server signs as payer + fee payer
- Sub-second finality, ~$0.0001 per tx — fits in-game cadence

**BNB Chain backend**:
- HD = ERC-20 token, mint authority = server multisig (Gnosis Safe)
- Player wallet = EVM keypair, custodied by engine
- `transfer` = ERC-20 transfer, server pays gas
- Slower (~3s blocks) — fine for slow actions, friction for rapid ones

The on-chain backends are gated behind a config flag and require platform approval before being enabled on FiveM/RageMP.

## Entity wallets (NPC accounts)

The economy has wallets that aren't players:

| Entity | Purpose |
|---|---|
| `treasury` | Mint source. Welcome grants, salary payouts originate here. |
| `bike-rental-co` | Receives rental fees. |
| `hospital` | Receives medical fees. |
| `gas-station-N` | One per gas station. |
| `taxi-co`, `pd-payroll`, etc. | Job-based payouts. |
| `casino-house` (later) | Gambling sink, if we add it. |

Entity wallets are owned by the server but each is a real, addressable ledger account. Lets us see the full flow of money — e.g., "the hospital made 12,400 HD this week."

## Intent catalog (v1)

| Intent | Payer | Payee | Trigger |
|---|---|---|---|
| `OpenAccount` | `treasury` | new player | first join (welcome grant, e.g. 500 HD) |
| `RentVehicle` | player | `bike-rental-co` | NPC interaction |
| `ReturnVehicle` | `bike-rental-co` | player | return early, partial refund |
| `BuyService` | player | service entity | hospital, gas, food |
| `Payout` | employer entity | player | end-of-shift, job completion |
| `Fine` | player | `treasury` | police action |
| `Transfer` | player | player | direct send (`/pay 02 50ocd`) |
| `Theft` | victim | robber | mugging RP, requires both consent or admin |

## Config example

```yaml
backend: postgres   # or "solana", "bsc"
welcome_grant: 500
currency: HD
prices:
  bike_rental: 10
  hospital_full_heal: 200
  gas_per_liter: 2
entities:
  - { id: bike-rental-co, name: "Crystal Bikes" }
  - { id: hospital, name: "Pillbox Medical" }
  - { id: treasury }
```

## Why this design works for the company conversations

- **Postgres mode is shippable today** without breaching FiveM's Creator Platform License Agreement — it's just a server-side economy database. No tokens, no crypto assets.
- The on-chain backends are an **architectural option**, not a required feature. We can demo Postgres mode to Cfx.re and say: "the codebase supports a Solana backend; we won't enable it until you bless it."
- **The intent layer is the actual innovation** — typed, signed, auditable economic actions. Useful even without crypto.
- If Cfx.re ever opens up to crypto (unlikely soon), we flip a config flag. If they don't, we still have a great off-chain economy plugin.

## Open questions to resolve before building

1. Single Economy Engine for all three game adapters, or one engine per game? (Default: single, multi-tenant.)
2. Welcome grant amount, prices, salary rates — needs a balance pass.
3. What happens when a player rage-quits mid-rental? Refund logic.
4. Do we want anti-double-spend / nonce on intents from the adapter? (Yes — replay protection.)
5. Admin UI: web dashboard for minting, viewing entity P&L, banning a wallet.
6. Backup/recovery story for the encrypted KV custody.

## Build order (when we start)

1. Economy Engine + Postgres backend + standalone CLI adapter — full economy works without any GTA server.
2. FiveM Lua adapter — connect to a local FiveM dev server, port one interaction (bike rental).
3. RageMP JS adapter — same interaction, different framework.
4. Solana backend behind a feature flag — same engine, same intents, real SPL transfers.
5. BSC backend behind a feature flag.
6. Admin dashboard.
