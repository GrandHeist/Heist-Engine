// Config tests. The theme is that a bad economy config must fail at LOAD time,
// loudly, rather than mispay an entity or silently float a money value at
// runtime. See docs/adr/0002 for why numbers are refused outright.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { EngineError } from '../src/errors.ts';
import {
  TREASURY_ID,
  defaultConfig,
  loadConfig,
  parseAmount,
  priceOf,
  rentalRateOf,
  serviceOf,
  validateConfig,
} from '../src/config/config.ts';

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Writes `value` as JSON to a throwaway file and returns its path. */
function configFile(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'heist-config-'));
  tempDirs.push(dir);
  const path = join(dir, 'heist.config.json');
  writeFileSync(path, JSON.stringify(value), 'utf8');
  return path;
}

function throwsWithCode(fn: () => unknown, code: string, why: string): void {
  assert.throws(
    fn,
    (error: unknown) => {
      assert.ok(error instanceof EngineError, `${why}: expected an EngineError, got ${String(error)}`);
      assert.equal(error.code, code, why);
      return true;
    },
    why,
  );
}

/** Shallow-clone the default config so a test can corrupt one field. */
function withDefaults(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...(defaultConfig() as unknown as Record<string, unknown>), ...overrides };
}

describe('defaultConfig', () => {
  test('round-trips through validation unchanged', () => {
    const original = defaultConfig();
    assert.deepEqual(validateConfig(original), original);
  });

  test('round-trips through JSON and validation unchanged', () => {
    const original = defaultConfig();
    const viaJson: unknown = JSON.parse(JSON.stringify(original));
    assert.deepEqual(validateConfig(viaJson), original);
  });

  test('validation is idempotent', () => {
    const once = validateConfig(defaultConfig());
    assert.deepEqual(validateConfig(once), once);
  });

  test('every service points at a configured entity', () => {
    const config = defaultConfig();
    const ids = new Set(config.entities.map((e) => e.id));
    for (const [name, service] of Object.entries(config.services)) {
      assert.ok(ids.has(service.entity), `service ${name} points at unknown entity`);
    }
    assert.ok(ids.has(TREASURY_ID));
  });

  test('loads from disk through loadConfig', () => {
    const path = configFile(defaultConfig());
    assert.deepEqual(loadConfig(path), defaultConfig());
  });
});

describe('config — entities', () => {
  test('a config without a treasury throws', () => {
    const noTreasury = withDefaults({
      entities: [{ id: 'hospital' }],
      services: { hospital_full_heal: { entity: 'hospital', price: '200' } },
    });

    throwsWithCode(
      () => validateConfig(noTreasury),
      'INVALID_INTENT',
      'treasury is the mint source — its absence must be fatal',
    );
    assert.throws(() => validateConfig(noTreasury), /treasury/);
  });

  test('a config without a treasury throws at load time too', () => {
    const path = configFile(
      withDefaults({
        entities: [{ id: 'hospital' }],
        services: { hospital_full_heal: { entity: 'hospital', price: '200' } },
      }),
    );
    throwsWithCode(() => loadConfig(path), 'INVALID_INTENT', 'loadConfig must reject it too');
  });

  test('empty, non-array and duplicate entities are rejected', () => {
    throwsWithCode(
      () => validateConfig(withDefaults({ entities: [] })),
      'INVALID_INTENT',
      'empty entity list',
    );
    throwsWithCode(
      () => validateConfig(withDefaults({ entities: 'treasury' })),
      'INVALID_INTENT',
      'entities must be an array',
    );
    throwsWithCode(
      () =>
        validateConfig(
          withDefaults({ entities: [{ id: TREASURY_ID }, { id: TREASURY_ID }], services: {} }),
        ),
      'INVALID_INTENT',
      'duplicate entity id',
    );
    throwsWithCode(
      () => validateConfig(withDefaults({ entities: [{ id: '' }], services: {} })),
      'INVALID_INTENT',
      'empty entity id',
    );
  });
});

describe('config — services must resolve to a real entity AT LOAD TIME', () => {
  const broken = withDefaults({
    services: {
      taxi_ride: { entity: 'taxi-co-typo', price: '40' },
    },
  });

  test('validateConfig throws for a service pointing at an unconfigured entity', () => {
    throwsWithCode(
      () => validateConfig(broken),
      'INVALID_INTENT',
      'a mistyped payee must be a startup failure, never a runtime mispayment',
    );
  });

  test('the error names the offending service and the unknown entity', () => {
    assert.throws(() => validateConfig(broken), /taxi_ride/);
    assert.throws(() => validateConfig(broken), /taxi-co-typo/);
  });

  test('loadConfig throws for the same file — the failure is at load, not at use', () => {
    const path = configFile(broken);
    throwsWithCode(() => loadConfig(path), 'INVALID_INTENT', 'loadConfig must reject it');

    // And nothing partial escapes: there is no config object to call serviceOf on.
    let loaded: unknown;
    assert.throws(() => {
      loaded = loadConfig(path);
    });
    assert.equal(loaded, undefined);
  });

  test('a service pointing at a configured entity is accepted', () => {
    const ok = withDefaults({
      services: { taxi_ride: { entity: 'taxi-co', price: '40' } },
    });
    const config = validateConfig(ok);
    assert.deepEqual(serviceOf(config, 'taxi_ride'), { entity: 'taxi-co', price: 40n });
  });

  test('a malformed service entry is rejected', () => {
    for (const services of [
      { taxi_ride: 'taxi-co' },
      { taxi_ride: { price: '40' } },
      { taxi_ride: { entity: '', price: '40' } },
      { taxi_ride: { entity: 'taxi-co' } },
      { '': { entity: 'taxi-co', price: '40' } },
    ]) {
      throwsWithCode(
        () => validateConfig(withDefaults({ services })),
        'INVALID_INTENT',
        `malformed service entry ${JSON.stringify(services)}`,
      );
    }
  });
});

describe('config — money is never a JSON number', () => {
  test('a numeric welcomeGrant is rejected', () => {
    throwsWithCode(
      () => validateConfig(withDefaults({ welcomeGrant: 500 })),
      'INVALID_INTENT',
      'JSON numbers are floats — money must be quoted',
    );
  });

  test('a numeric price is rejected', () => {
    throwsWithCode(
      () => validateConfig(withDefaults({ prices: { bike_rental: 10 } })),
      'INVALID_INTENT',
      'prices.bike_rental as a number',
    );
  });

  test('a numeric rental rate is rejected', () => {
    throwsWithCode(
      () => validateConfig(withDefaults({ rentalPerMinute: { bike: 1 } })),
      'INVALID_INTENT',
      'rentalPerMinute.bike as a number',
    );
  });

  test('a numeric service price is rejected', () => {
    throwsWithCode(
      () =>
        validateConfig(
          withDefaults({ services: { hospital_full_heal: { entity: 'hospital', price: 200 } } }),
        ),
      'INVALID_INTENT',
      'services.hospital_full_heal.price as a number',
    );
  });

  test('the rejection survives a real JSON file — this is where floats would sneak in', () => {
    // 9007199254740993 cannot be represented as a double; JSON.parse would round it.
    const path = configFile({
      ...defaultConfig(),
      welcomeGrant: 9007199254740993,
    });
    throwsWithCode(() => loadConfig(path), 'INVALID_INTENT', 'numeric welcomeGrant on disk');
  });

  test('a quoted amount beyond 2^53 survives loading exactly', () => {
    const huge = '9007199254740993000';
    const path = configFile({ ...defaultConfig(), welcomeGrant: huge });
    const config = loadConfig(path);
    assert.equal(config.welcomeGrant, huge);
    assert.equal(parseAmount(config.welcomeGrant, 'welcomeGrant'), 9007199254740993000n);
  });
});

describe('config — fractional and malformed amounts', () => {
  test('a fractional price is rejected', () => {
    throwsWithCode(
      () => validateConfig(withDefaults({ prices: { bike_rental: '10.5' } })),
      'INVALID_INTENT',
      'HD is indivisible',
    );
    assert.throws(() => validateConfig(withDefaults({ prices: { bike_rental: '10.5' } })), /whole/);
  });

  test('a fractional service price is rejected', () => {
    throwsWithCode(
      () =>
        validateConfig(
          withDefaults({ services: { hospital_full_heal: { entity: 'hospital', price: '199.99' } } }),
        ),
      'INVALID_INTENT',
      'fractional service price',
    );
  });

  test('a fractional rental rate and welcome grant are rejected', () => {
    throwsWithCode(
      () => validateConfig(withDefaults({ rentalPerMinute: { bike: '0.5' } })),
      'INVALID_INTENT',
      'fractional rental rate',
    );
    throwsWithCode(
      () => validateConfig(withDefaults({ welcomeGrant: '500.01' })),
      'INVALID_INTENT',
      'fractional welcome grant',
    );
  });

  test('a zero fractional part is tolerated, as documented', () => {
    const config = validateConfig(withDefaults({ prices: { bike_rental: '10.00' } }));
    assert.equal(priceOf(config, 'bike_rental'), 10n);
  });

  test('negative and non-numeric amounts are rejected', () => {
    for (const bad of ['-1', '1e3', 'ten', '', ' ', '0x10', '1_000']) {
      throwsWithCode(
        () => validateConfig(withDefaults({ prices: { bike_rental: bad } })),
        'INVALID_INTENT',
        `price ${JSON.stringify(bad)}`,
      );
    }
  });
});

describe('config — lookups', () => {
  test('parseAmount reads whole values and rejects the rest', () => {
    assert.equal(parseAmount('0', 'x'), 0n);
    assert.equal(parseAmount('500', 'x'), 500n);
    assert.equal(parseAmount(' 500 ', 'x'), 500n);
    assert.equal(parseAmount('500.000', 'x'), 500n);
    assert.equal(parseAmount('9007199254740993000', 'x'), 9007199254740993000n);
    throwsWithCode(() => parseAmount('-1', 'x'), 'INVALID_INTENT', 'negative');
    throwsWithCode(() => parseAmount('1.5', 'x'), 'INVALID_INTENT', 'fractional');
  });

  test('unknown lookup keys throw rather than defaulting to zero', () => {
    const config = defaultConfig();
    throwsWithCode(() => serviceOf(config, 'nope'), 'UNKNOWN_ENTITY', 'unknown service');
    throwsWithCode(() => priceOf(config, 'nope'), 'INVALID_INTENT', 'unknown price key');
    throwsWithCode(() => rentalRateOf(config, 'nope'), 'INVALID_INTENT', 'unknown vehicle');
  });

  test('known lookup keys return bigints', () => {
    const config = defaultConfig();
    assert.equal(priceOf(config, 'bike_rental'), 10n);
    assert.equal(rentalRateOf(config, 'bike'), 1n);
    assert.equal(rentalRateOf(config, 'helicopter'), 25n);
    assert.deepEqual(serviceOf(config, 'gas_per_liter'), { entity: 'gas-station-1', price: 2n });
  });
});

describe('config — backend and dbPath', () => {
  test('an unknown backend is rejected', () => {
    throwsWithCode(
      () => validateConfig(withDefaults({ backend: 'mongodb' })),
      'INVALID_INTENT',
      'unknown backend name',
    );
  });

  test('the sqlite backend requires a dbPath', () => {
    throwsWithCode(
      () => validateConfig(withDefaults({ backend: 'sqlite' })),
      'INVALID_INTENT',
      'sqlite without dbPath',
    );
    const config = validateConfig(withDefaults({ backend: 'sqlite', dbPath: './heist.db' }));
    assert.equal(config.backend, 'sqlite');
    assert.equal(config.dbPath, './heist.db');
  });

  test('dbPath is omitted rather than set to undefined when absent', () => {
    const config = validateConfig(defaultConfig());
    assert.equal(Object.prototype.hasOwnProperty.call(config, 'dbPath'), false);
  });
});

describe('config — file errors', () => {
  test('an unreadable file throws CONFIG_UNREADABLE', () => {
    throwsWithCode(
      () => loadConfig(join(tmpdir(), 'definitely-not-here-heist.config.json')),
      'CONFIG_UNREADABLE',
      'missing file',
    );
  });

  test('malformed JSON throws CONFIG_MALFORMED', () => {
    const dir = mkdtempSync(join(tmpdir(), 'heist-config-'));
    tempDirs.push(dir);
    const path = join(dir, 'heist.config.json');
    writeFileSync(path, '{ not json', 'utf8');
    throwsWithCode(() => loadConfig(path), 'CONFIG_MALFORMED', 'bad JSON');
  });

  test('a non-object config throws', () => {
    throwsWithCode(() => loadConfig(configFile([1, 2, 3])), 'INVALID_INTENT', 'array config');
    throwsWithCode(() => loadConfig(configFile('nope')), 'INVALID_INTENT', 'string config');
  });

  test('the checked-in heist.config.json is valid', () => {
    const config = loadConfig(new URL('../src/config/heist.config.json', import.meta.url).pathname);
    assert.equal(config.currency.length > 0, true);
    const ids = new Set(config.entities.map((e) => e.id));
    assert.ok(ids.has(TREASURY_ID));
    for (const service of Object.values(config.services)) {
      assert.ok(ids.has(service.entity));
    }
  });
});
