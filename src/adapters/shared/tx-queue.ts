// One connection, one transaction at a time. SQLite and DuckDB run every
// statement on a single connection, so a second BEGIN while one is open fails
// with "cannot start a transaction within a transaction". Queueing makes two
// concurrent transactions run one after the other instead.
export class TxQueue {
  private tail: Promise<void> = Promise.resolve();
  private depth = 0;

  get active(): boolean {
    return this.depth > 0;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    await prev;
    this.depth++;
    try {
      return await fn();
    } finally {
      this.depth--;
      release();
    }
  }
}
