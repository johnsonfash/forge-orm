// DuckDB driver port + built-in wrapper for @duckdb/node-api.
//
// Same shape as the Postgres driver port — a `query` method + a `transaction`
// runner + a `close`. The built-in `duckdbDriver` wraps the official Node
// bindings; bring-your-own implementations satisfy the same interface.

export interface DuckdbQueryResult {
  rows: any[];
  /** Optional — driver may not know (DuckDB returns SELECT row counts but
   *  not DML row counts in every entrypoint). When undefined, executors
   *  fall back to result-array length. */
  rowCount?: number;
}

import type { AdapterKind } from '../types';

export interface DuckdbDriver {
  readonly kind: Extract<AdapterKind, 'duckdb'>;
  query(sql: string, params?: unknown[]): Promise<DuckdbQueryResult>;
  /** Begin a transaction. Caller invokes the callback with a queryable
   *  bound to the transaction; resolves on commit, rejects on rollback. */
  transaction<T>(fn: (qc: DuckdbQueryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface DuckdbQueryable {
  query(sql: string, params?: unknown[]): Promise<DuckdbQueryResult>;
}

/**
 * Built-in wrapper around `@duckdb/node-api` (DuckDB's official Node bindings).
 *
 *   import { DuckDBInstance } from '@duckdb/node-api';
 *   const instance = await DuckDBInstance.create('mydb.duckdb');
 *   const conn = await instance.connect();
 *   const db = await createDb({ schema, driver: duckdbDriver(conn) });
 *
 * Pass `:memory:` or an empty string to DuckDBInstance.create() for an
 * in-process DB — useful for tests + analytics workloads that don't need
 * persistence.
 */
// DuckDB's node bindings reject params it can't infer a type for (raw `null`,
// JS Date, JSON objects). We convert each to a token DuckDB knows how to
// parse:
//   • Date → ISO timestamp string (cast inside the query expression via the
//     driver's binding layer accepts ISO strings for TIMESTAMPTZ columns)
//   • null → DuckDB's NULL — pass through, but explicit-type bind helpers
//     wouldn't normally accept `null`; the Node API binds it correctly when
//     it's at the top level. We leave nulls alone.
//   • object/array (JSON) → JSON-stringify so the JSON column receives text.
function coerceParam(v: unknown): unknown {
  if (v == null) return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object' && !Array.isArray(v)) return JSON.stringify(v);
  return v;
}

function coerceParams(params: unknown[] | undefined): unknown[] {
  if (!params) return [];
  return params.map(coerceParam);
}

export function duckdbDriver(connection: any): DuckdbDriver {
  const runQuery = async (sql: string, params?: unknown[]) => {
    const result = await connection.run(sql, coerceParams(params));
    try {
      const rows = await result.getRowObjects();
      return { rows: Array.isArray(rows) ? rows : [], rowCount: rows?.length };
    } catch {
      // DDL / write statements without RETURNING — no rows. The Node API
      // throws getRowObjects() on those.
      return { rows: [] };
    }
  };
  return {
    kind: 'duckdb',
    query: runQuery,
    async transaction(fn) {
      await connection.run('BEGIN TRANSACTION');
      try {
        const out = await fn({ query: runQuery });
        await connection.run('COMMIT');
        return out;
      } catch (err) {
        try { await connection.run('ROLLBACK'); } catch { /* swallow rollback errors */ }
        throw err;
      }
    },
    async close() {
      if (typeof connection?.close === 'function') {
        await connection.close();
      }
    },
  };
}

export function isDuckdbDriver(v: unknown): v is DuckdbDriver {
  return !!v && typeof v === 'object'
    && typeof (v as any).query === 'function'
    && typeof (v as any).transaction === 'function';
}
