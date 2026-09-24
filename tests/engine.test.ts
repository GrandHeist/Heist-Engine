// The engine's behaviour suite, run over every ledger backend. Adding a backend means adding one
// entry here (and to conformance.test.ts).

import { MemoryBackend } from '../src/ledger/memory.ts';
import { SqliteBackend } from '../src/ledger/sqlite.ts';
import { engineSuite } from './engine.suite.ts';
import type { BackendFactory } from './engine.suite.ts';

const FACTORIES: readonly BackendFactory[] = [
  { label: 'MemoryBackend', create: () => new MemoryBackend() },
  // ':memory:' so the suite needs no files and no cleanup.
  { label: 'SqliteBackend', create: () => new SqliteBackend(':memory:') },
];

for (const factory of FACTORIES) engineSuite(factory);
