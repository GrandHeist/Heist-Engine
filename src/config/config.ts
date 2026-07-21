// Config loading and validation.
//
// The SPEC's "Config example" is written as YAML. There is no YAML dependency in
// this project and none is permitted (zero external deps), so the on-disk format
// is JSON and the file is named `heist.config.json`. The shape is otherwise a
// one-to-one mapping of the SPEC example, with snake_case keys folded to camelCase.
//
// Money rule (see docs/adr/0002): every amount is a decimal STRING in config and
// a bigint in code. Nothing in the money path is ever a JS number — `JSON.parse`
// would silently turn 9007199254740993 into a float, so numeric amounts in the
// config file are rejected outright rather than coerced.

import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { EngineError, InvalidIntent } from '../errors.ts';
import type { BackendName } from '../ledger/backend.ts';

/** An NPC/system account. `treasury` is mandatory — it is the mint source. */
export interface EntityConfig {
  id: string;
  /** Display name shown in-game, e.g. "Crystal Bikes". */
  name?: string;
}

export interface HeistConfig {
  backend: BackendName;
  /** Currency ticker. Cosmetic — the ledger is single-currency by design. */
  currency: string;
  /** Minted from treasury to a new player on OpenAccount. Decimal string. */
  welcomeGrant: string;
  /** service key -> price, decimal strings. e.g. { hospital_full_heal: "200" } */
  prices: Record<string, string>;
  /** vehicle key -> per-minute rental rate, decimal strings. */
  rentalPerMinute: Record<string, string>;
  entities: EntityConfig[];
  /** Filesystem path for the sqlite backend. Ignored by other backends. */
  dbPath?: string;
}

/** The entity that every economy must have: mint source and fine collector. */
export const TREASURY_ID = 'treasury';

const BACKEND_NAMES: readonly BackendName[] = ['memory', 'sqlite', 'postgres', 'solana', 'bsc'];

const DEFAULT_CONFIG_FILENAME = 'heist.config.json';

// ---------------------------------------------------------------------------
// Money parsing
// ---------------------------------------------------------------------------

/**
 * Parse a decimal money string into whole-HD bigint.
 *
 * Accepts "500", "0", "500.00" (a zero fractional part is tolerated so hand-written
 * config does not blow up). Rejects negatives, fractions of an HD, exponent
 * notation, and anything non-numeric. `field` is only used to build the message.
 */
export function parseAmount(value: string, field: string): bigint {
  if (typeof value !== 'string') {
    throw new InvalidIntent(
      `config: ${field} must be a decimal string, got ${describe(value)}. ` +
        `Money is never a JSON number — quote it, e.g. "500".`,
    );
  }
  const trimmed = value.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (match === null) {
    throw new InvalidIntent(
      `config: ${field} is not a non-negative decimal string: ${JSON.stringify(value)}`,
    );
  }
  const fraction = match[2];
  if (fraction !== undefined && /[^0]/.test(fraction)) {
    throw new InvalidIntent(
      `config: ${field} = ${JSON.stringify(value)} has a fractional part. ` +
        `HD is indivisible — amounts must be whole.`,
    );
  }
  // match[1] is guaranteed by the regex; noUncheckedIndexedAccess needs the guard.
  const whole = match[1];
  if (whole === undefined) {
    throw new InvalidIntent(`config: ${field} could not be parsed: ${JSON.stringify(value)}`);
  }
  return BigInt(whole);
}

/** Price of a catalog service as bigint. Throws InvalidIntent for unknown keys. */
export function priceOf(config: HeistConfig, service: string): bigint {
  const raw = config.prices[service];
  if (raw === undefined) {
    throw new InvalidIntent(`No price configured for service "${service}"`);
  }
  return parseAmount(raw, `prices.${service}`);
}

/** Per-minute rental rate of a vehicle as bigint. Throws InvalidIntent for unknown keys. */
export function rentalRateOf(config: HeistConfig, vehicle: string): bigint {
  const raw = config.rentalPerMinute[vehicle];
  if (raw === undefined) {
    throw new InvalidIntent(`No rental rate configured for vehicle "${vehicle}"`);
  }
  return parseAmount(raw, `rentalPerMinute.${vehicle}`);
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * A sane, playable default matching the SPEC's example config plus the entity
 * table in "Entity wallets". Kept in sync with src/config/heist.config.json —
 * that file is this function serialised.
 */
export function defaultConfig(): HeistConfig {
  return {
    backend: 'memory',
    currency: 'HD',
    welcomeGrant: '500',
    prices: {
      bike_rental: '10',
      hospital_full_heal: '200',
      gas_per_liter: '2',
    },
    rentalPerMinute: {
      bike: '1',
      car: '3',
      helicopter: '25',
    },
    entities: [
      { id: 'treasury', name: 'City Treasury' },
      { id: 'bike-rental-co', name: 'Crystal Bikes' },
      { id: 'hospital', name: 'Pillbox Medical' },
      { id: 'gas-station-1', name: 'Xero Gas — Strawberry' },
      { id: 'taxi-co', name: 'Downtown Cab Co.' },
      { id: 'pd-payroll', name: 'LSPD Payroll' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Loading + validation
// ---------------------------------------------------------------------------

/**
 * Read and validate a config file.
 *
 * With no argument it looks for `heist.config.json` in the current working
 * directory. Missing/unreadable file, bad JSON, or any invalid field throws —
 * a half-valid economy config is worse than no economy at all.
 */
export function loadConfig(path?: string): HeistConfig {
  const target =
    path === undefined
      ? resolve(process.cwd(), DEFAULT_CONFIG_FILENAME)
      : isAbsolute(path)
        ? path
        : resolve(process.cwd(), path);

  let text: string;
  try {
    text = readFileSync(target, 'utf8');
  } catch (cause) {
    throw new EngineError(
      'CONFIG_UNREADABLE',
      `Cannot read config at ${target}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new EngineError(
      'CONFIG_MALFORMED',
      `Config at ${target} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  return validateConfig(parsed, target);
}

/**
 * Validate an already-parsed config object and apply defaults.
 * Exported so tests and the CLI can validate an inline object without a file.
 */
export function validateConfig(input: unknown, source = '<inline>'): HeistConfig {
  if (!isRecord(input)) {
    throw new InvalidIntent(`config (${source}): expected a JSON object, got ${describe(input)}`);
  }

  const defaults = defaultConfig();

  // backend ----------------------------------------------------------------
  const backendRaw = input['backend'] ?? defaults.backend;
  if (typeof backendRaw !== 'string' || !isBackendName(backendRaw)) {
    throw new InvalidIntent(
      `config (${source}): backend must be one of ${BACKEND_NAMES.join(' | ')}, got ${describe(backendRaw)}`,
    );
  }
  const backend: BackendName = backendRaw;

  // currency ---------------------------------------------------------------
  const currencyRaw = input['currency'] ?? defaults.currency;
  if (typeof currencyRaw !== 'string' || currencyRaw.trim() === '') {
    throw new InvalidIntent(
      `config (${source}): currency must be a non-empty string, got ${describe(currencyRaw)}`,
    );
  }
  const currency = currencyRaw.trim();

  // welcomeGrant -----------------------------------------------------------
  const welcomeGrantRaw = input['welcomeGrant'] ?? defaults.welcomeGrant;
  if (typeof welcomeGrantRaw !== 'string') {
    throw new InvalidIntent(
      `config (${source}): welcomeGrant must be a decimal string, got ${describe(welcomeGrantRaw)}`,
    );
  }
  parseAmount(welcomeGrantRaw, 'welcomeGrant'); // validate now, fail loudly here
  const welcomeGrant = welcomeGrantRaw.trim();

  // prices / rentalPerMinute -----------------------------------------------
  const prices = readAmountMap(input['prices'], 'prices', defaults.prices, source);
  const rentalPerMinute = readAmountMap(
    input['rentalPerMinute'],
    'rentalPerMinute',
    defaults.rentalPerMinute,
    source,
  );

  // entities ---------------------------------------------------------------
  const entities = readEntities(input['entities'] ?? defaults.entities, source);

  const config: HeistConfig = {
    backend,
    currency,
    welcomeGrant,
    prices,
    rentalPerMinute,
    entities,
  };

  // dbPath — optional, and under exactOptionalPropertyTypes it must be omitted
  // entirely rather than set to undefined.
  const dbPathRaw = input['dbPath'];
  if (dbPathRaw !== undefined && dbPathRaw !== null) {
    if (typeof dbPathRaw !== 'string' || dbPathRaw.trim() === '') {
      throw new InvalidIntent(
        `config (${source}): dbPath must be a non-empty string when present, got ${describe(dbPathRaw)}`,
      );
    }
    config.dbPath = dbPathRaw;
  }
  if (backend === 'sqlite' && config.dbPath === undefined) {
    throw new InvalidIntent(`config (${source}): backend "sqlite" requires dbPath`);
  }

  return config;
}

function readAmountMap(
  raw: unknown,
  field: string,
  fallback: Record<string, string>,
  source: string,
): Record<string, string> {
  if (raw === undefined || raw === null) return { ...fallback };
  if (!isRecord(raw)) {
    throw new InvalidIntent(
      `config (${source}): ${field} must be an object of key -> decimal string, got ${describe(raw)}`,
    );
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.trim() === '') {
      throw new InvalidIntent(`config (${source}): ${field} has an empty key`);
    }
    if (typeof value !== 'string') {
      throw new InvalidIntent(
        `config (${source}): ${field}.${key} must be a decimal string, got ${describe(value)}. ` +
          `Quote money values — JSON numbers are floats.`,
      );
    }
    parseAmount(value, `${field}.${key}`);
    out[key] = value.trim();
  }
  return out;
}

function readEntities(raw: unknown, source: string): EntityConfig[] {
  if (!Array.isArray(raw)) {
    throw new InvalidIntent(
      `config (${source}): entities must be an array, got ${describe(raw)}`,
    );
  }
  if (raw.length === 0) {
    throw new InvalidIntent(`config (${source}): entities must not be empty`);
  }

  const out: EntityConfig[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < raw.length; i++) {
    const item: unknown = raw[i];
    if (!isRecord(item)) {
      throw new InvalidIntent(
        `config (${source}): entities[${i}] must be an object like { "id": "hospital" }, got ${describe(item)}`,
      );
    }
    const id = item['id'];
    if (typeof id !== 'string' || id.trim() === '') {
      throw new InvalidIntent(
        `config (${source}): entities[${i}].id must be a non-empty string, got ${describe(id)}`,
      );
    }
    const trimmedId = id.trim();
    if (seen.has(trimmedId)) {
      throw new InvalidIntent(`config (${source}): duplicate entity id "${trimmedId}"`);
    }
    seen.add(trimmedId);

    const entity: EntityConfig = { id: trimmedId };

    const name = item['name'];
    if (name !== undefined && name !== null) {
      if (typeof name !== 'string' || name.trim() === '') {
        throw new InvalidIntent(
          `config (${source}): entities[${i}].name must be a non-empty string when present, got ${describe(name)}`,
        );
      }
      entity.name = name.trim();
    }

    out.push(entity);
  }

  // The one entity the engine cannot synthesise: mints originate here and fines
  // land here. Without it OpenAccount and Fine have nowhere to point.
  if (!seen.has(TREASURY_ID)) {
    throw new InvalidIntent(
      `config (${source}): entities must include "${TREASURY_ID}" — it is the mint source for ` +
        `welcome grants and payouts and the payee for fines.`,
    );
  }

  return out;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBackendName(value: string): value is BackendName {
  return (BACKEND_NAMES as readonly string[]).includes(value);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'string' ? JSON.stringify(value) : `${typeof value} (${String(value)})`;
}
