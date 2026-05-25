import type { Adapter, AdapterCapabilities, DoctorReport, ExecOpts } from '../types';
import { ForgeEmitter } from '../../events';
import { isDriverInstalled, loadDriver } from '../missing-driver';
import {
  executePgCount,
  executePgDelete,
  executePgGroupBy,
  executePgInsert,
  executePgSelect,
  executePgUpdate,
  type PgExecOpts,
  type PgPoolHandle,
} from './execute';

// PostgresAdapter — Wave 2a shell.
//
// Lifecycle hooks (connect / close / doctor) work; the IR executor for
// Postgres lives in adapters/postgres/execute.ts (Wave 2b). Tests today
// exercise the SQL compiler directly via compile-from-ir.ts.
//
// The driver (`pg`) is lazy-required on connect; if it isn't installed we
// throw a ForgeMissingDriverError with the install command.

const CAPS: AdapterCapabilities = {
  nativeCascades: true,
  nativeUpsert: true,
  nullsOrdering: true,
  jsonPath: true,
  transactionsRequireReplicaSet: false,
};

interface PgPoolHandleWithEnd extends PgPoolHandle {
  end(): Promise<void>;
}

export class PostgresAdapter implements Adapter {
  readonly kind = 'postgres' as const;
  readonly capabilities = CAPS;
  readonly emitter = new ForgeEmitter();
  private _pool?: PgPoolHandleWithEnd;
  private _url?: string;

  async connect(url: string): Promise<void> {
    this._url = url;
    const pg = loadDriver('postgres', url);
    // Construct the pool. We do this lazily so the import of forge never
    // pulls pg into memory when the consumer is on a different adapter.
    this._pool = new pg.Pool({
      connectionString: url,
      max: 50,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
    // Probe the connection now so we surface auth/host errors at connect()
    // time, not on first query.
    await this._pool!.query('SELECT 1');
  }

  async close(): Promise<void> {
    if (!this._pool) return;
    await this._pool.end();
    this._pool = undefined;
  }

  async doctor(): Promise<DoctorReport> {
    const driver = isDriverInstalled('postgres');
    return {
      kind: 'postgres',
      driverPackage: 'pg',
      driverInstalled: driver.installed,
      driverVersion: driver.version,
      connectionString: this._url,
      capabilities: CAPS,
      notes: [
        'DDL migrations: forge:push generates and runs CREATE TABLE / ALTER for declared models (Wave 2c).',
        'Transactions: native BEGIN/COMMIT — no replica set required.',
        'Cascades: enforced by the DB engine via ON DELETE clauses on FK constraints.',
      ],
    };
  }

  // Internal accessor used by the Postgres executor (Wave 2b).
  get pool(): PgPoolHandleWithEnd {
    if (!this._pool) {
      throw new Error('[forge:postgres] pool accessed before connect() resolved');
    }
    return this._pool;
  }

  // ─── Executor surface ─────────────────────────────────────────────────
  // Delegates to the free functions in execute.ts. Same shape as MongoAdapter's
  // methods — both implement the Adapter interface so CollectionWrapper can
  // dispatch without caring which dialect is active.

  private pgOpts(opts?: ExecOpts): PgExecOpts {
    return opts?.session ? { client: opts.session as PgPoolHandle } : {};
  }

  // _track wraps an executor call with event emission when listeners exist.
  // When no listeners → fast path, zero added overhead. When subscribed → we
  // compile a second time just to capture sql/params for the event metadata
  // (compile is fast — μs scale — vs the query itself which is ms).
  private async _track<T>(
    op: 'select' | 'count' | 'groupBy' | 'insert' | 'update' | 'delete',
    node: any,
    model: any,
    exec: () => Promise<T>,
    countRows: (r: T) => number,
  ): Promise<T> {
    if (!this.emitter.hasListeners()) return exec();
    const { compileSelect, compileCount, compileGroupBy, compileInsert, compileUpdate, compileDelete } =
      await import('./compile-from-ir');
    const artifact =
      op === 'select'  ? compileSelect(node, model)  :
      op === 'count'   ? compileCount(node, model)   :
      op === 'groupBy' ? compileGroupBy(node, model) :
      op === 'insert'  ? compileInsert(node, model)  :
      op === 'update'  ? compileUpdate(node, model)  :
                         compileDelete(node, model);
    return this.emitter.track(
      { adapter: 'postgres', model: node.model ?? '', op, sql: artifact.sql, params: artifact.params },
      exec, countRows,
    );
  }

  executeSelect(node: any, model: any, opts?: ExecOpts) {
    return this._track('select', node, model,
      () => executePgSelect(this.pool, node, model, this.pgOpts(opts)),
      (r) => r.length);
  }
  executeCount(node: any, model: any, opts?: ExecOpts) {
    return this._track('count', node, model,
      () => executePgCount(this.pool, node, model, this.pgOpts(opts)),
      () => 1);
  }
  executeInsert(node: any, model: any, opts?: ExecOpts) {
    return this._track('insert', node, model,
      () => executePgInsert(this.pool, node, model, this.pgOpts(opts)),
      (r) => r.count);
  }
  executeUpdate(node: any, model: any, opts?: ExecOpts) {
    return this._track('update', node, model,
      () => executePgUpdate(this.pool, node, model, this.pgOpts(opts)),
      (r) => r.count);
  }
  executeDelete(node: any, model: any, opts?: ExecOpts) {
    return this._track('delete', node, model,
      () => executePgDelete(this.pool, node, model, this.pgOpts(opts)),
      (r) => r.count);
  }
  executeGroupBy(node: any, model: any, opts?: ExecOpts) {
    return this._track('groupBy', node, model,
      () => executePgGroupBy(this.pool, node, model, this.pgOpts(opts)),
      (r) => r.length);
  }

  // Wave 4b — native streaming. `pg-cursor` is the idiomatic path but optional
  // peer; fall back to a server-side cursor declared via SQL (DECLARE/FETCH)
  // when the helper isn't installed. The wrapper falls back to OFFSET/LIMIT
  // chunking if we return nothing.
  async *streamSelect(node: any, model: any, opts?: ExecOpts): AsyncIterable<any> {
    const { compileSelect } = await import('./compile-from-ir');
    const a = compileSelect(node, model);
    const client = await (this.pool as any).connect();
    try {
      await client.query('BEGIN');
      // Use a server-side cursor for back-pressure-friendly streaming.
      const cursorName = `forge_stream_${Date.now().toString(36)}`;
      await client.query(`DECLARE ${cursorName} CURSOR FOR ${a.sql}`, a.params);
      const FETCH_BATCH = 200;
      while (true) {
        const { rows } = await client.query(`FETCH ${FETCH_BATCH} FROM ${cursorName}`);
        if (rows.length === 0) break;
        for (const r of rows) yield r;
        if (rows.length < FETCH_BATCH) break;
      }
      await client.query(`CLOSE ${cursorName}`);
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* */ }
      throw err;
    } finally {
      client.release();
    }
  }
  async applyProjectionAndHydration(
    _rows: any[], _model: any,
    _node: { projection?: any; hydration?: any },
    _opts?: ExecOpts,
  ): Promise<void> {
    // PG's executePgSelect already applies projection/hydration inline (rows
    // come out of the SQL with the right columns; hydration happens after).
    // For write paths, the executor returns RETURNING * with all columns —
    // shaping happens in CollectionWrapper._returnOne via buildProjection.
    // No-op here; the wrapper layers projection/omit pruning client-side.
  }

  // ─── coerce / decode / cascade ────────────────────────────────────────
  //
  // PG semantics differ from Mongo enough to warrant per-field handling:
  //   • No id↔_id remap — PG columns map 1:1 with schema field names.
  //   • jsonb / embed / json columns: pg expects a string for parameterised
  //     inserts; we stringify on the way in.
  //   • Dates: pg accepts JS Date or ISO strings; we pass through.
  //   • Outbound: pg's type parsers already give us proper JS types
  //     (Date for timestamptz, boolean, number, arrays). Identity on the
  //     way out keeps the hot path branch-free.

  coerceInbound(model: any, data: any, _opts?: { forCreate?: boolean }) {
    if (!data || typeof data !== 'object') return data;
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(data)) {
      const field = model?.fields?.[k];
      if (field && (field.kind === 'json' || field.kind === 'embed' || field.kind === 'embedMany')
          && v != null && typeof v === 'object') {
        out[k] = JSON.stringify(v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  decodeOutbound(_model: any, row: any) {
    // pg's type coercion already turns timestamptz → Date, bool → boolean,
    // jsonb → parsed object, arrays → JS arrays. No-op here keeps the
    // hot path branch-free. Wave 2d may add `@db.Decimal(p,s)` decoding
    // (pg returns numeric as string for precision; we'd parse to BigDecimal).
    return row;
  }

  async applyCascadesForDelete(_model: any, _docs: any[], _opts?: ExecOpts): Promise<void> {
    // PG enforces ON DELETE CASCADE / SET NULL natively via FK constraints
    // generated by buildSchemaDDL. The wrapper still calls this on delete,
    // but for PG it's a no-op — the DB engine has already done the work.
  }

  // ─── Raw SQL escape hatches ───────────────────────────────────────────

  async $queryRaw(fragment: import('../../raw-sql').SqlFragment, opts?: ExecOpts): Promise<any[]> {
    const { compileSqlFragment } = await import('../../raw-sql');
    const { sql, params } = compileSqlFragment(fragment, 'postgres');
    const client = (opts?.session as PgPoolHandle | undefined) ?? this.pool;
    const { withPgErrors } = await import('./errors');
    const { rows } = await withPgErrors(() => client.query(sql, params));
    return rows;
  }

  async $executeRaw(fragment: import('../../raw-sql').SqlFragment, opts?: ExecOpts): Promise<number> {
    const { compileSqlFragment } = await import('../../raw-sql');
    const { sql, params } = compileSqlFragment(fragment, 'postgres');
    const client = (opts?.session as PgPoolHandle | undefined) ?? this.pool;
    const { withPgErrors } = await import('./errors');
    const { rowCount } = await withPgErrors(() => client.query(sql, params));
    return rowCount ?? 0;
  }

  // ─── $transaction (BEGIN/COMMIT/ROLLBACK) ─────────────────────────────
  // Borrows a client from the pool, opens a transaction, runs `fn`, commits
  // on success or rolls back on throw, and always returns the client to the
  // pool. Caller threads the client back through ExecOpts.session so every
  // executor call inside `fn` lands on the same connection.
  async $transaction<T>(fn: (session: unknown) => Promise<T>): Promise<T> {
    if (!this._pool) throw new Error('[forge:postgres] $transaction before connect()');
    // pg's Pool exposes connect() returning a PoolClient with release().
    const pool = this._pool as any;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* swallow rollback errors */ }
      throw err;
    } finally {
      if (typeof client.release === 'function') client.release();
    }
  }
}
