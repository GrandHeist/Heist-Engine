// Builds the ledger backend a config asks for. Adapters and the sim go through this instead of
// naming a concrete class, so "swappable backend" is a config value rather than a code change.

import { EngineError } from '../errors.ts';
import type { HeistConfig } from '../config/config.ts';
import type { LedgerBackend } from './backend.ts';
import { MemoryBackend } from './memory.ts';
import { SqliteBackend } from './sqlite.ts';

/**
 * The backend for `config.backend`. Not yet initialised: the engine's `init()` does that.
 *
 * Only `memory` and `sqlite` exist. `postgres` and `solana` are valid names in config (so
 * the file format does not change when they land) but are refused here with a typed error, never
 * silently downgraded to something that would keep data in the wrong place.
 */
export function createBackend(config: HeistConfig): LedgerBackend {
  switch (config.backend) {
    case 'memory':
      return new MemoryBackend();
    case 'sqlite':
      if (config.dbPath === undefined) {
        throw new EngineError('BACKEND_UNAVAILABLE', 'backend "sqlite" needs a dbPath');
      }
      return new SqliteBackend(config.dbPath);
    case 'postgres':
    case 'solana':
      throw new EngineError(
        'BACKEND_UNAVAILABLE',
        `backend "${config.backend}" is not implemented. Available: memory, sqlite.`,
      );
  }
}
