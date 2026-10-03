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

  test('sqlite without a dbPath is a typed error', () => {
    assert.throws(
      () => createBackend({ ...defaultConfig(), backend: 'sqlite' }),
      (e: unknown) => e instanceof EngineError && e.code === 'BACKEND_UNAVAILABLE',
    );
  });

  test('backends that do not exist yet are refused, not downgraded', () => {
    for (const backend of ['postgres', 'solana'] as BackendName[]) {
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
