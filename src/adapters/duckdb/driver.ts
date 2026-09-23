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
import { fromDriverBytes, isBytesInput, toBytes } from '../../bytes';

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
/**
 * Wrap bytes in DuckDB's own BLOB value.
 *
 * Resolved lazily and cached: `@duckdb/node-api` is an optional peer, and a
 * build that never touches DuckDB must not pull it in. Whenever this runs
 * the package IS present, because the caller had to import it to create the
 * connection they handed to `duckdbDriver`.
 */
let blobValueFn: ((b: Uint8Array) => unknown) | null | undefined;

function duckdbBlob(bytes: Uint8Array): unknown {
  if (blobValueFn === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const api = require('@duckdb/node-api') as {
        blobValue?: (b: Uint8Array) => unknown;
      };
      blobValueFn = typeof api.blobValue === 'function' ? api.blobValue : null;
    } catch {
      blobValueFn = null;
    }
  }
  if (!blobValueFn) {
    throw new Error(
      "[forge] writing f.bytes() on DuckDB needs '@duckdb/node-api' to export " +
        "blobValue(), which this installed version does not. The driver rejects a " +
        'raw Uint8Array or Buffer with "Cannot create values of type ANY", so ' +
        'there is no fallback — upgrade @duckdb/node-api.',
    );
  }
  return blobValueFn(bytes);
}

function coerceParam(v: unknown): unknown {
  if (v == null) return v;
  if (v instanceof Date) return v.toISOString();
  // Binary first: a Buffer is an object, and stringifying it stores the text
  // `{"type":"Buffer","data":[…]}` in a BLOB column instead of the bytes.
  //
  // Returning the bytes unchanged was not enough. The node bindings cannot
  // infer a type for a bare Uint8Array OR for a Buffer — both fail with
  // "Cannot create values of type ANY", so every f.bytes() write on DuckDB
  // threw. That went unnoticed because the adapter's driver was not
  // installed on the machine the bytes fix was written on, so this path was
  // only ever read, never run. `regression-duckdb-bytes.ts` runs it now.
  if (isBytesInput(v)) return duckdbBlob(toBytes(v));
  if (typeof v === 'object' && !Array.isArray(v)) return JSON.stringify(v);
  return v;
}

function coerceParams(params: unknown[] | undefined): unknown[] {
  if (!params) return [];
  return params.map(coerceParam);
}

/**
 * Hand back plain bytes, not DuckDB's wrapper.
 *
 * Reads of a BLOB column come back as a `DuckDBBlobValue`, so `f.bytes()`
 * returned an object with a `bytes` property where every other dialect
 * returns a `Uint8Array`. Unwrapped in the DRIVER rather than in a
 * per-field decode: the driver is what produces the wrapper, this adapter
 * has no field-aware decode step at all, and doing it here also covers raw
 * queries.
 *
 * `fromDriverBytes` leaves anything that is not a blob wrapper untouched,
 * so this is a no-op for normal columns.
 */
function unwrapBlobs(row: Record<string, unknown>): Record<string, unknown> {
  let copy: Record<string, unknown> | null = null;
  for (const k in row) {
    const v = row[k];
    if (v !== null && typeof v === 'object' && (v as { bytes?: unknown }).bytes instanceof Uint8Array) {
      copy ??= { ...row };
      copy[k] = fromDriverBytes(v);
    }
  }
  return copy ?? row;
}

export function duckdbDriver(connection: any): DuckdbDriver {
  const runQuery = async (sql: string, params?: unknown[]) => {
    const result = await connection.run(sql, coerceParams(params));
    try {
      const rows = await result.getRowObjects();
      return {
        rows: Array.isArray(rows) ? rows.map(unwrapBlobs) : [],
        rowCount: rows?.length,
      };
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
