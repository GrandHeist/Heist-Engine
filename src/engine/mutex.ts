// A minimal FIFO async mutex. The engine's intents read-then-write across several
// awaits (nonce check, balance/history reads, then the ledger append), so two
// intents in flight can both pass a check the other is about to invalidate.
// Running them one at a time is the simplest thing that is correct; a game
// economy server is nowhere near the throughput where a global lock matters.
//
// Scope: one process. Two engine processes sharing one database are NOT
// serialized by this — see docs/adr/0004.

export class Mutex {
  #tail: Promise<void> = Promise.resolve();

  /** Run `task` after every previously queued task has settled, success or failure. */
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(task);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
