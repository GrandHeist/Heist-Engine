// The one interface every ledger backend implements. Postgres, SQLite, memory,
// Solana and BNB Chain all sit behind exactly this — that swappability is the
// whole architectural bet, so nothing may leak backend specifics through it.

import type { Memo, Tx, TxRef, Wallet, WalletId, OwnerId } from '../types.ts';

export type BackendName = 'memory' | 'sqlite' | 'postgres' | 'solana' | 'bsc';

export interface CreateWalletOptions {
  isEntity?: boolean;
}

export interface HistoryPage {
  txs: Tx[];
  /** Opaque cursor for the next page, or null when the end is reached. */
  cursor: string | null;
}

export interface IntegrityReport {
  ok: boolean;
  checked: number;
  /** Sequence numbers where the hash chain does not verify. Empty when ok. */
  brokenAt: number[];
  /** Wallets whose folded history disagrees with the stored balance. */
  balanceMismatches: WalletId[];
}

export interface LedgerBackend {
  readonly name: BackendName;

  /** Create tables/indexes if absent. Safe to call repeatedly. */
  init(): Promise<void>;
  close(): Promise<void>;

  createWallet(ownerId: OwnerId, opts?: CreateWalletOptions): Promise<Wallet>;
  getWallet(id: WalletId): Promise<Wallet | null>;
  getWalletByOwner(ownerId: OwnerId): Promise<Wallet | null>;
  listWallets(): Promise<Wallet[]>;

  getBalance(id: WalletId): Promise<bigint>;

  transfer(from: WalletId, to: WalletId, amount: bigint, memo: Memo): Promise<TxRef>;
  /** Admin-only: money enters the world. */
  mint(to: WalletId, amount: bigint, memo: Memo): Promise<TxRef>;
  /** Money leaves the world. */
  burn(from: WalletId, amount: bigint, memo: Memo): Promise<TxRef>;

  history(id: WalletId, cursor?: string, limit?: number): Promise<HistoryPage>;
  getTx(txId: string): Promise<Tx | null>;

  /** True if this nonce has already settled — the replay guard. */
  hasNonce(nonce: string): Promise<boolean>;

  /** Walk the whole chain and verify hashes and balances. */
  verifyIntegrity(): Promise<IntegrityReport>;
}
