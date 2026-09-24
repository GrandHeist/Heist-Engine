// ===========================================================================
// STANDALONE SIMULATOR — the third Game Adapter (SPEC "Game Adapter").
// ===========================================================================
//
// FiveM has a Lua resource, RageMP has a JS package, and this is the adapter
// for no GTA server at all: a REPL that turns typed lines into Intents so the
// whole economy can be exercised, demoed and scripted without a game client.
//
// It obeys the same rule as every other adapter: IT NEVER TOUCHES BALANCES.
// Nothing here calls transfer/mint/burn, and nothing here prices anything.
// Every money move goes out as an Intent through `engine.submit()`, and the
// only thing this file does with the answer is render it. The backend is read
// directly for the pure-read commands (`bal`, `hist`, `wallets`, `verify`)
// because those move no money — an adapter is allowed to look, not to write.
//
// Zero dependencies: node:readline, node:crypto and the engine itself.
// ===========================================================================

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

import { fileURLToPath } from 'node:url';

import { loadConfig, validateConfig } from '../config/config.ts';
import type { HeistConfig } from '../config/config.ts';
import { EconomyEngine } from '../engine/engine.ts';
import { Custody } from '../engine/custody.ts';
import { createBackend } from '../ledger/factory.ts';
import type { Checkpoint, IntegrityReport, LedgerBackend } from '../ledger/backend.ts';
import type { EngineResponse, Intent, OwnerId, Tx, Wallet } from '../types.ts';

const DEFAULT_DB_PATH = './heist.sqlite';
/** The checked-in example config, used when --config is not given. */
const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../config/heist.config.json', import.meta.url));
const DEFAULT_HISTORY_LINES = 10;
const PROMPT = 'heist> ';
/** Entities `seed` tops up on an empty ledger so payouts and refunds have a source. */
const DEMO_FUNDED_ENTITIES = ['treasury', 'bike-rental-co', 'taxi-co', 'pd-payroll'];
const DEMO_FUNDING = '10000';

/** Command-line overrides. Anything left undefined comes from the config file. */
interface SimOptions {
  configPath: string;
  backend?: 'memory' | 'sqlite';
  dbPath?: string;
}

// ---------------------------------------------------------------------------
// Argv
// ---------------------------------------------------------------------------

function parseArgs(argv: readonly string[]): SimOptions {
  const options: SimOptions = { configPath: DEFAULT_CONFIG_PATH };

  for (const arg of argv) {
    if (arg.startsWith('--config=')) {
      const value = arg.slice('--config='.length).trim();
      if (value === '') throw new Error('--config needs a path, e.g. --config=./heist.config.json');
      options.configPath = value;
    } else if (arg.startsWith('--backend=')) {
      const value = arg.slice('--backend='.length);
      if (value !== 'memory' && value !== 'sqlite') {
        throw new Error(`--backend must be memory or sqlite, got "${value}"`);
      }
      options.backend = value;
    } else if (arg.startsWith('--db=')) {
      const value = arg.slice('--db='.length).trim();
      if (value === '') throw new Error('--db needs a path, e.g. --db=./heist.sqlite');
      options.dbPath = value;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else {
      throw new Error(
        `Unknown option "${arg}". Try --config=<path> --backend=memory|sqlite --db=<path>`,
      );
    }
  }

  return options;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const USAGE = [
  'commands',
  '  join   <player>                    open an account (welcome grant)',
  '  rent   <player> <vehicle> <mins>   rent a vehicle',
  '  return <player> <rental> <mins>    return a rental (tx id or unique prefix from `rent`), refunding unused minutes',
  '  buy    <player> <service> [units]  buy a catalog service',
  '  pay    <employer> <player> <amt>   employer pays a player',
  '  fine   <player> <amt>              player pays the treasury',
  '  send   <from> <to> <amt>           player to player',
  '  rob    <robber> <victim> <amt> <authorizedBy>   (authorizedBy: the victim, or a config admin)',
  '  fund   <entity> <amt>              ADMIN: mint HD into an entity wallet (not an intent)',
  '  bal    <owner>                     balance',
  '  hist   <owner> [n]                 recent history (default 10)',
  '  wallets                            list every wallet',
  '  verify                             verify the hash chain, structure, balances and saved checkpoint',
  '  seed                               fund the payout entities, create a couple of demo players',
  '  help                               this list',
  '  exit                               quit',
].join('\n');

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(message: string): void {
  out(`  ! ${message}`);
}

/** Amounts are always printed with the configured ticker, e.g. "120 HD". */
function money(config: HeistConfig, amount: bigint): string {
  return `${amount.toString()} ${config.currency}`;
}

/** Render an engine response. A failure is one line built from the stable code — never a stack. */
function render(config: HeistConfig, response: EngineResponse): void {
  if (!response.ok) {
    fail(`[${response.code}] ${response.message}`);
    return;
  }
  out(`  ok ${response.message}`);
  const balance = response.newBalance === null ? '(unavailable)' : money(config, response.newBalance);
  out(`     balance ${balance}  tx ${response.txId}${response.replayed === true ? '  (replayed)' : ''}`);
}

function renderTx(config: HeistConfig, tx: Tx, owners: ReadonlyMap<string, string>): void {
  const from = tx.from === null ? '(mint)' : (owners.get(tx.from) ?? tx.from);
  const to = tx.to === null ? '(burn)' : (owners.get(tx.to) ?? tx.to);
  const detail = tx.memo.detail === undefined ? '' : ` — ${tx.memo.detail}`;
  out(
    `  #${String(tx.seq).padStart(4, '0')} ${tx.memo.intent.padEnd(14)} ` +
      `${from} -> ${to}  ${money(config, tx.amount)}${detail}`,
  );
}

// ---------------------------------------------------------------------------
// Argument guards. Every one of these throws BadInput, which the REPL turns
// into a printed line and then carries on — bad input never kills the loop.
// ---------------------------------------------------------------------------

class BadInput extends Error {}

function arg(args: readonly string[], index: number, name: string, usage: string): string {
  const value = args[index];
  if (value === undefined || value.trim() === '') {
    throw new BadInput(`missing <${name}>. usage: ${usage}`);
  }
  return value.trim();
}

/** Money off the command line stays a STRING all the way into the intent. No floats, ever. */
function amountArg(args: readonly string[], index: number, name: string, usage: string): string {
  const raw = arg(args, index, name, usage);
  if (!/^\d+$/.test(raw)) {
    throw new BadInput(`<${name}> must be a whole number of HD, got "${raw}". usage: ${usage}`);
  }
  if (BigInt(raw) <= 0n) {
    throw new BadInput(`<${name}> must be greater than zero. usage: ${usage}`);
  }
  return raw;
}

/** Counts (minutes, units) are plain integers — validated here so the engine never sees a NaN. */
function countArg(args: readonly string[], index: number, name: string, usage: string): number {
  const raw = arg(args, index, name, usage);
  if (!/^\d+$/.test(raw)) {
    throw new BadInput(`<${name}> must be a whole number, got "${raw}". usage: ${usage}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new BadInput(`<${name}> must be a positive whole number. usage: ${usage}`);
  }
  return value;
}

function optionalCount(args: readonly string[], index: number, fallback: number): number {
  const raw = args[index];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^\d+$/.test(raw.trim())) {
    throw new BadInput(`expected a whole number, got "${raw.trim()}"`);
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new BadInput(`expected a positive whole number, got "${raw.trim()}"`);
  }
  return value;
}

/** Split a line into words, ignoring runs of whitespace. */
function tokenize(line: string): string[] {
  return line.trim().split(/\s+/).filter((part) => part !== '');
}

function renderReport(report: IntegrityReport): void {
  out(`  chain ${report.ok ? 'OK' : 'BROKEN'} — ${String(report.checked)} tx checked`);
  if (report.head !== null) out(`  head seq ${String(report.head.seq)} hash ${report.head.hash}`);
  if (report.brokenAt.length > 0) out(`  broken hashes at seq: ${report.brokenAt.join(', ')}`);
  if (report.balanceMismatches.length > 0) {
    out(`  balance mismatches: ${report.balanceMismatches.join(', ')}`);
  }
  for (const v of report.violations) {
    out(`  rule broken${v.seq === null ? '' : ` at seq ${String(v.seq)}`}: ${v.reason}`);
  }
  if (report.checkpoint === 'truncated' || report.checkpoint === 'rewritten') {
    out(`  saved checkpoint says the ledger was ${report.checkpoint}`);
  }
}

/** A checkpoint file we wrote ourselves; anything else in it is treated as absent, loudly. */
function readCheckpointFile(path: string): Checkpoint | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Number.isSafeInteger((parsed as { seq?: unknown }).seq) &&
      typeof (parsed as { hash?: unknown }).hash === 'string'
    ) {
      const { seq, hash } = parsed as Checkpoint;
      return { seq, hash };
    }
  } catch {
    // fall through
  }
  throw new Error(`checkpoint file ${path} is unreadable; move it aside to accept the current ledger`);
}

// ---------------------------------------------------------------------------
// The simulator
// ---------------------------------------------------------------------------

class Simulator {
  readonly #engine: EconomyEngine;
  readonly #backend: LedgerBackend;
  readonly #config: HeistConfig;
  readonly #checkpointFile: string | null;
  #checkpoint: Checkpoint | null;
  #running = true;

  constructor(
    engine: EconomyEngine,
    backend: LedgerBackend,
    config: HeistConfig,
    checkpointFile: string | null,
    checkpoint: Checkpoint | null,
  ) {
    this.#engine = engine;
    this.#backend = backend;
    this.#config = config;
    this.#checkpointFile = checkpointFile;
    this.#checkpoint = checkpoint;
  }

  get running(): boolean {
    return this.#running;
  }

  banner(interactive: boolean): void {
    out(
      `heist-engine sim — backend ${this.#backend.name}` +
        (this.#backend.name === 'sqlite' ? ` (${this.#config.dbPath ?? DEFAULT_DB_PATH})` : ''),
    );
    out(
      `currency ${this.#config.currency}, welcome grant ` +
        `${this.#config.welcomeGrant} ${this.#config.currency}, ` +
        `${String(this.#config.entities.length)} entities`,
    );
    out(interactive ? "type `help` for commands, `exit` to quit" : 'reading commands from stdin');
  }

  /** One line in, rendered output out. Never throws — that is the point of the REPL. */
  async handle(line: string): Promise<void> {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;

    const parts = tokenize(trimmed);
    const command = (parts[0] ?? '').toLowerCase();
    const args = parts.slice(1);

    try {
      await this.#dispatch(command, args);
    } catch (cause) {
      if (cause instanceof BadInput) {
        fail(cause.message);
        return;
      }
      // Anything else is rendered the same way: one line, no stack trace.
      fail(cause instanceof Error ? `[${cause.name}] ${cause.message}` : String(cause));
    }
  }

  async #dispatch(command: string, args: readonly string[]): Promise<void> {
    switch (command) {
      case 'join':
        return await this.#submit({
          type: 'OpenAccount',
          nonce: nonce(),
          actor: arg(args, 0, 'player', 'join <player>'),
        });

      case 'rent': {
        const usage = 'rent <player> <vehicle> <mins>';
        return await this.#submit({
          type: 'RentVehicle',
          nonce: nonce(),
          actor: arg(args, 0, 'player', usage),
          vehicle: arg(args, 1, 'vehicle', usage),
          minutes: countArg(args, 2, 'mins', usage),
        });
      }

      case 'return': {
        const usage = 'return <player> <rental> <mins>';
        const player = arg(args, 0, 'player', usage);
        return await this.#submit({
          type: 'ReturnVehicle',
          nonce: nonce(),
          actor: player,
          rentalId: await this.#resolveRental(player, arg(args, 1, 'rental', usage)),
          minutesUnused: countArg(args, 2, 'mins', usage),
        });
      }

      case 'buy': {
        const usage = 'buy <player> <service> [units]';
        const intent: Intent = {
          type: 'BuyService',
          nonce: nonce(),
          actor: arg(args, 0, 'player', usage),
          service: arg(args, 1, 'service', usage),
        };
        // exactOptionalPropertyTypes: omit `units` entirely rather than set undefined.
        if (args[2] !== undefined) intent.units = countArg(args, 2, 'units', usage);
        return await this.#submit(intent);
      }

      case 'pay': {
        const usage = 'pay <employer> <player> <amt>';
        return await this.#submit({
          type: 'Payout',
          nonce: nonce(),
          employer: arg(args, 0, 'employer', usage),
          actor: arg(args, 1, 'player', usage),
          amount: amountArg(args, 2, 'amt', usage),
        });
      }

      case 'fine': {
        const usage = 'fine <player> <amt>';
        return await this.#submit({
          type: 'Fine',
          nonce: nonce(),
          actor: arg(args, 0, 'player', usage),
          amount: amountArg(args, 1, 'amt', usage),
        });
      }

      case 'send': {
        const usage = 'send <from> <to> <amt>';
        return await this.#submit({
          type: 'Transfer',
          nonce: nonce(),
          actor: arg(args, 0, 'from', usage),
          to: arg(args, 1, 'to', usage),
          amount: amountArg(args, 2, 'amt', usage),
        });
      }

      case 'rob': {
        const usage = 'rob <robber> <victim> <amt> <authorizedBy>';
        return await this.#submit({
          type: 'Theft',
          nonce: nonce(),
          actor: arg(args, 0, 'robber', usage),
          victim: arg(args, 1, 'victim', usage),
          amount: amountArg(args, 2, 'amt', usage),
          authorizedBy: arg(args, 3, 'authorizedBy', usage),
        });
      }

      case 'fund': {
        const usage = 'fund <entity> <amt>';
        return this.#render(
          await this.#engine.fundEntity(
            arg(args, 0, 'entity', usage),
            amountArg(args, 1, 'amt', usage),
            nonce(),
          ),
        );
      }

      case 'bal':
        return await this.#balance(arg(args, 0, 'owner', 'bal <owner>'));

      case 'hist':
        return await this.#history(
          arg(args, 0, 'owner', 'hist <owner> [n]'),
          optionalCount(args, 1, DEFAULT_HISTORY_LINES),
        );

      case 'wallets':
        return await this.#wallets();

      case 'verify':
        return await this.#verify();

      case 'seed':
        return await this.#seed();

      case 'help':
        out(USAGE);
        return;

      case 'exit':
      case 'quit':
        this.#running = false;
        return;

      default:
        fail(`unknown command "${command}"`);
        out(USAGE);
        return;
    }
  }

  // -- intents -------------------------------------------------------------

  async #submit(intent: Intent): Promise<void> {
    this.#render(await this.#engine.submit(intent));
  }

  #render(response: EngineResponse): void {
    render(this.#config, response);
  }

  // -- reads ---------------------------------------------------------------

  async #requireWallet(owner: OwnerId): Promise<Wallet> {
    const wallet = await this.#backend.getWalletByOwner(owner);
    if (wallet === null) {
      throw new BadInput(`[UNKNOWN_WALLET] no wallet for "${owner}" — try \`join ${owner}\``);
    }
    return wallet;
  }

  /** A rental is a tx id; accept a unique prefix of one of the player's recent rentals too. */
  async #resolveRental(owner: OwnerId, given: string): Promise<string> {
    const wallet = await this.#requireWallet(owner);
    const page = await this.#backend.history(wallet.id, undefined, 500);
    const rentals = page.txs.filter((tx) => tx.memo.intent === 'RentVehicle' && tx.id.startsWith(given));
    if (rentals.length > 1) throw new BadInput(`"${given}" matches ${rentals.length} rentals; give more of the id`);
    return rentals[0]?.id ?? given;
  }

  async #balance(owner: OwnerId): Promise<void> {
    const wallet = await this.#requireWallet(owner);
    const balance = await this.#backend.getBalance(wallet.id);
    out(`  ${owner}: ${money(this.#config, balance)}  (${wallet.address})`);
  }

  async #history(owner: OwnerId, limit: number): Promise<void> {
    const wallet = await this.#requireWallet(owner);
    const page = await this.#backend.history(wallet.id, undefined, limit);
    if (page.txs.length === 0) {
      out(`  ${owner}: no transactions yet`);
      return;
    }
    const owners = await this.#ownerNames();
    out(`  ${owner}: last ${String(page.txs.length)} tx`);
    for (const tx of page.txs) renderTx(this.#config, tx, owners);
  }

  async #wallets(): Promise<void> {
    const wallets = await this.#backend.listWallets();
    if (wallets.length === 0) {
      out('  no wallets yet');
      return;
    }
    for (const wallet of wallets) {
      const balance = await this.#backend.getBalance(wallet.id);
      const kind = wallet.isEntity ? 'entity' : 'player';
      out(
        `  ${wallet.ownerId.padEnd(16)} ${kind}  ` +
          `${money(this.#config, balance).padStart(12)}  ${wallet.address}`,
      );
    }
  }

  async #verify(): Promise<void> {
    renderReport(await this.#backend.verifyIntegrity(this.#checkpoint ?? undefined));
  }

  // -- checkpoint sidecar ----------------------------------------------------
  // The head (seq + hash) is the only thing that reveals a chopped-off tail. It is kept in a file
  // next to a sqlite DB: enough to catch accidents and a careless edit, NOT a defence against
  // someone who can write both files. Real deployments should copy it somewhere the ledger's
  // writer cannot reach (another host, an append-only log, a public post).

  get checkpoint(): Checkpoint | null {
    return this.#checkpoint;
  }

  async saveCheckpoint(): Promise<void> {
    if (this.#checkpointFile === null) return;
    const head = await this.#backend.checkpoint();
    if (head === null) return;
    this.#checkpoint = head;
    writeFileSync(this.#checkpointFile, `${JSON.stringify(head)}\n`, 'utf8');
  }

  /** wallet id -> owner id, so history reads as names rather than uuids. */
  async #ownerNames(): Promise<Map<string, string>> {
    const wallets = await this.#backend.listWallets();
    return new Map(wallets.map((wallet) => [wallet.id, wallet.ownerId]));
  }

  // -- demo data -----------------------------------------------------------

  /**
   * Fund the entities that pay people (a fresh ledger has none), then open two demo players the
   * same way a real adapter would: an OpenAccount intent. Funding is the admin path, not an intent.
   */
  async #seed(): Promise<void> {
    for (const entity of DEMO_FUNDED_ENTITIES) {
      const wallet = await this.#backend.getWalletByOwner(entity);
      if (wallet === null || (await this.#backend.getBalance(wallet.id)) > 0n) continue;
      out(`  funding ${entity} with ${DEMO_FUNDING} ${this.#config.currency}`);
      this.#render(await this.#engine.fundEntity(entity, DEMO_FUNDING, nonce()));
    }
    for (const player of ['alice', 'bob']) {
      const existing = await this.#backend.getWalletByOwner(player);
      if (existing !== null) {
        out(`  ${player} already has an account`);
        continue;
      }
      out(`  seeding ${player}`);
      await this.#submit({ type: 'OpenAccount', nonce: nonce(), actor: player });
    }
  }
}

/** Fresh idempotency key per intent — the adapter is responsible for this, per SPEC. */
function nonce(): string {
  return randomUUID();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/** The config file, with any command-line overrides applied and the result re-validated. */
function buildConfig(options: SimOptions): HeistConfig {
  const merged: HeistConfig = { ...loadConfig(options.configPath) };
  if (options.backend !== undefined) merged.backend = options.backend;
  if (options.dbPath !== undefined) merged.dbPath = options.dbPath;
  if (merged.backend === 'sqlite' && merged.dbPath === undefined) merged.dbPath = DEFAULT_DB_PATH;
  return validateConfig(merged, 'sim options');
}

async function main(): Promise<number> {
  let options: SimOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (cause) {
    out(cause instanceof Error ? cause.message : String(cause));
    return 2;
  }

  let config: HeistConfig;
  let backend: LedgerBackend;
  try {
    config = buildConfig(options);
    backend = createBackend(config);
  } catch (cause) {
    out(`startup failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    return 1;
  }
  const engine = new EconomyEngine({
    backend,
    custody: new Custody(config.backend),
    config,
  });

  try {
    await engine.init();
  } catch (cause) {
    out(`startup failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    await backend.close();
    return 1;
  }

  // Verify before serving anything: a ledger that fails is not one to add rows to.
  const checkpointFile = config.backend === 'sqlite' ? `${config.dbPath ?? DEFAULT_DB_PATH}.head` : null;
  let saved: Checkpoint | null = null;
  try {
    saved = checkpointFile === null ? null : readCheckpointFile(checkpointFile);
    const report = await backend.verifyIntegrity(saved ?? undefined);
    if (!report.ok) {
      out('startup refused: the ledger failed verification');
      renderReport(report);
      await backend.close();
      return 1;
    }
  } catch (cause) {
    out(`startup failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    await backend.close();
    return 1;
  }

  const interactive = process.stdin.isTTY === true;
  const sim = new Simulator(engine, backend, config, checkpointFile, saved);
  sim.banner(interactive);
  await sim.saveCheckpoint();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: interactive,
  });
  if (interactive) {
    rl.setPrompt(PROMPT);
    rl.prompt();
  }

  // `for await` gives sequential, back-pressured line handling: one intent
  // settles before the next line is read, in a TTY and in a pipe alike.
  try {
    for await (const line of rl) {
      await sim.handle(line);
      await sim.saveCheckpoint();
      if (!sim.running) break;
      if (interactive) rl.prompt();
    }
  } finally {
    rl.close();
    await backend.close();
  }

  return 0;
}

const code = await main();
if (code !== 0) process.exitCode = code;
