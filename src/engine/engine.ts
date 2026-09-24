// ===========================================================================
// ECONOMY ENGINE — the intent router.
// ===========================================================================
//
// The adapter never names a ledger operation. It describes what happened in the
// world (an Intent) and this class decides the money move, validates it against
// the config-driven world rules, and hands a settled op to the LedgerBackend.
//
// Invariants held here:
//   * `submit` NEVER throws. Every failure comes back as IntentFailure with a
//     stable `code` the adapter can branch on.
//   * All money is bigint. Config strings and intent amount strings go through
//     the config helpers; nothing in the money path is a JS number.
//   * Every settled op carries a Memo whose `intent` is the intent type and
//     whose `nonce` is the intent nonce. Replay enforcement itself lives in the
//     backend (`hasNonce` + the settle path) — this file only asks, it does not
//     keep its own nonce set.
// ===========================================================================

import {
  AccountExists,
  DuplicateNonce,
  EngineError,
  InsufficientFunds,
  InvalidAmount,
  InvalidIntent,
  NotAuthorized,
  UnknownEntity,
  UnknownWallet,
} from '../errors.ts';
import { parseAmount, priceOf, rentalRateOf, serviceOf, TREASURY_ID } from '../config/config.ts';
import type { HeistConfig } from '../config/config.ts';
import type { LedgerBackend, WalletKeyInfo } from '../ledger/backend.ts';
import type { Custody } from './custody.ts';
import { Mutex } from './mutex.ts';
import type {
  BuyServiceIntent,
  EngineResponse,
  FineIntent,
  Intent,
  IntentResult,
  Memo,
  OpenAccountIntent,
  OwnerId,
  PayoutIntent,
  RentVehicleIntent,
  ReturnVehicleIntent,
  TheftIntent,
  TransferIntent,
  Wallet,
  WalletId,
} from '../types.ts';

/** The entity that rents out vehicles, per SPEC "Intent catalog". */
const RENTAL_ENTITY: OwnerId = 'bike-rental-co';

/** Price key used when a vehicle has no per-minute rate — a flat rental fee. */
const FLAT_RENTAL_PRICE_KEY = 'bike_rental';

/** History page size and page cap used when reconstructing what a rental cost. */
const HISTORY_PAGE_SIZE = 200;
const HISTORY_MAX_PAGES = 50;

export interface EconomyEngineOptions {
  backend: LedgerBackend;
  custody: Custody;
  config: HeistConfig;
}

export class EconomyEngine {
  readonly #backend: LedgerBackend;
  readonly #custody: Custody;
  readonly #config: HeistConfig;
  /** entity id -> display name, built once from config. */
  readonly #entities: Map<OwnerId, string>;
  /** Lower-cased entity ids. Player ids may not collide with these, whatever the casing. */
  readonly #entityKeys: Set<string>;
  readonly #admins: Set<string>;
  /** Intents read-then-write across awaits, so they run one at a time. */
  readonly #lock = new Mutex();

  constructor(options: EconomyEngineOptions) {
    this.#backend = options.backend;
    this.#custody = options.custody;
    this.#config = options.config;
    this.#entities = new Map(options.config.entities.map((e) => [e.id, e.name ?? e.id]));
    this.#entityKeys = new Set(options.config.entities.map((e) => e.id.toLowerCase()));
    this.#admins = new Set(options.config.admins);
  }

  get config(): HeistConfig {
    return this.#config;
  }

  /**
   * Bring the world up: initialise the backend, then make sure every configured
   * entity has a wallet. Idempotent — safe to call on every process start, and
   * safe against a backend that already persisted the wallets.
   */
  async init(): Promise<void> {
    await this.#backend.init();

    // Entity ids share the owner namespace with players. A player wallet already sitting on
    // an entity's id (say, config gained a "casino-house" after a player joined as that)
    // would be treated as the entity's wallet: refuse to start instead.
    for (const wallet of await this.#backend.listWallets()) {
      if (!wallet.isEntity && this.#isEntityId(wallet.ownerId)) {
        throw new EngineError(
          'ENTITY_ID_CONFLICT',
          `A player wallet already uses the reserved entity id "${wallet.ownerId}"`,
        );
      }
    }
    for (const entity of this.#config.entities) {
      await this.#ensureWallet(entity.id, true);
    }
  }

  /**
   * The intent router. Never throws: an EngineError becomes a typed failure and
   * anything unexpected becomes code 'INTERNAL'.
   */
  async submit(intent: Intent): Promise<EngineResponse> {
    return await this.#guarded(() => this.#route(intent));
  }

  /**
   * ADMIN ONLY — not an Intent and not reachable through `submit`. Puts HD into an entity's
   * wallet (mint) so payouts, refunds and welcome-free worlds have a source on a fresh ledger.
   * Whoever holds the EconomyEngine object is the admin; the adapter surface (submit) has no
   * way to name this operation. Replay-protected by `nonce` like any other write.
   */
  async fundEntity(entityId: OwnerId, amount: string, nonce: string): Promise<EngineResponse> {
    return await this.#guarded(async () => {
      assertNonEmpty(nonce, 'nonce');
      assertNonEmpty(entityId, 'entityId');
      if (await this.#backend.hasNonce(nonce)) throw new DuplicateNonce(nonce);
      const value = this.#intentAmount(amount, 'amount');
      const entity = await this.#requireEntityWallet(entityId);
      const ref = await this.#backend.mint(entity.id, value, {
        intent: 'AdminFund',
        detail: `admin funding of ${this.#displayName(entityId)}`,
        nonce,
      });
      return await this.#result(ref, entity.id, `Funded ${this.#displayName(entityId)} with ${this.#money(value)}.`);
    });
  }

  /** Serialize, and turn every throw into a typed failure. */
  async #guarded(work: () => Promise<IntentResult>): Promise<EngineResponse> {
    try {
      return await this.#lock.run(work);
    } catch (cause) {
      if (cause instanceof EngineError) {
        return { ok: false, code: cause.code, message: cause.message };
      }
      return {
        ok: false,
        code: 'INTERNAL',
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  async #route(intent: Intent): Promise<IntentResult> {
    if (intent === null || typeof intent !== 'object') {
      throw new InvalidIntent('Intent must be an object');
    }
    assertNonEmpty(intent.nonce, 'nonce');
    assertNonEmpty(intent.actor, 'actor');

    // Ask the backend — the single source of truth for replay — before doing any
    // work that has a side effect (OpenAccount would otherwise create a wallet on
    // a replay before the settle call rejected it). The backend still enforces.
    if (await this.#backend.hasNonce(intent.nonce)) {
      throw new DuplicateNonce(intent.nonce);
    }

    switch (intent.type) {
      case 'OpenAccount':
        return await this.#openAccount(intent);
      case 'RentVehicle':
        return await this.#rentVehicle(intent);
      case 'ReturnVehicle':
        return await this.#returnVehicle(intent);
      case 'BuyService':
        return await this.#buyService(intent);
      case 'Payout':
        return await this.#payout(intent);
      case 'Fine':
        return await this.#fine(intent);
      case 'Transfer':
        return await this.#transfer(intent);
      case 'Theft':
        return await this.#theft(intent);
      default:
        throw new InvalidIntent(`Unknown intent type ${JSON.stringify(unknownType(intent))}`);
    }
  }

  // -------------------------------------------------------------------------
  // Intent handlers
  // -------------------------------------------------------------------------

  /**
   * Open an account and pay the welcome grant — once per owner.
   *
   * The grant is a MINT, attributed to the treasury in the memo. The ledger records no source
   * wallet for a mint ("treasury authority signs", types.ts), and treasury balance is fines
   * revenue, not a supply pot; docs/adr/0004 explains why the grant is not a treasury transfer.
   *
   * A wallet that already has ledger history has had its grant. A wallet with none is an
   * interrupted open (wallet written, mint not) and is completed rather than left grantless.
   * Concurrent calls are serialized by the engine lock, so the check below cannot race.
   */
  async #openAccount(intent: OpenAccountIntent): Promise<IntentResult> {
    this.#requireEntity(TREASURY_ID);
    const amount = parseAmount(this.#config.welcomeGrant, 'welcomeGrant');
    requirePositive(amount, 'welcomeGrant');

    this.#assertPlayerId(intent.actor, 'actor');
    const existing = await this.#backend.getWalletByOwner(intent.actor);
    if (existing !== null) {
      if (existing.isEntity) throw new NotAuthorized(`"${intent.actor}" is an entity account`);
      const history = await this.#backend.history(existing.id, undefined, 1);
      if (history.txs.length > 0) throw new AccountExists(intent.actor, existing.address);
    }
    const player = existing ?? (await this.#ensureWallet(intent.actor, false));

    const ref = await this.#backend.mint(
      player.id,
      amount,
      this.#memo(intent, `welcome grant from ${this.#displayName(TREASURY_ID)}`),
    );

    return await this.#result(
      ref,
      player.id,
      `Account opened. ${this.#money(amount)} welcome grant received.`,
    );
  }

  /** player -> bike-rental-co, rate * minutes (or the flat fee). */
  async #rentVehicle(intent: RentVehicleIntent): Promise<IntentResult> {
    assertNonEmpty(intent.vehicle, 'vehicle');
    const minutes = requireWholeCount(intent.minutes, 'minutes');

    const amount = this.#rentalCost(intent.vehicle, minutes);
    requirePositive(amount, 'rental cost');

    const player = await this.#requirePlayerWallet(intent.actor, 'actor');
    const payee = await this.#requireEntityWallet(RENTAL_ENTITY);

    const ref = await this.#backend.transfer(
      player.id,
      payee.id,
      amount,
      this.#memo(intent, `${intent.vehicle} — ${minutes}min`),
    );

    return await this.#result(
      ref,
      player.id,
      `Paid ${this.#money(amount)} to ${this.#displayName(RENTAL_ENTITY)}.`,
    );
  }

  /** bike-rental-co -> player, refunding the unused portion of a rental. */
  async #returnVehicle(intent: ReturnVehicleIntent): Promise<IntentResult> {
    assertNonEmpty(intent.vehicle, 'vehicle');
    const minutesUnused = requireWholeCount(intent.minutesUnused, 'minutesUnused');

    const player = await this.#requirePlayerWallet(intent.actor, 'actor');
    const payer = await this.#requireEntityWallet(RENTAL_ENTITY);

    let refund = this.#refundAmount(intent.vehicle, minutesUnused);
    requirePositive(refund, 'refund');

    // A refund must never exceed what the player actually paid for this vehicle.
    // The backend has no rental table, so the cap is reconstructed from the
    // hash-chained history: rentals of this vehicle paid, minus refunds already
    // taken. `null` means the scan was truncated and the cap is not trustworthy.
    const outstanding = await this.#rentalOutstanding(player.id, payer.id, intent.vehicle);
    if (outstanding !== null) {
      if (outstanding <= 0n) {
        throw new InvalidIntent(
          `No outstanding rental of "${intent.vehicle}" to refund for ${intent.actor}`,
        );
      }
      if (refund > outstanding) refund = outstanding;
    }

    // Second, independent clamp: the entity cannot pay out more than it holds.
    const available = await this.#backend.getBalance(payer.id);
    if (available <= 0n) {
      throw new InsufficientFunds(payer.id, refund, available);
    }
    if (refund > available) refund = available;

    const ref = await this.#backend.transfer(
      payer.id,
      player.id,
      refund,
      this.#memo(intent, `${intent.vehicle} — refund ${minutesUnused}min`),
    );

    return await this.#result(
      ref,
      player.id,
      `Refunded ${this.#money(refund)} from ${this.#displayName(RENTAL_ENTITY)}.`,
    );
  }

  /** player -> service entity, price * units. */
  async #buyService(intent: BuyServiceIntent): Promise<IntentResult> {
    assertNonEmpty(intent.service, 'service');
    const units = intent.units === undefined ? 1 : requireWholeCount(intent.units, 'units');

    // Unknown service is reported as UnknownEntity per the intent catalog: there
    // is no entity behind it to pay. `serviceOf` throws exactly that.
    const service = serviceOf(this.#config, intent.service);
    const entityId: OwnerId = service.entity;
    const amount = service.price * BigInt(units);
    requirePositive(amount, 'price');

    const player = await this.#requirePlayerWallet(intent.actor, 'actor');
    const payee = await this.#requireEntityWallet(entityId);

    const ref = await this.#backend.transfer(
      player.id,
      payee.id,
      amount,
      this.#memo(intent, units === 1 ? intent.service : `${intent.service} x${units}`),
    );

    return await this.#result(
      ref,
      player.id,
      `Paid ${this.#money(amount)} to ${this.#displayName(entityId)}.`,
    );
  }

  /** employer entity -> player. */
  async #payout(intent: PayoutIntent): Promise<IntentResult> {
    assertNonEmpty(intent.employer, 'employer');
    const amount = this.#intentAmount(intent.amount, 'amount');

    const employer = await this.#requireEntityWallet(intent.employer);
    const player = await this.#requirePlayerWallet(intent.actor, 'actor');

    const ref = await this.#backend.transfer(
      employer.id,
      player.id,
      amount,
      this.#memo(intent, `payout from ${this.#displayName(intent.employer)}`),
    );

    return await this.#result(
      ref,
      player.id,
      `Received ${this.#money(amount)} from ${this.#displayName(intent.employer)}.`,
    );
  }

  /** player -> treasury. */
  async #fine(intent: FineIntent): Promise<IntentResult> {
    const amount = this.#intentAmount(intent.amount, 'amount');

    const player = await this.#requirePlayerWallet(intent.actor, 'actor');
    const treasury = await this.#requireEntityWallet(TREASURY_ID);

    const reason = typeof intent.reason === 'string' && intent.reason.trim() !== ''
      ? intent.reason.trim()
      : undefined;

    const ref = await this.#backend.transfer(
      player.id,
      treasury.id,
      amount,
      this.#memo(intent, reason === undefined ? 'fine' : `fine — ${reason}`),
    );

    const suffix = reason === undefined ? '' : ` (${reason})`;
    return await this.#result(
      ref,
      player.id,
      `Paid ${this.#money(amount)} to ${this.#displayName(TREASURY_ID)}${suffix}.`,
    );
  }

  /** player -> player. */
  async #transfer(intent: TransferIntent): Promise<IntentResult> {
    assertNonEmpty(intent.to, 'to');
    if (intent.to === intent.actor) {
      throw new InvalidIntent('Cannot transfer to yourself');
    }
    const amount = this.#intentAmount(intent.amount, 'amount');

    const from = await this.#requirePlayerWallet(intent.actor, 'actor');
    const to = await this.#requirePlayerWallet(intent.to, 'to');

    const ref = await this.#backend.transfer(
      from.id,
      to.id,
      amount,
      this.#memo(intent, `to ${intent.to}`),
    );

    return await this.#result(
      ref,
      from.id,
      `Sent ${this.#money(amount)} to ${intent.to}.`,
    );
  }

  /** victim -> actor. Only ever with explicit authorization. */
  async #theft(intent: TheftIntent): Promise<IntentResult> {
    assertNonEmpty(intent.victim, 'victim');
    if (typeof intent.authorizedBy !== 'string' || intent.authorizedBy.trim() === '') {
      throw new NotAuthorized(
        'Theft requires authorizedBy — consent from the victim or an admin id',
      );
    }
    if (intent.victim === intent.actor) {
      throw new InvalidIntent('Cannot steal from yourself');
    }
    // Whoever authorizes must be the victim (consent) or a configured admin. A free-text
    // "authorizedBy" would authorize anything; naming the robber themselves authorizes nothing.
    const authorizedBy = intent.authorizedBy.trim();
    if (authorizedBy !== intent.victim && !this.#admins.has(authorizedBy)) {
      throw new NotAuthorized(
        `Theft must be authorized by the victim (consent) or a configured admin, not "${authorizedBy}"`,
      );
    }
    const amount = this.#intentAmount(intent.amount, 'amount');

    const victim = await this.#requirePlayerWallet(intent.victim, 'victim');
    const robber = await this.#requirePlayerWallet(intent.actor, 'actor');

    const ref = await this.#backend.transfer(
      victim.id,
      robber.id,
      amount,
      this.#memo(intent, `theft from ${intent.victim}, authorized by ${authorizedBy}`),
    );

    return await this.#result(
      ref,
      robber.id,
      `Took ${this.#money(amount)} from ${intent.victim}.`,
    );
  }

  // -------------------------------------------------------------------------
  // Pricing
  // -------------------------------------------------------------------------

  #rentalCost(vehicle: string, minutes: number): bigint {
    if (this.#config.rentalPerMinute[vehicle] !== undefined) {
      return rentalRateOf(this.#config, vehicle) * BigInt(minutes);
    }
    if (this.#config.prices[FLAT_RENTAL_PRICE_KEY] === undefined) {
      throw new InvalidIntent(
        `No rental rate configured for vehicle "${vehicle}" and no "${FLAT_RENTAL_PRICE_KEY}" flat price to fall back on`,
      );
    }
    return priceOf(this.#config, FLAT_RENTAL_PRICE_KEY);
  }

  /**
   * Refund at the same rate the rental was charged at. For a flat-fee vehicle
   * there is no per-minute rate to prorate, so the flat fee is refunded once —
   * then capped below by what was actually paid.
   */
  #refundAmount(vehicle: string, minutesUnused: number): bigint {
    if (this.#config.rentalPerMinute[vehicle] !== undefined) {
      return rentalRateOf(this.#config, vehicle) * BigInt(minutesUnused);
    }
    if (this.#config.prices[FLAT_RENTAL_PRICE_KEY] === undefined) {
      throw new InvalidIntent(`No rental rate configured for vehicle "${vehicle}"`);
    }
    return priceOf(this.#config, FLAT_RENTAL_PRICE_KEY);
  }

  /**
   * How much this player still has at stake on this vehicle: sum of RentVehicle
   * payments to the rental entity minus ReturnVehicle refunds already received.
   * Returns null when the history scan hit its page cap, in which case the caller
   * must not trust the number as a cap.
   */
  async #rentalOutstanding(
    playerWallet: WalletId,
    entityWallet: WalletId,
    vehicle: string,
  ): Promise<bigint | null> {
    const tag = `${vehicle} — `;
    let paid = 0n;
    let refunded = 0n;
    let cursor: string | undefined;

    for (let page = 0; page < HISTORY_MAX_PAGES; page++) {
      const result = await this.#backend.history(playerWallet, cursor, HISTORY_PAGE_SIZE);
      for (const tx of result.txs) {
        const detail = tx.memo.detail;
        if (typeof detail !== 'string' || !detail.startsWith(tag)) continue;
        if (tx.memo.intent === 'RentVehicle' && tx.from === playerWallet && tx.to === entityWallet) {
          paid += tx.amount;
        } else if (
          tx.memo.intent === 'ReturnVehicle' &&
          tx.from === entityWallet &&
          tx.to === playerWallet
        ) {
          refunded += tx.amount;
        }
      }
      if (result.cursor === null) {
        const outstanding = paid - refunded;
        return outstanding > 0n ? outstanding : 0n;
      }
      cursor = result.cursor;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Wallets, memos, results
  // -------------------------------------------------------------------------

  /** Create the wallet if absent, minting the keypair through Custody first. */
  async #ensureWallet(ownerId: OwnerId, isEntity: boolean): Promise<Wallet> {
    const existing = await this.#backend.getWalletByOwner(ownerId);
    if (existing !== null) {
      if (isEntity && !existing.isEntity) {
        throw new EngineError('ENTITY_ID_CONFLICT', `A player wallet already uses the entity id "${ownerId}"`);
      }
      return existing;
    }
    return await this.#backend.createWallet(ownerId, this.#keyFor(ownerId), { isEntity });
  }

  /** The public half of this owner's keypair, generated on first use. */
  #keyFor(ownerId: OwnerId): WalletKeyInfo {
    const pubkey = this.#custody.pubkeyOf(ownerId);
    const address = this.#custody.addressOf(ownerId);
    if (pubkey !== null && address !== null) {
      return { pubkey, address };
    }
    const keypair = this.#custody.createKeypair(ownerId);
    // The private half stays inside Custody; only the public half crosses to the
    // ledger. Never log or return keypair.privateKeyPem.
    return { pubkey: keypair.pubkey, address: keypair.address };
  }

  #isEntityId(ownerId: OwnerId): boolean {
    return this.#entityKeys.has(ownerId.toLowerCase());
  }

  /** A well-formed owner id that is not an entity's. Entity ids never act as players. */
  #assertPlayerId(ownerId: OwnerId, role: string): void {
    assertOwnerId(ownerId, role);
    if (this.#isEntityId(ownerId)) {
      throw new NotAuthorized(`"${ownerId}" is an entity account and cannot be the ${role} of a player intent`);
    }
  }

  /** The wallet of a PLAYER owner. Entity ids are rejected as actor / to / victim. */
  async #requirePlayerWallet(ownerId: OwnerId, role: string): Promise<Wallet> {
    this.#assertPlayerId(ownerId, role);
    const wallet = await this.#backend.getWalletByOwner(ownerId);
    if (wallet === null) throw new UnknownWallet(ownerId);
    if (wallet.isEntity) {
      throw new NotAuthorized(`"${ownerId}" is an entity account and cannot be the ${role} of a player intent`);
    }
    return wallet;
  }

  #requireEntity(entityId: OwnerId): void {
    if (!this.#entities.has(entityId)) throw new UnknownEntity(entityId);
  }

  async #requireEntityWallet(entityId: OwnerId): Promise<Wallet> {
    this.#requireEntity(entityId);
    const wallet = await this.#backend.getWalletByOwner(entityId);
    if (wallet === null) throw new UnknownWallet(entityId);
    return wallet;
  }

  #memo(intent: Intent, detail?: string): Memo {
    const memo: Memo = { intent: intent.type, nonce: intent.nonce };
    if (detail !== undefined && detail !== '') memo.detail = detail;
    return memo;
  }

  async #result(
    ref: { txId: string; hash: string },
    balanceOf: WalletId,
    message: string,
  ): Promise<IntentResult> {
    const newBalance = await this.#backend.getBalance(balanceOf);
    return { ok: true, txId: ref.txId, hash: ref.hash, newBalance, message };
  }

  #displayName(entityId: OwnerId): string {
    return this.#entities.get(entityId) ?? entityId;
  }

  #money(amount: bigint): string {
    return `${amount.toString()} ${this.#config.currency}`;
  }

  /** Parse an amount string off an intent and require it to be strictly positive. */
  #intentAmount(raw: string, field: string): bigint {
    if (typeof raw !== 'string') {
      throw new InvalidAmount(`${field} must be a decimal string, e.g. "50"`);
    }
    const amount = parseAmount(raw, field);
    requirePositive(amount, field);
    return amount;
  }
}

// ---------------------------------------------------------------------------
// Small guards
// ---------------------------------------------------------------------------

/** Owner ids are opaque, but must be plain: no padding, no control characters, bounded. */
function assertOwnerId(value: unknown, field: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new InvalidIntent(
      `${field} must be a 1-128 character id with no leading/trailing whitespace or control characters`,
    );
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidIntent(`${field} must be a non-empty string`);
  }
}

function requirePositive(amount: bigint, field: string): void {
  if (amount <= 0n) {
    throw new InvalidAmount(`${field} must be greater than zero, got ${amount.toString()}`);
  }
}

/** Counts (minutes, units) are plain integers, never money — but never floats either. */
function requireWholeCount(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new InvalidIntent(`${field} must be a whole number, got ${String(value)}`);
  }
  if (value <= 0) {
    throw new InvalidIntent(`${field} must be greater than zero, got ${String(value)}`);
  }
  return value;
}

/** Only reachable if an adapter sends a type outside the union. */
function unknownType(intent: never): string {
  return String((intent as { type?: unknown }).type);
}
