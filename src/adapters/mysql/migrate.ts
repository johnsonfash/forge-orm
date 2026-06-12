import type { DDLStatement } from '../postgres/ddl';
import type { MysqlPool } from './execute';

// MySQL migration runner.
//
//   • Concurrent push serialised via `SELECT GET_LOCK('forge_migrate', 60)`.
//   • MySQL has no SAVEPOINT for DDL (DDL implicitly commits any open txn), so
//     statements run outside a wrapping txn — a mid-batch failure leaves prior
//     successes applied (same semantic as `prisma db push`).

export interface ApplyReport {
  applied: string[];
  skipped: string[];
  failures: { name: string; error: string }[];
}

const LOCK_NAME = 'forge_migrate';

export async function applyMigration(
  pool: MysqlPool,
  ddl: DDLStatement[],
  opts: { logger?: (line: string) => void } = {},
): Promise<ApplyReport> {
  const log = opts.logger ?? (() => {});
  const conn = await pool.getConnection();
  const applied: string[] = [];
  const skipped: string[] = [];
  const failures: ApplyReport['failures'] = [];

  try {
    const [lockRows]: any = await conn.query(`SELECT GET_LOCK(?, 60) AS got`, [LOCK_NAME]);
    if (!lockRows?.[0]?.got) {
      throw new Error('[forge:mysql] could not acquire migration lock — another push is running');
    }

    const [tableRows]: any = await conn.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE()`,
    );
    const existingTables = new Set<string>(tableRows.map((r: any) => r.TABLE_NAME));

    const [constraintRows]: any = await conn.query(
      `SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE()`,
    );
    const existingConstraints = new Set<string>(constraintRows.map((r: any) => r.CONSTRAINT_NAME));

    const [indexRows]: any = await conn.query(
      `SELECT DISTINCT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE()`,
    );
    const existingIndexes = new Set<string>(indexRows.map((r: any) => r.INDEX_NAME));

    for (const stmt of ddl) {
      const present = (() => {
        switch (stmt.kind) {
          case 'table':      return existingTables.has(stmt.name);
          case 'unique':
          case 'foreignKey':
          case 'check':      return existingConstraints.has(stmt.name);
          case 'index':      return existingIndexes.has(stmt.name);
        }
      })();
      if (present) {
        skipped.push(stmt.name);
        continue;
      }
      try {
        await conn.query(stmt.sql);
        applied.push(stmt.name);
        log(`  ✓ ${stmt.kind.padEnd(11)} ${stmt.name}`);
      } catch (err: any) {
        failures.push({ name: stmt.name, error: err?.message ?? String(err) });
        log(`  ✗ ${stmt.kind.padEnd(11)} ${stmt.name}  →  ${err?.message ?? err}`);
      }
    }

    await conn.query(`SELECT RELEASE_LOCK(?)`, [LOCK_NAME]);
  } finally {
    if (typeof conn.release === 'function') conn.release();
  }

  return { applied, skipped, failures };
}
