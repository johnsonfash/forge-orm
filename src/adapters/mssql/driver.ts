// SQL Server driver port + built-in wrapper for the `mssql` Node package
// (which itself wraps tedious). The driver takes positional params from the
// caller and re-binds them as named @p1, @p2 inputs on a Request object.

import type { AdapterKind } from '../types';

export interface MssqlQueryResult {
  rows: any[];
  rowCount?: number;
}

export interface MssqlDriver {
  readonly kind: Extract<AdapterKind, 'mssql'>;
  query(sql: string, params?: unknown[]): Promise<MssqlQueryResult>;
  transaction<T>(fn: (qc: MssqlQueryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface MssqlQueryable {
  query(sql: string, params?: unknown[]): Promise<MssqlQueryResult>;
}

/**
 * Built-in wrapper for the `mssql` Node package.
 *
 *   import sql from 'mssql';
 *   const pool = await sql.connect({ user, password, server, database });
 *   const db = await createDb({ schema, driver: mssqlDriver(pool) });
 *
 * Param-binding strategy: the dialect emits `@p1, @p2, …` placeholders.
 * The wrapper iterates the positional `params` array and binds each as
 * `request.input(`p${i+1}`, value)`. JS Date / boolean / null pass through
 * unchanged (mssql handles them natively).
 */
export function mssqlDriver(pool: any): MssqlDriver {
  const runQuery = async (sqlText: string, params?: unknown[]): Promise<MssqlQueryResult> => {
    const request = pool.request();
    if (params) {
      for (let i = 0; i < params.length; i++) {
        request.input(`p${i + 1}`, params[i]);
      }
    }
    const result = await request.query(sqlText);
    const rows = Array.isArray(result?.recordset) ? result.recordset : [];
    const rowCount = typeof result?.rowsAffected === 'object' && Array.isArray(result.rowsAffected)
      ? result.rowsAffected.reduce((s: number, n: number) => s + n, 0)
      : (result?.rowsAffected ?? rows.length);
    return { rows, rowCount };
  };
  return {
    kind: 'mssql',
    query: runQuery,
    async transaction(fn) {
      // mssql.Transaction takes the pool's connection and serialises queries.
      const tx = pool.transaction();
      await tx.begin();
      try {
        const out = await fn({
          query: async (sqlText: string, params?: unknown[]): Promise<MssqlQueryResult> => {
            const req = tx.request();
            if (params) {
              for (let i = 0; i < params.length; i++) {
                req.input(`p${i + 1}`, params[i]);
              }
            }
            const result = await req.query(sqlText);
            const rows = Array.isArray(result?.recordset) ? result.recordset : [];
            const rowCount = typeof result?.rowsAffected === 'object' && Array.isArray(result.rowsAffected)
              ? result.rowsAffected.reduce((s: number, n: number) => s + n, 0)
              : (result?.rowsAffected ?? rows.length);
            return { rows, rowCount };
          },
        });
        await tx.commit();
        return out;
      } catch (err) {
        try { await tx.rollback(); } catch { /* swallow */ }
        throw err;
      }
    },
    async close() {
      if (typeof pool?.close === 'function') {
        await pool.close();
      }
    },
  };
}

export function isMssqlDriver(v: unknown): v is MssqlDriver {
  return !!v && typeof v === 'object'
    && (v as any).kind === 'mssql'
    && typeof (v as any).query === 'function';
}
