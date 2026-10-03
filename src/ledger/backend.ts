// The one interface every ledger backend implements. Postgres, SQLite, memory,
// and Solana all sit behind exactly this — that swappability is the
// whole architectural bet, so nothing may leak backend specifics through it.

import type { Memo, Tx, TxRef, Wallet, WalletId, OwnerId } from '../types.ts';
import type { Checkpoint, CheckpointStatus, Violation } from './hashchain.ts';

export type { Checkpoint, CheckpointStatus, Violation };

export type BackendName = 'memory' | 'sqlite' | 'postgres' | 'solana';

export interface CreateWalletOptions {
  isEntity?: boolean;
}

/**
 * The public half of a wallet's keypair, minted by Custody and handed to the backend.
 *
 * Backends MUST NOT generate, derive, or store private key material. They receive the
 * public half only. Custody owns the secret half; the ledger stores what is safe to
 * publish. Any backend that generates its own keypair produces a pubkey nothing can
 * sign for, so signatures would never verify against the chain.
 */
export interface WalletKeyInfo {
  /** ed25519 public key, hex. */
  pubkey: string;
  /** Display address derived from the pubkey. */
  address: string;
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
  /**
   * Rows that hash correctly but break a ledger rule (mint with a source, amount <= 0, overdraft,
   * unknown wallet, malformed memo, replay-guard rows that no longer match the ledger). Empty when ok.
   */
  violations: Violation[];
  /** The chain's current head, or null when empty. Export it and hand it back later. */
  head: Checkpoint | null;
  /**
   * How the ledger compares with the checkpoint passed to verifyIntegrity: 'none' if none was
   * given, 'ok', 'truncated' (fewer txs than the checkpoint saw) or 'rewritten' (same position,
   * different hash). Only a checkpoint kept OUTSIDE the ledger can catch a cut-off tail.
   */
  checkpoint: CheckpointStatus;
}

export interface LedgerBackend {
  readonly name: BackendName;

  /** Create tables/indexes if absent. Safe to call repeatedly. */
  init(): Promise<void>;
  close(): Promise<void>;

  /**
   * Persist a wallet for `ownerId` using a keypair minted by Custody.
   * Idempotent per owner: calling twice returns the existing wallet rather than throwing.
   */
  createWallet(ownerId: OwnerId, key: WalletKeyInfo, opts?: CreateWalletOptions): Promise<Wallet>;
  getWallet(id: WalletId): Promise<Wallet | null>;
  getWalletByOwner(ownerId: OwnerId): Promise<Wallet | null>;
  listWallets(): Promise<Wallet[]>;

  getBalance(id: WalletId): Promise<bigint>;

  /**
   * All three writes validate the memo (`validateMemo`) and reject an amount that is not a
   * positive bigint. A `memo.nonce` or `memo.key` that is already used throws DuplicateNonce /
   * DuplicateKey, atomically with the write.
   */
  transfer(from: WalletId, to: WalletId, amount: bigint, memo: Memo): Promise<TxRef>;
  /** Admin-only: money enters the world. */
  mint(to: WalletId, amount: bigint, memo: Memo): Promise<TxRef>;
  /** Money leaves the world. */
  burn(from: WalletId, amount: bigint, memo: Memo): Promise<TxRef>;

  history(id: WalletId, cursor?: string, limit?: number): Promise<HistoryPage>;
  getTx(txId: string): Promise<Tx | null>;

  /** True if this nonce has already settled — the replay guard. */
  hasNonce(nonce: string): Promise<boolean>;
  /** The tx that consumed this nonce, so a replay can be answered with the original result. */
  getTxByNonce(nonce: string): Promise<Tx | null>;

  /** Walk the whole chain and verify hashes, structure and balances. Never throws on tampered data. */
  verifyIntegrity(expected?: Checkpoint): Promise<IntegrityReport>;
  /** The current head of the chain, to store somewhere the ledger's own writer cannot reach. */
  checkpoint(): Promise<Checkpoint | null>;
}
