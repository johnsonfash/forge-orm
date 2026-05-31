/* eslint-disable no-console */
import * as dotenv from 'dotenv';
dotenv.config();

import { detectAdapterKind } from '../adapters/detect';
import { loadConsumerSchema } from './load-consumer-schema';

// forge:push — dialect-agnostic schema sync. Picks the right adapter from
// DATABASE_URL and runs the dialect-appropriate migrator against the
// consumer's schema (resolved via --schema=<path> / FORGE_SCHEMA_PATH /
// convention-path auto-detect — see load-consumer-schema.ts for the order).
//
//   • mongo    → idempotent index push
//   • postgres → DDL diff + apply, with pg_advisory_xact_lock so concurrent
//                runs serialise instead of racing
//   • mysql    → DDL apply
//   • sqlite   → DDL apply

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[forge:push] DATABASE_URL is not set.');
    process.exit(1);
  }
  const kind = detectAdapterKind(url);
  if (!kind) {
    console.error(`[forge:push] Could not infer adapter from URL prefix.`);
    process.exit(1);
  }

  // Resolve the consumer's schema ONCE up-front so every adapter sees the
  // same models. Falls back to forge's bundled sample with a loud warning if
  // no consumer schema is found — for forge's own monorepo dev/test runs only.
  const { schema, source } = loadConsumerSchema();
  console.log(`[forge:push] ${kind} — schema: ${source}`);

  switch (kind) {
    case 'mongo': {
      const { pushAllIndexes } = await import('../adapters/mongo/scripts/push');
      await pushAllIndexes(schema);
      return;
    }
    case 'postgres': {
      const [{ loadDriver }, { buildSchemaDDL }, { applyMigration, planMigration }] = await Promise.all([
        import('../adapters/missing-driver'),
        import('../adapters/postgres/ddl'),
        import('../adapters/postgres/migrate'),
      ]);
      const pg = loadDriver('postgres', url);
      const pool = new pg.Pool({ connectionString: url });
      try {
        const ddl = buildSchemaDDL(schema);
        const plan = await planMigration(pool, ddl);
        console.log(`[forge:push] ${plan.summary}`);
        const report = await applyMigration(pool, ddl, {
          plan,
          logger: (line) => console.log(line),
        });
        if (report.failures.length) {
          console.error(`[forge:push] ${report.failures.length} statement(s) failed:`);
          for (const f of report.failures) console.error(`  - ${f.name}: ${f.error}`);
          process.exit(2);
        }
        console.log(`[forge:push] applied ${report.applied.length}, skipped ${report.skipped.length}`);
      } finally {
        await pool.end();
      }
      return;
    }
    case 'mysql': {
      const [{ loadDriver }, { buildSchemaDDL }, { applyMigration }] = await Promise.all([
        import('../adapters/missing-driver'),
        import('../adapters/mysql/ddl'),
        import('../adapters/mysql/migrate'),
      ]);
      const mysql = loadDriver('mysql', url);
      const rawPool = mysql.createPool({ uri: url, connectionLimit: 5 });
      const pool = rawPool.promise ? rawPool.promise() : rawPool;
      try {
        const ddl = buildSchemaDDL(schema);
        const report = await applyMigration(pool, ddl, { logger: (line) => console.log(line) });
        if (report.failures.length) {
          console.error(`[forge:push] ${report.failures.length} statement(s) failed:`);
          for (const f of report.failures) console.error(`  - ${f.name}: ${f.error}`);
          process.exit(2);
        }
        console.log(`[forge:push] applied ${report.applied.length}, skipped ${report.skipped.length}`);
      } finally {
        if (pool.end) await pool.end();
      }
      return;
    }
    case 'sqlite': {
      const [{ loadDriver }, { buildSchemaDDL }, { applyMigration }] = await Promise.all([
        import('../adapters/missing-driver'),
        import('../adapters/sqlite/ddl'),
        import('../adapters/sqlite/migrate'),
      ]);
      const sqlite = loadDriver('sqlite', url);
      const Database = sqlite.default ?? sqlite;
      const filename = url
        .replace(/^sqlite:/, '')
        .replace(/^file:/, '');
      const db = new Database(filename === '' || filename === ':memory:' ? ':memory:' : filename);
      db.pragma('foreign_keys = ON');
      try {
        const ddl = buildSchemaDDL(schema);
        const report = await applyMigration(db, ddl, { logger: (line) => console.log(line) });
        if (report.failures.length) {
          console.error(`[forge:push] ${report.failures.length} statement(s) failed:`);
          for (const f of report.failures) console.error(`  - ${f.name}: ${f.error}`);
          process.exit(2);
        }
        console.log(`[forge:push] applied ${report.applied.length}, skipped ${report.skipped.length}`);
      } finally {
        db.close();
      }
      return;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
