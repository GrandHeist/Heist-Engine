// Engine tests. These run against MemoryBackend with defaultConfig(), because
// the conformance suite already proves the backends agree — anything that fails
// here is the intent router's own logic.

import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { defaultConfig, TREASURY_ID } from '../src/config/config.ts';
import { Custody } from '../src/engine/custody.ts';
import { EconomyEngine } from '../src/engine/engine.ts';
import { MemoryBackend } from '../src/ledger/memory.ts';
import type { EngineResponse, Intent, IntentFailure, IntentResult } from '../src/types.ts';

const RENTAL_ENTITY = 'bike-rental-co';
const WELCOME_GRANT = 500n;
const ADMIN = 'admin-42';

function testConfig() {
  return { ...defaultConfig(), admins: [ADMIN] };
}

let backend: MemoryBackend;
let custody: Custody;
let engine: EconomyEngine;
let nonceCounter = 0;

function nonce(tag: string): string {
  nonceCounter += 1;
  return `${tag}-${nonceCounter}`;
}

function expectOk(response: EngineResponse): IntentResult {
  assert.equal(
    response.ok,
    true,
    `expected success, got ${response.ok ? '' : `${response.code}: ${response.message}`}`,
  );
  assert.ok(response.ok);
  return response;
}

function expectFail(response: EngineResponse, code: string): IntentFailure {
  assert.equal(response.ok, false, `expected failure with code ${code}, got success`);
  assert.ok(!response.ok);
  assert.equal(response.code, code, `wrong failure code (message: ${response.message})`);
  assert.ok(response.message.length > 0, 'a failure must carry a human-readable message');
  return response;
}

async function balanceOf(owner: string): Promise<bigint> {
  const wallet = await backend.getWalletByOwner(owner);
  assert.ok(wallet !== null, `no wallet for ${owner}`);
  return await backend.getBalance(wallet.id);
}

/** Puts money into an entity's wallet directly, so payouts/refunds have a source. */
async function fundEntity(owner: string, amount: bigint): Promise<void> {
  const wallet = await backend.getWalletByOwner(owner);
  assert.ok(wallet !== null, `no wallet for entity ${owner}`);
  await backend.mint(wallet.id, amount, { intent: 'TestFunding', nonce: nonce('fund') });
}

async function openAccount(actor: string): Promise<IntentResult> {
  return expectOk(await engine.submit({ type: 'OpenAccount', nonce: nonce('open'), actor }));
}

beforeEach(async () => {
  backend = new MemoryBackend();
  custody = new Custody('memory');
  engine = new EconomyEngine({ backend, custody, config: testConfig() });
  await engine.init();
});

describe('EconomyEngine — init', () => {
  test('creates an entity wallet for every configured entity', async () => {
    for (const entity of defaultConfig().entities) {
      const wallet = await backend.getWalletByOwner(entity.id);
      assert.ok(wallet !== null, `missing wallet for ${entity.id}`);
      assert.equal(wallet.isEntity, true);
      assert.equal(await backend.getBalance(wallet.id), 0n);
    }
  });

  test('is idempotent — a second init creates no duplicate wallets', async () => {
    const before = (await backend.listWallets()).length;
    await engine.init();
    assert.equal((await backend.listWallets()).length, before);
  });
});

describe('EconomyEngine — happy paths for all 8 intents', () => {
  test('OpenAccount mints the welcome grant to a new player', async () => {
    const result = await openAccount('player-1');
    assert.equal(result.newBalance, WELCOME_GRANT);
    assert.match(result.hash, /^[0-9a-f]{64}$/);
    assert.ok(result.message.includes('500'));

    const tx = await backend.getTx(result.txId);
    assert.equal(tx?.kind, 'mint');
    assert.equal(tx?.from, null);
    assert.equal(tx?.memo.intent, 'OpenAccount');
    assert.equal(await balanceOf('player-1'), WELCOME_GRANT);
  });

  test('RentVehicle charges rate * minutes to the rental entity', async () => {
    await openAccount('player-1');

    const result = expectOk(
      await engine.submit({
        type: 'RentVehicle',
        nonce: nonce('rent'),
        actor: 'player-1',
        vehicle: 'bike',
        minutes: 30,
      }),
    );

    // bike is 1 HD/min in defaultConfig().
    assert.equal(result.newBalance, WELCOME_GRANT - 30n);
    assert.equal(await balanceOf(RENTAL_ENTITY), 30n);

    const tx = await backend.getTx(result.txId);
    assert.equal(tx?.kind, 'transfer');
    assert.equal(tx?.amount, 30n);
    assert.equal(tx?.memo.detail, 'bike — 30min');
  });

  test('RentVehicle prices a helicopter at its own rate', async () => {
    await openAccount('player-1');
    const result = expectOk(
      await engine.submit({
        type: 'RentVehicle',
        nonce: nonce('rent'),
        actor: 'player-1',
        vehicle: 'helicopter',
        minutes: 4,
      }),
    );
    assert.equal(result.newBalance, WELCOME_GRANT - 100n); // 25 * 4
  });

  test('ReturnVehicle refunds the unused minutes from the rental entity', async () => {
    await openAccount('player-1');
    await engine.submit({
      type: 'RentVehicle',
      nonce: nonce('rent'),
      actor: 'player-1',
      vehicle: 'bike',
      minutes: 30,
    });

    const result = expectOk(
      await engine.submit({
        type: 'ReturnVehicle',
        nonce: nonce('return'),
        actor: 'player-1',
        vehicle: 'bike',
        minutesUnused: 10,
      }),
    );

    assert.equal(result.newBalance, WELCOME_GRANT - 30n + 10n);
    assert.equal(await balanceOf(RENTAL_ENTITY), 20n);

    const tx = await backend.getTx(result.txId);
    assert.equal(tx?.amount, 10n);
    assert.equal(tx?.memo.intent, 'ReturnVehicle');
  });

  test('ReturnVehicle never refunds more than was paid for that vehicle', async () => {
    await openAccount('player-1');
    await fundEntity(RENTAL_ENTITY, 10_000n);

    await engine.submit({
      type: 'RentVehicle',
      nonce: nonce('rent'),
      actor: 'player-1',
      vehicle: 'bike',
      minutes: 10,
    });

    // Claim 999 unused minutes against a 10-minute rental.
    const result = expectOk(
      await engine.submit({
        type: 'ReturnVehicle',
        nonce: nonce('return'),
        actor: 'player-1',
        vehicle: 'bike',
        minutesUnused: 999,
      }),
    );

    assert.equal(result.newBalance, WELCOME_GRANT, 'refund must be capped at what was paid');
  });

  test('BuyService pays the configured entity price * units', async () => {
    await openAccount('player-1');

    const heal = expectOk(
      await engine.submit({
        type: 'BuyService',
        nonce: nonce('svc'),
        actor: 'player-1',
        service: 'hospital_full_heal',
      }),
    );
    assert.equal(heal.newBalance, WELCOME_GRANT - 200n);
    assert.equal(await balanceOf('hospital'), 200n);

    const fuel = expectOk(
      await engine.submit({
        type: 'BuyService',
        nonce: nonce('svc'),
        actor: 'player-1',
        service: 'gas_per_liter',
        units: 15,
      }),
    );
    assert.equal(fuel.newBalance, WELCOME_GRANT - 200n - 30n); // 2 * 15
    assert.equal(await balanceOf('gas-station-1'), 30n);
  });

  test('Payout moves money from the employer entity to the player', async () => {
    await openAccount('player-1');
    await fundEntity('pd-payroll', 1000n);

    const result = expectOk(
      await engine.submit({
        type: 'Payout',
        nonce: nonce('pay'),
        actor: 'player-1',
        employer: 'pd-payroll',
        amount: '250',
      }),
    );

    assert.equal(result.newBalance, WELCOME_GRANT + 250n);
    assert.equal(await balanceOf('pd-payroll'), 750n);
  });

  test('Fine moves money from the player to the treasury', async () => {
    await openAccount('player-1');

    const result = expectOk(
      await engine.submit({
        type: 'Fine',
        nonce: nonce('fine'),
        actor: 'player-1',
        amount: '75',
        reason: 'speeding',
      }),
    );

    assert.equal(result.newBalance, WELCOME_GRANT - 75n);
    assert.equal(await balanceOf(TREASURY_ID), 75n);
    assert.ok(result.message.includes('speeding'));
  });

  test('Transfer moves money player to player', async () => {
    await openAccount('player-1');
    await openAccount('player-2');

    const result = expectOk(
      await engine.submit({
        type: 'Transfer',
        nonce: nonce('xfer'),
        actor: 'player-1',
        to: 'player-2',
        amount: '120',
      }),
    );

    assert.equal(result.newBalance, WELCOME_GRANT - 120n);
    assert.equal(await balanceOf('player-2'), WELCOME_GRANT + 120n);
  });

  test('Theft moves money from the victim to the actor when authorized', async () => {
    await openAccount('robber');
    await openAccount('victim');

    const result = expectOk(
      await engine.submit({
        type: 'Theft',
        nonce: nonce('theft'),
        actor: 'robber',
        victim: 'victim',
        amount: '90',
        authorizedBy: ADMIN,
      }),
    );

    assert.equal(result.newBalance, WELCOME_GRANT + 90n);
    assert.equal(await balanceOf('victim'), WELCOME_GRANT - 90n);

    const tx = await backend.getTx(result.txId);
    assert.ok(tx?.memo.detail?.includes(ADMIN));
  });

  test('the whole run leaves the ledger verifiably intact', async () => {
    await openAccount('player-1');
    await openAccount('player-2');
    await fundEntity('pd-payroll', 1000n);
    await engine.submit({
      type: 'RentVehicle',
      nonce: nonce('rent'),
      actor: 'player-1',
      vehicle: 'car',
      minutes: 5,
    });
    await engine.submit({
      type: 'Transfer',
      nonce: nonce('xfer'),
      actor: 'player-1',
      to: 'player-2',
      amount: '10',
    });

    const report = await backend.verifyIntegrity();
    assert.equal(report.ok, true);
    assert.deepEqual(report.brokenAt, []);
    assert.deepEqual(report.balanceMismatches, []);
  });
});

describe('EconomyEngine — concurrency', () => {
  test('concurrent ReturnVehicle intents cannot double-refund one rental', async () => {
    await openAccount('player-1');
    await fundEntity(RENTAL_ENTITY, 10_000n);
    await engine.submit({
      type: 'RentVehicle',
      nonce: nonce('rent'),
      actor: 'player-1',
      vehicle: 'bike',
      minutes: 10,
    });

    const returns = await Promise.all(
      [1, 2, 3].map(() =>
        engine.submit({
          type: 'ReturnVehicle',
          nonce: nonce('return'),
          actor: 'player-1',
          vehicle: 'bike',
          minutesUnused: 10,
        }),
      ),
    );

    assert.equal(returns.filter((r) => r.ok).length, 1, 'exactly one refund may settle');
    assert.equal(await balanceOf('player-1'), WELCOME_GRANT, 'rented 10, refunded 10, once');
  });
});

/** Sum of every wallet balance: the money supply. Only mints and burns may change it. */
async function totalSupply(): Promise<bigint> {
  let total = 0n;
  for (const wallet of await backend.listWallets()) total += await backend.getBalance(wallet.id);
  return total;
}

describe('EconomyEngine — OpenAccount grants once per owner', () => {
  test('repeating OpenAccount with fresh nonces does not mint again', async () => {
    const first = await openAccount('player-1');
    assert.equal(first.newBalance, WELCOME_GRANT);

    for (let i = 0; i < 3; i++) {
      const again = await engine.submit({ type: 'OpenAccount', nonce: nonce('open'), actor: 'player-1' });
      const failure = expectFail(again, 'ACCOUNT_EXISTS');
      assert.ok(failure.message.includes('player-1'));
    }

    assert.equal(await balanceOf('player-1'), WELCOME_GRANT);
    assert.equal(await totalSupply(), WELCOME_GRANT, 'no extra HD may have been minted');
    const wallet = await backend.getWalletByOwner('player-1');
    assert.ok(wallet !== null);
    assert.equal((await backend.history(wallet.id)).txs.length, 1, 'exactly one grant on the ledger');
  });

  test('concurrent OpenAccount calls for one new owner grant exactly once', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        engine.submit({ type: 'OpenAccount', nonce: nonce('open'), actor: 'racer' }),
      ),
    );

    assert.equal(results.filter((r) => r.ok).length, 1, 'exactly one call may win');
    for (const r of results.filter((r) => !r.ok)) assert.equal(r.code, 'ACCOUNT_EXISTS');
    assert.equal(await balanceOf('racer'), WELCOME_GRANT);
    assert.equal(await totalSupply(), WELCOME_GRANT);
    assert.equal((await backend.listWallets()).filter((w) => w.ownerId === 'racer').length, 1);
  });

  test('an interrupted open (wallet written, no grant) is completed, once', async () => {
    const key = custody.createKeypair('half-open');
    await backend.createWallet('half-open', { pubkey: key.pubkey, address: key.address });

    const done = expectOk(
      await engine.submit({ type: 'OpenAccount', nonce: nonce('open'), actor: 'half-open' }),
    );
    assert.equal(done.newBalance, WELCOME_GRANT);
    expectFail(
      await engine.submit({ type: 'OpenAccount', nonce: nonce('open'), actor: 'half-open' }),
      'ACCOUNT_EXISTS',
    );
    assert.equal(await balanceOf('half-open'), WELCOME_GRANT);
  });
});

describe('EconomyEngine — entity ids are not players', () => {
  const ENTITY_IDS = defaultConfig().entities.map((e) => e.id);

  /** Every player-intent shape, parameterised by the id put in the position under test. */
  function intentsWithActor(id: string): Intent[] {
    return [
      { type: 'OpenAccount', nonce: nonce('e'), actor: id },
      { type: 'RentVehicle', nonce: nonce('e'), actor: id, vehicle: 'bike', minutes: 5 },
      { type: 'ReturnVehicle', nonce: nonce('e'), actor: id, vehicle: 'bike', minutesUnused: 5 },
      { type: 'BuyService', nonce: nonce('e'), actor: id, service: 'hospital_full_heal' },
      { type: 'Payout', nonce: nonce('e'), actor: id, employer: 'pd-payroll', amount: '50' },
      { type: 'Fine', nonce: nonce('e'), actor: id, amount: '50' },
      { type: 'Transfer', nonce: nonce('e'), actor: id, to: 'player-1', amount: '50' },
      { type: 'Theft', nonce: nonce('e'), actor: id, victim: 'player-1', amount: '50', authorizedBy: ADMIN },
    ];
  }

  test('no entity id may be the actor of any player intent, and no HD moves', async () => {
    await openAccount('player-1');
    for (const id of ENTITY_IDS) await engine.fundEntity(id, '1000', nonce('fund'));
    const supply = await totalSupply();
    const before = new Map<string, bigint>();
    for (const w of await backend.listWallets()) before.set(w.id, await backend.getBalance(w.id));

    for (const id of ENTITY_IDS) {
      for (const intent of intentsWithActor(id)) {
        expectFail(await engine.submit(intent), 'NOT_AUTHORIZED');
      }
    }

    assert.equal(await totalSupply(), supply);
    for (const w of await backend.listWallets()) {
      assert.equal(await backend.getBalance(w.id), before.get(w.id), `${w.ownerId} balance moved`);
    }
  });

  test('no entity id may be the recipient of a Transfer or the victim of a Theft', async () => {
    await openAccount('player-1');
    for (const id of ENTITY_IDS) {
      await engine.fundEntity(id, '1000', nonce('fund'));
      expectFail(
        await engine.submit({ type: 'Transfer', nonce: nonce('e'), actor: 'player-1', to: id, amount: '10' }),
        'NOT_AUTHORIZED',
      );
      expectFail(
        await engine.submit({
          type: 'Theft',
          nonce: nonce('e'),
          actor: 'player-1',
          victim: id,
          amount: '10',
          authorizedBy: ADMIN,
        }),
        'NOT_AUTHORIZED',
      );
      assert.equal(await balanceOf(id), 1000n, `${id} must not have been drained or credited`);
    }
    assert.equal(await balanceOf('player-1'), WELCOME_GRANT);
  });

  test('a different casing of an entity id is reserved too', async () => {
    for (const id of ['Treasury', 'TREASURY', 'Bike-Rental-Co']) {
      expectFail(await engine.submit({ type: 'OpenAccount', nonce: nonce('e'), actor: id }), 'NOT_AUTHORIZED');
    }
    assert.equal((await backend.listWallets()).filter((w) => !w.isEntity).length, 0);
  });

  test('padded and control-character ids are rejected as malformed', async () => {
    for (const id of [' treasury', 'treasury ', 'a\nb', 'x'.repeat(129)]) {
      expectFail(await engine.submit({ type: 'OpenAccount', nonce: nonce('e'), actor: id }), 'INVALID_INTENT');
    }
  });

  test('init refuses to start over a player wallet that sits on an entity id', async () => {
    const otherBackend = new MemoryBackend();
    const key = custody.createKeypair('casino-house');
    await otherBackend.createWallet('casino-house', { pubkey: key.pubkey, address: key.address });
    const config = { ...testConfig(), entities: [...testConfig().entities, { id: 'casino-house' }] };
    const clashing = new EconomyEngine({ backend: otherBackend, custody, config });
    await assert.rejects(clashing.init(), (e: unknown) => {
      assert.equal((e as { code?: string }).code, 'ENTITY_ID_CONFLICT');
      return true;
    });
  });
});

describe('EconomyEngine — Theft authorization', () => {
  async function steal(authorizedBy: string, actor = 'robber'): Promise<EngineResponse> {
    return await engine.submit({
      type: 'Theft',
      nonce: nonce('theft'),
      actor,
      victim: 'victim',
      amount: '50',
      authorizedBy,
    });
  }

  test('free-text authorization is refused; only the victim or a configured admin counts', async () => {
    await openAccount('robber');
    await openAccount('victim');

    expectFail(await steal('me-trust-me'), 'NOT_AUTHORIZED');
    expectFail(await steal('robber'), 'NOT_AUTHORIZED');
    assert.equal(await balanceOf('victim'), WELCOME_GRANT);

    expectOk(await steal('victim'));
    expectOk(await steal(ADMIN));
    assert.equal(await balanceOf('victim'), WELCOME_GRANT - 100n);
  });
});

describe('EconomyEngine — admin funding', () => {
  test('mints into an entity wallet so a fresh world can pay out', async () => {
    await openAccount('player-1');
    const funded = expectOk(await engine.fundEntity('pd-payroll', '1000', nonce('fund')));
    assert.equal(funded.newBalance, 1000n);

    const tx = await backend.getTx(funded.txId);
    assert.equal(tx?.kind, 'mint');
    assert.equal(tx?.memo.intent, 'AdminFund');

    const paid = expectOk(
      await engine.submit({
        type: 'Payout',
        nonce: nonce('pay'),
        actor: 'player-1',
        employer: 'pd-payroll',
        amount: '250',
      }),
    );
    assert.equal(paid.newBalance, WELCOME_GRANT + 250n);
  });

  test('is not an intent: submit cannot name it', async () => {
    const response = await engine.submit({
      type: 'AdminFund',
      nonce: nonce('x'),
      actor: 'player-1',
      entity: 'treasury',
      amount: '1000',
    } as unknown as Intent);
    expectFail(response, 'INVALID_INTENT');
    assert.equal(await balanceOf(TREASURY_ID), 0n);
  });

  test('only configured entities can be funded; players cannot', async () => {
    await openAccount('player-1');
    expectFail(await engine.fundEntity('player-1', '10', nonce('fund')), 'UNKNOWN_ENTITY');
    expectFail(await engine.fundEntity('nobody', '10', nonce('fund')), 'UNKNOWN_ENTITY');
    assert.equal(await balanceOf('player-1'), WELCOME_GRANT);
  });

  test('is replay-protected and validates the amount', async () => {
    expectOk(await engine.fundEntity('treasury', '100', 'fund-once'));
    expectFail(await engine.fundEntity('treasury', '100', 'fund-once'), 'DUPLICATE_NONCE');
    for (const amount of ['0', '-5', '1.5', 'abc', '']) {
      assert.equal((await engine.fundEntity('treasury', amount, nonce('fund'))).ok, false, amount);
    }
    assert.equal(await balanceOf('treasury'), 100n);
  });
});

describe('EconomyEngine — replay protection', () => {
  test('a replayed OpenAccount nonce does not double-grant', async () => {
    const first = expectOk(
      await engine.submit({ type: 'OpenAccount', nonce: 'fixed-nonce', actor: 'player-1' }),
    );
    assert.equal(first.newBalance, WELCOME_GRANT);

    const replay = await engine.submit({
      type: 'OpenAccount',
      nonce: 'fixed-nonce',
      actor: 'player-1',
    });
    expectFail(replay, 'DUPLICATE_NONCE');

    assert.equal(await balanceOf('player-1'), WELCOME_GRANT, 'the grant must not be paid twice');
    assert.equal((await backend.listWallets()).filter((w) => !w.isEntity).length, 1);
  });

  test('a replayed nonce from a different actor is still rejected', async () => {
    await openAccount('player-1');
    await openAccount('player-2');

    expectOk(
      await engine.submit({
        type: 'Transfer',
        nonce: 'shared-nonce',
        actor: 'player-1',
        to: 'player-2',
        amount: '10',
      }),
    );

    expectFail(
      await engine.submit({
        type: 'Transfer',
        nonce: 'shared-nonce',
        actor: 'player-2',
        to: 'player-1',
        amount: '10',
      }),
      'DUPLICATE_NONCE',
    );

    assert.equal(await balanceOf('player-1'), WELCOME_GRANT - 10n);
    assert.equal(await balanceOf('player-2'), WELCOME_GRANT + 10n);
  });
});

describe('EconomyEngine — rejections', () => {
  test('an unknown service reports UNKNOWN_ENTITY', async () => {
    await openAccount('player-1');
    expectFail(
      await engine.submit({
        type: 'BuyService',
        nonce: nonce('svc'),
        actor: 'player-1',
        service: 'not-a-real-service',
      }),
      'UNKNOWN_ENTITY',
    );
    assert.equal(await balanceOf('player-1'), WELCOME_GRANT);
  });

  test('an unknown employer reports UNKNOWN_ENTITY', async () => {
    await openAccount('player-1');
    expectFail(
      await engine.submit({
        type: 'Payout',
        nonce: nonce('pay'),
        actor: 'player-1',
        employer: 'no-such-employer',
        amount: '10',
      }),
      'UNKNOWN_ENTITY',
    );
  });

  test('Theft with an empty authorizedBy reports NOT_AUTHORIZED', async () => {
    await openAccount('robber');
    await openAccount('victim');

    for (const authorizedBy of ['', '   ']) {
      expectFail(
        await engine.submit({
          type: 'Theft',
          nonce: nonce('theft'),
          actor: 'robber',
          victim: 'victim',
          amount: '50',
          authorizedBy,
        }),
        'NOT_AUTHORIZED',
      );
    }

    assert.equal(await balanceOf('victim'), WELCOME_GRANT, 'no money may move without authority');
    assert.equal(await balanceOf('robber'), WELCOME_GRANT);
  });

  test('a Transfer to yourself reports INVALID_INTENT', async () => {
    await openAccount('player-1');
    expectFail(
      await engine.submit({
        type: 'Transfer',
        nonce: nonce('xfer'),
        actor: 'player-1',
        to: 'player-1',
        amount: '10',
      }),
      'INVALID_INTENT',
    );
    assert.equal(await balanceOf('player-1'), WELCOME_GRANT);
  });

  test('stealing from yourself reports INVALID_INTENT', async () => {
    await openAccount('player-1');
    expectFail(
      await engine.submit({
        type: 'Theft',
        nonce: nonce('theft'),
        actor: 'player-1',
        victim: 'player-1',
        amount: '10',
        authorizedBy: 'admin',
      }),
      'INVALID_INTENT',
    );
  });

  test('non-integer, zero and negative minutes report INVALID_INTENT', async () => {
    await openAccount('player-1');

    for (const minutes of [0, -5, 1.5, 0.1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expectFail(
        await engine.submit({
          type: 'RentVehicle',
          nonce: nonce('rent'),
          actor: 'player-1',
          vehicle: 'bike',
          minutes,
        }),
        'INVALID_INTENT',
      );
    }

    assert.equal(await balanceOf('player-1'), WELCOME_GRANT, 'no rental may have been charged');
    assert.equal(await balanceOf(RENTAL_ENTITY), 0n);
  });

  test('non-integer units on BuyService report INVALID_INTENT', async () => {
    await openAccount('player-1');
    expectFail(
      await engine.submit({
        type: 'BuyService',
        nonce: nonce('svc'),
        actor: 'player-1',
        service: 'gas_per_liter',
        units: 2.5,
      }),
      'INVALID_INTENT',
    );
    assert.equal(await balanceOf('player-1'), WELCOME_GRANT);
  });

  test('an unknown actor reports UNKNOWN_WALLET', async () => {
    expectFail(
      await engine.submit({
        type: 'Fine',
        nonce: nonce('fine'),
        actor: 'ghost-player',
        amount: '10',
      }),
      'UNKNOWN_WALLET',
    );
  });

  test('spending more than you hold reports INSUFFICIENT_FUNDS and moves nothing', async () => {
    await openAccount('player-1');
    expectFail(
      await engine.submit({
        type: 'Fine',
        nonce: nonce('fine'),
        actor: 'player-1',
        amount: '100000',
      }),
      'INSUFFICIENT_FUNDS',
    );
    assert.equal(await balanceOf('player-1'), WELCOME_GRANT);
    assert.equal(await balanceOf(TREASURY_ID), 0n);
  });

  test('fractional and non-numeric intent amounts are rejected', async () => {
    await openAccount('player-1');
    await openAccount('player-2');

    for (const amount of ['10.5', '-10', 'abc', '', '1e3', '0']) {
      const response = await engine.submit({
        type: 'Transfer',
        nonce: nonce('xfer'),
        actor: 'player-1',
        to: 'player-2',
        amount,
      });
      assert.equal(response.ok, false, `amount ${JSON.stringify(amount)} should be rejected`);
    }

    assert.equal(await balanceOf('player-1'), WELCOME_GRANT);
    assert.equal(await balanceOf('player-2'), WELCOME_GRANT);
  });
});

describe('EconomyEngine — submit never throws', () => {
  test('every malformed intent comes back as a typed failure, not an exception', async () => {
    await openAccount('player-1');

    const garbage: unknown[] = [
      null,
      undefined,
      {},
      'not an intent',
      42,
      [],
      { type: 'OpenAccount' },
      { type: 'OpenAccount', nonce: '', actor: 'player-1' },
      { type: 'OpenAccount', nonce: 'n', actor: '' },
      { type: 'OpenAccount', nonce: 'n', actor: 42 },
      { type: 'NotARealIntent', nonce: nonce('x'), actor: 'player-1' },
      { type: 'RentVehicle', nonce: nonce('x'), actor: 'player-1' },
      { type: 'RentVehicle', nonce: nonce('x'), actor: 'player-1', vehicle: '', minutes: 5 },
      { type: 'BuyService', nonce: nonce('x'), actor: 'player-1', service: null },
      { type: 'Payout', nonce: nonce('x'), actor: 'player-1', employer: '', amount: '5' },
      { type: 'Payout', nonce: nonce('x'), actor: 'player-1', employer: 'pd-payroll', amount: 5 },
      { type: 'Fine', nonce: nonce('x'), actor: 'player-1', amount: null },
      { type: 'Transfer', nonce: nonce('x'), actor: 'player-1', to: null, amount: '5' },
      { type: 'Theft', nonce: nonce('x'), actor: 'player-1', victim: 'ghost', amount: '5' },
      {
        type: 'ReturnVehicle',
        nonce: nonce('x'),
        actor: 'player-1',
        vehicle: 'bike',
        minutesUnused: -1,
      },
      {
        type: 'ReturnVehicle',
        nonce: nonce('x'),
        actor: 'player-1',
        vehicle: 'bike',
        minutesUnused: 5,
      },
    ];

    for (const candidate of garbage) {
      let response: EngineResponse;
      try {
        response = await engine.submit(candidate as Intent);
      } catch (error) {
        assert.fail(
          `submit() threw for ${JSON.stringify(candidate)}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      assert.equal(
        response.ok,
        false,
        `expected a failure for ${JSON.stringify(candidate)}, got success`,
      );
      assert.ok(!response.ok);
      assert.equal(typeof response.code, 'string');
      assert.ok(response.code.length > 0, 'every failure must carry a stable code');
      assert.equal(typeof response.message, 'string');
    }

    // Nothing above was allowed to move money.
    assert.equal(await balanceOf('player-1'), WELCOME_GRANT);
  });

  test('a backend that throws unexpectedly becomes code INTERNAL, not a rejection', async () => {
    const boom = new Error('disk on fire');
    const brokenBackend = new MemoryBackend();
    const brokenEngine = new EconomyEngine({
      backend: brokenBackend,
      custody: new Custody('memory'),
      config: defaultConfig(),
    });
    await brokenEngine.init();

    // A non-EngineError escaping the backend must still be caught by submit().
    brokenBackend.mint = async () => {
      throw boom;
    };

    const response = await brokenEngine.submit({
      type: 'OpenAccount',
      nonce: 'internal-1',
      actor: 'player-1',
    });
    expectFail(response, 'INTERNAL');
    assert.equal(response.message, 'disk on fire');
  });
});
