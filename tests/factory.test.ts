import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { defaultConfig } from '../src/config/config.ts';
import { EngineError } from '../src/errors.ts';
import type { BackendName } from '../src/ledger/backend.ts';
import { createBackend } from '../src/ledger/factory.ts';
import * as memoryModule from '../src/ledger/memory.ts';

describe('createBackend', () => {
  test('memory and sqlite come from the config', async () => {
    const memory = createBackend({ ...defaultConfig(), backend: 'memory' });
    assert.equal(memory.name, 'memory');

    const sqlite = createBackend({ ...defaultConfig(), backend: 'sqlite', dbPath: ':memory:' });
    assert.equal(sqlite.name, 'sqlite');
    await sqlite.init();
    await sqlite.close();
  });

  test('postgres comes from the config too, given a databaseUrl', () => {
    const postgres = createBackend({
      ...defaultConfig(),
      backend: 'postgres',
      databaseUrl: 'postgres://localhost/does-not-need-to-exist-for-this-assertion',
    });
    assert.equal(postgres.name, 'postgres');
    // Not init()'d here deliberately: constructing the backend must not touch the network.
    // The conformance suite is what actually connects and exercises it against real Postgres.
  });

  test('sqlite without a dbPath is a typed error', () => {
    assert.throws(
      () => createBackend({ ...defaultConfig(), backend: 'sqlite' }),
      (e: unknown) => e instanceof EngineError && e.code === 'BACKEND_UNAVAILABLE',
    );
  });

  test('postgres without a databaseUrl is a typed error', () => {
    assert.throws(
      () => createBackend({ ...defaultConfig(), backend: 'postgres' }),
      (e: unknown) => e instanceof EngineError && e.code === 'BACKEND_UNAVAILABLE',
    );
  });

  test('backends that do not exist yet are refused, not downgraded', () => {
    for (const backend of ['solana'] as BackendName[]) {
      assert.throws(
        () => createBackend({ ...defaultConfig(), backend }),
        (e: unknown) => e instanceof EngineError && e.code === 'BACKEND_UNAVAILABLE' && e.message.includes(backend),
        backend,
      );
    }
  });
});

describe('one address derivation', () => {
  test('MemoryBackend no longer carries its own (custody.ts is the only deriveAddress)', () => {
    assert.equal('deriveAddress' in memoryModule, false);
  });
});
