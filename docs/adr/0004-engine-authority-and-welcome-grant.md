# ADR 0004 — Who may do what inside the engine, and how the welcome grant works

Date: 2026-09-24
Status: Accepted

## Context

A review of the intent router found that money could be created or stolen by an adapter (or anything
that can reach `submit`) without breaking a single ledger invariant:

- `OpenAccount` minted the welcome grant on **every call**. A fresh nonce each time meant unlimited
  money for one player.
- Entity ids (`treasury`, `hospital`, ...) share the owner namespace with players and the engine never
  looked at `Wallet.isEntity`. `Transfer` to `treasury`, `Theft` with `victim: "hospital"`, or
  `OpenAccount` with `actor: "treasury"` all worked.
- `Theft.authorizedBy` accepted any non-empty string, so "authorized" meant nothing.
- A fresh world had no way to put HD into `treasury`, `pd-payroll`, etc. Tests reached past the engine
  and minted straight through the backend.

## Decisions

### 1. The welcome grant is a mint, paid once per owner

`OpenAccount` pays the grant only if the ledger has not already recorded one for this owner. The mint
carries the key `welcome:<ownerId>` (`Memo.key`, ADR 0005) and a backend accepts a key exactly once,
atomically, so repeats return `ACCOUNT_EXISTS` (typed, carries the address) even across restarts. A
wallet whose mint never landed (interrupted open) simply gets the grant on the next call, whatever else
has happened to it since. The engine mutex (`src/engine/mutex.ts`) serializes concurrent calls.
(An earlier draft of this ADR used a "wallet has no history" rule; it was replaced by the key.)

"Once per owner" means once per **owner id string**. Ids must be NFC-normalized and free of control,
invisible (format) and lone-surrogate characters, so look-alike encodings of one name cannot collect
several grants. Case is significant (`Alice` and `alice` are different owners), so adapters must pass a
stable account identifier (licence, Steam id), never a name a player can type.

**Why a mint and not a transfer from `treasury`.** SPEC line 154 lists `treasury` as the payer. We looked
at making it a real transfer and did not, because:

- `types.ts` already defines a mint as "treasury authority signs": treasury is the *authority*, not a
  balance-holding pot. Treasury's balance is fines revenue.
- A transfer bounds the grant by the treasury's balance. Every new world would fail `OpenAccount` until
  an operator funded the treasury, and a busy join night could drain it. That is a policy choice
  (fixed-supply economy) that belongs to the server owner, not a side effect of a bug fix.
- The two-row alternative (mint into treasury, then transfer to the player) is not atomic on the
  current backend interface, and a crash between the rows inflates the treasury on retry.

The memo says `welcome grant from <treasury display name>`, so history still reads as treasury-issued.
Revisit if a fixed-supply economy is wanted: it is a small change (transfer instead of mint, plus a
funding step in world setup) that the admin funding path below already supports.

### 2. Entity ids are reserved; players and entities never mix

- Every player intent rejects an entity id as `actor`, `to` or `victim` with `NOT_AUTHORIZED`. The
  match is case-insensitive (`Treasury` is reserved too) and also checks `Wallet.isEntity`.
- Owner ids must be plain: 1-128 chars, no leading/trailing whitespace, no control characters.
- `init()` refuses to start (`ENTITY_ID_CONFLICT`) if a player wallet already sits on an entity id,
  e.g. config gained `casino-house` after a player joined under that name.

### 3. `Theft` must be authorized by the victim or a configured admin

`authorizedBy` must equal the victim's id (consent) or appear in the new `admins` config list (owner
ids, never entity ids). A robber naming themselves, or any other string, is refused.

### 4. Entities are funded through an admin method, not an intent

`EconomyEngine.fundEntity(entityId, amount, nonce)` mints into a configured entity wallet with memo
intent `AdminFund`. It is **not** in the `Intent` union, so nothing that talks to `submit` can name it;
only code holding the engine object (the CLI sim, a future admin tool) can call it. It is
replay-protected. The sim exposes it as `fund` and `seed` uses it to top up payout entities.

## What this does NOT fix (needs adapter authentication, see ADR 0003)

Inside the engine there is nothing to authenticate *who is calling `submit`*. Until an authenticated
adapter envelope exists, a caller that can reach `submit` can still:

- Claim any `actor`: `Fine` and `Transfer` debit whoever `actor` names; `Payout` pays whoever `actor`
  names from any entity wallet that holds funds (there is no per-employer authority, no cap).
- Claim victim consent for `Theft` by naming the victim in `authorizedBy`. Real consent needs the
  victim's client to say yes through an authenticated channel; the engine can only check the claim.
- Claim to be an admin by naming one.

The engine now makes these claims *checkable* (a closed set of admins, no entity ids, no self-auth),
but the claims themselves are only as trustworthy as the adapter. The current trust model is the
SPEC's: a trusted adapter on the same host, private friends server.

## Consequences

- One global mutex serializes all intents in one process. Two engine processes on one database are not
  covered (backend nonce and balance checks still hold, but read-then-write logic in the engine would
  race). Run one engine per ledger.
- `admins` is new config; default is empty, so out of the box `Theft` needs the victim's consent claim.
- Existing callers of `OpenAccount` on join will now see `ACCOUNT_EXISTS` for returning players. That is
  the intended signal: adapters should treat it as "already open", not as a failure.
