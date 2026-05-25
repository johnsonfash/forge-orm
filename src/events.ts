// Forge event system — pub/sub for query lifecycle events.
//
// Used for:
//   • Query logging (`db.$on('query', e => log.info(e.sql, e.duration_ms))`)
//   • Slow-query alerting
//   • OpenTelemetry span emission (Wave 4b helper subscribes here)
//   • Audit trails / replay capture
//
// Adapters call `emit('query', { ... })` after every executed statement. The
// event payload is intentionally adapter-agnostic — `sql` carries either SQL
// text or a description of the Mongo op (e.g. `"users.findOne"`), `params`
// carries either parameter values or the Mongo args object.

export interface QueryEvent {
  /** Adapter kind that ran the query. */
  adapter: 'mongo' | 'postgres' | 'mysql' | 'sqlite';
  /** Schema-key of the model the query is against (e.g. `'user'`), or '' for raw. */
  model: string;
  /**
   * Operation name. For SQL adapters: 'find' / 'findOne' / 'insert' / 'update' /
   * 'delete' / 'count' / 'groupBy' / 'raw'. For Mongo: the driver-level op name
   * ('find', 'insertOne', 'findOneAndUpdate', etc.).
   */
  op: string;
  /** SQL text (SQL adapters) or human description (Mongo). */
  sql: string;
  /** Parameter values (SQL) or Mongo args object. */
  params: unknown[] | Record<string, unknown>;
  /** Milliseconds wall-clock between dispatch and result. */
  duration_ms: number;
  /** Row count when returned by the driver (-1 if unknown). */
  rowCount: number;
  /** Server timestamp at start. */
  startedAt: Date;
}

export interface ErrorEvent {
  adapter: 'mongo' | 'postgres' | 'mysql' | 'sqlite';
  model: string;
  op: string;
  sql: string;
  params: unknown[] | Record<string, unknown>;
  error: Error;
  duration_ms: number;
}

export type EventListener<E> = (event: E) => void | Promise<void>;

// Lightweight pub/sub. Each adapter owns one Emitter instance; ForgeDb's
// $on/$off mirror onto it. We don't use Node's EventEmitter to keep the
// surface tight and zero-dependency on the Node API for users running
// forge in non-Node runtimes (Bun, edge workers) — though that's not a
// supported configuration yet, it costs nothing here.
export class ForgeEmitter {
  private queryListeners: EventListener<QueryEvent>[] = [];
  private errorListeners: EventListener<ErrorEvent>[] = [];

  on(event: 'query', cb: EventListener<QueryEvent>): () => void;
  on(event: 'error', cb: EventListener<ErrorEvent>): () => void;
  on(event: 'query' | 'error', cb: any): () => void {
    if (event === 'query') {
      this.queryListeners.push(cb);
      return () => { this.queryListeners = this.queryListeners.filter((l) => l !== cb); };
    }
    this.errorListeners.push(cb);
    return () => { this.errorListeners = this.errorListeners.filter((l) => l !== cb); };
  }

  off(event: 'query', cb: EventListener<QueryEvent>): void;
  off(event: 'error', cb: EventListener<ErrorEvent>): void;
  off(event: 'query' | 'error', cb: any): void {
    if (event === 'query') this.queryListeners = this.queryListeners.filter((l) => l !== cb);
    else this.errorListeners = this.errorListeners.filter((l) => l !== cb);
  }

  hasListeners(event?: 'query' | 'error'): boolean {
    if (event === 'query') return this.queryListeners.length > 0;
    if (event === 'error') return this.errorListeners.length > 0;
    return this.queryListeners.length > 0 || this.errorListeners.length > 0;
  }

  emitQuery(e: QueryEvent): void {
    for (const l of this.queryListeners) {
      try { void l(e); } catch { /* listener errors must not break queries */ }
    }
  }

  emitError(e: ErrorEvent): void {
    for (const l of this.errorListeners) {
      try { void l(e); } catch { /* same */ }
    }
  }

  /** Helper for adapters: time an async op, emit query+error events. */
  async track<T>(
    info: Omit<QueryEvent, 'duration_ms' | 'rowCount' | 'startedAt'>,
    op: () => Promise<T>,
    countRows: (r: T) => number = () => -1,
  ): Promise<T> {
    const startedAt = new Date();
    const t0 = performance.now();
    try {
      const result = await op();
      this.emitQuery({
        ...info,
        duration_ms: performance.now() - t0,
        rowCount: countRows(result),
        startedAt,
      });
      return result;
    } catch (err) {
      this.emitError({
        ...info,
        error: err as Error,
        duration_ms: performance.now() - t0,
      });
      throw err;
    }
  }
}
