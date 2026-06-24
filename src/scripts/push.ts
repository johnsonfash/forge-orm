/* eslint-disable no-console */
import * as dotenv from 'dotenv';
dotenv.config();

import { detectAdapterKind } from '../adapters/detect';
import { loadConsumerSchema } from './load-consumer-schema';

// Dialect-agnostic schema sync. Adapter is picked from DATABASE_URL.
// Schema resolution lives in load-consumer-schema.ts.
//
//   mongo    → idempotent index push
//   postgres → DDL diff + apply, with pg_advisory_xact_lock against races
//   mysql    → DDL apply
//   sqlite   → DDL apply

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

  const ENABLE_EXTENSIONS = process.argv.includes('--enable-extensions');

  const { schema, source } = loadConsumerSchema();
  console.log(`[forge:push] ${kind} — schema: ${source}`);

  // Phase 5 — extension auto-install. When the schema declares geoPoint
  // fields with `fallback: false` (the default), the relevant dialect needs
  // its spatial extension. We auto-install at push time when the user
  // passes `--enable-extensions`; otherwise we warn and continue (push will
  // fail with a clear DB-side error if the extension is missing).
  const needsSpatial = schemaNeedsSpatial(schema);
  if (needsSpatial && ENABLE_EXTENSIONS) {
    console.log(`[forge:push] schema requires spatial — will auto-install extension`);
  } else if (needsSpatial) {
    console.log(`[forge:push] schema declares geoPoint fields — pass --enable-extensions to auto-install the dialect's spatial extension (PostGIS / SpatiaLite). DuckDB auto-loads always.`);
  }

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
        if (needsSpatial && ENABLE_EXTENSIONS) {
          try {
            await pool.query('CREATE EXTENSION IF NOT EXISTS postgis');
            console.log(`[forge:push:pg] ✓ PostGIS ready`);
          } catch (err: any) {
            console.error(`[forge:push:pg] ✗ failed to install PostGIS: ${err?.message ?? err}`);
            console.error(`  (the role may lack CREATE EXTENSION privilege; ask a superuser to run it once)`);
            process.exit(2);
          }
        }
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

// Does any model in the schema declare a non-fallback geoPoint field?
// We use this to know whether we should auto-install the spatial extension.
function schemaNeedsSpatial(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return false;
  for (const model of Object.values(schema as Record<string, any>)) {
    if (!model?.fields) continue;
    for (const fdef of Object.values(model.fields as Record<string, any>)) {
      if (fdef?.kind === 'geoPoint' && !fdef.geo?.fallback) return true;
    }
  }
  return false;
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
