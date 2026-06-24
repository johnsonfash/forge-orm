/* eslint-disable no-console */
import * as dotenv from 'dotenv';
dotenv.config();

import { detectAdapterKind, DRIVER_PACKAGE_FOR } from '../adapters/detect';
import { isDriverInstalled } from '../adapters/missing-driver';
import type { AdapterKind } from '../adapters/types';
import type { IndexDef, ModelDef } from '../schema/types';

// forge doctor — environment + schema check.
// Prints which drivers are installed, which adapter is inferred from
// DATABASE_URL, and (if a schema is found) lints every model for
// dialect mismatches and common index-feature gotchas.

async function main() {
  const ALL: AdapterKind[] = ['mongo', 'postgres', 'mysql', 'sqlite', 'duckdb', 'mssql'];
  const url = process.env.DATABASE_URL;
  const detected = url ? detectAdapterKind(url) : null;

  console.log('');
  console.log('Forge — environment check');
  console.log('');
  console.log('  Drivers installed:');
  for (const kind of ALL) {
    const info = isDriverInstalled(kind);
    const pkg = DRIVER_PACKAGE_FOR[kind];
    if (info.installed) {
      console.log(`    \x1b[32m✓\x1b[0m ${pkg.padEnd(16)} ${info.version}`);
    } else {
      console.log(`    \x1b[2m✗\x1b[0m ${pkg.padEnd(16)} not installed`);
    }
  }

  console.log('');
  console.log('  DATABASE_URL:');
  if (!url) {
    console.log('    \x1b[33m(not set)\x1b[0m — set in .env or pass createDb({ url })');
  } else {
    const redacted = url.replace(/(:\/\/[^:@/]+):([^@/]+)@/, '$1:****@');
    if (detected) {
      const info = isDriverInstalled(detected);
      const status = info.installed ? '\x1b[32m✓ driver installed\x1b[0m' : '\x1b[31m✗ driver missing\x1b[0m';
      console.log(`    ${redacted}  →  ${detected} adapter  (${status})`);
      if (!info.installed) {
        console.log(`    \x1b[33mAction:\x1b[0m npm install ${DRIVER_PACKAGE_FOR[detected]}`);
      }
    } else {
      console.log(`    ${redacted}  →  \x1b[31munknown prefix\x1b[0m`);
      console.log(`    \x1b[33mAction:\x1b[0m pass an explicit type to createDb({ type, url })`);
    }
  }
  console.log('');

  // Schema linting — best-effort. If the consumer doesn't have a schema in
  // a conventional location, skip silently; doctor stays useful for the
  // pure-env case.
  lintSchemaIfPresent(detected);

  // Live capability probe — connect (best-effort) and check for required
  // extensions / versions based on the schema we just linted.
  if (url && detected) {
    await probeLiveCapabilities(detected, url);
  }
}

interface LintFinding {
  level: 'warn' | 'info';
  model: string;
  message: string;
}

function lintSchemaIfPresent(adapter: AdapterKind | null): void {
  let loadConsumerSchema: (() => { schema: unknown; source: string }) | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('./load-consumer-schema');
    loadConsumerSchema = mod.loadConsumerSchema;
  } catch {
    return; // module missing at runtime — old install, skip.
  }
  if (!loadConsumerSchema) return;
  let result: { schema: unknown; source: string };
  try {
    result = loadConsumerSchema();
  } catch {
    return; // no schema found — skip.
  }
  const { schema, source } = result;
  if (!schema || typeof schema !== 'object') return;

  const findings: LintFinding[] = [];
  for (const [modelName, model] of Object.entries(schema as Record<string, unknown>)) {
    const m = model as Partial<ModelDef<Record<string, never>>>;
    if (!m?.indexes?.length) continue;
    for (const idx of m.indexes as IndexDef[]) {
      collectIndexFindings(modelName, idx, adapter, findings);
    }
  }

  console.log('  Schema lint:');
  console.log(`    source: ${source}`);
  if (!findings.length) {
    console.log('    \x1b[32m✓\x1b[0m no issues');
    console.log('');
    return;
  }
  for (const f of findings) {
    const sigil = f.level === 'warn' ? '\x1b[33m⚠\x1b[0m' : '\x1b[2m·\x1b[0m';
    console.log(`    ${sigil} [${f.model}] ${f.message}`);
  }
  console.log('');
}

function collectIndexFindings(
  modelName: string,
  idx: IndexDef,
  adapter: AdapterKind | null,
  out: LintFinding[],
): void {
  const w = (message: string) => out.push({ level: 'warn', model: modelName, message });
  const i = (message: string) => out.push({ level: 'info', model: modelName, message });
  const name = idx.name ?? '(unnamed)';

  // Mongo-only fields landing on a SQL adapter.
  const usesMongoOnly =
    idx.collation || idx.wildcardProjection ||
    Object.values(idx.keys ?? {}).some((k) => k === '2dsphere' || k === '2d' || k === 'hashed');
  if (usesMongoOnly && adapter && adapter !== 'mongo') {
    w(`index '${name}' uses Mongo-only fields (collation / wildcardProjection / '2dsphere'|'2d'|'hashed' keys) on a ${adapter} adapter — ignored at push.`);
  }

  // SQL-only fields landing on Mongo.
  const usesSqlOnly =
    idx.method && idx.method !== 'btree' ||
    idx.include?.length ||
    idx.expression ||
    idx.visible === false ||
    idx.parser ||
    (typeof idx.where === 'string');
  if (usesSqlOnly && adapter === 'mongo') {
    w(`index '${name}' uses SQL-only fields (method / include / expression / where-as-string / visible / parser) on a mongo adapter — ignored at push.`);
  }

  // Method mismatched with adapter.
  if (idx.method && adapter === 'postgres' && (idx.method === 'spatial' || idx.method === 'fulltext')) {
    w(`index '${name}' uses method='${idx.method}' — Postgres has no such access method. The push will fail at DB time. Use 'gist' (geometry) or to_tsvector + gin (fulltext).`);
  }
  if (idx.method && adapter === 'mysql' && ['gin', 'gist', 'brin', 'hash'].includes(idx.method)) {
    w(`index '${name}' uses method='${idx.method}' — MySQL has no such access method. The push will fail at DB time.`);
  }

  // Common extension prompts.
  if (adapter === 'postgres' && idx.method === 'gin' && !idx.expression) {
    i(`index '${name}' uses method='gin' — make sure the right opclass is installed (pg_trgm for trigram, btree_gin for scalar mixed, intarray, etc.). The push will fail with a clear error if the extension isn't installed.`);
  }
  if (adapter === 'postgres' && idx.method === 'brin') {
    i(`index '${name}' uses method='brin' — works best on tables in physical-order correlation with the indexed column (e.g. append-only event tables ordered by time).`);
  }

  // Parser on a non-fulltext index — already warned at push, but doctor
  // surfaces it earlier.
  if (idx.parser && idx.method !== 'fulltext') {
    w(`index '${name}' sets parser='${idx.parser}' but method is not 'fulltext'. Parser only takes effect on FULLTEXT indexes.`);
  }

  // Naming hygiene — explicit names make diff drift output meaningful.
  if (!idx.name) {
    i(`index over (${Object.keys(idx.keys ?? {}).join(', ') || idx.expression || '?'}) has no explicit name. forge generates one (idx_${modelName}_…), but a named index is easier to diff.`);
  }
}

// Live capability probe — uses the installed driver to query for extension
// availability + version. Best-effort: connection failures are reported,
// not raised.
async function probeLiveCapabilities(kind: AdapterKind, url: string): Promise<void> {
  console.log('  Live capability probe:');
  try {
    if (kind === 'postgres') {
      const pg = tryRequire('pg');
      if (!pg) return note('    (skip — pg driver not installed)');
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      const v = await client.query('SHOW server_version');
      console.log(`    \x1b[32m✓\x1b[0m Postgres ${String(v.rows[0]?.server_version ?? '?').trim()} reachable`);
      const ext = await client.query(
        `SELECT extname FROM pg_extension WHERE extname IN ('postgis','pg_trgm','btree_gin','btree_gist')`,
      );
      const have = new Set<string>(ext.rows.map((r: any) => String(r.extname)));
      reportExt(have, 'postgis', 'PostGIS', 'CREATE EXTENSION postgis;');
      reportExt(have, 'pg_trgm', 'pg_trgm (trigram search)', 'CREATE EXTENSION pg_trgm;');
      reportExt(have, 'btree_gin', 'btree_gin', 'CREATE EXTENSION btree_gin;');
      reportExt(have, 'btree_gist', 'btree_gist', 'CREATE EXTENSION btree_gist;');
      await client.end();
    } else if (kind === 'mysql') {
      const mysql = tryRequire('mysql2/promise');
      if (!mysql) return note('    (skip — mysql2 driver not installed)');
      const conn = await mysql.createConnection(url);
      const [vRows] = await conn.query('SELECT VERSION() AS v');
      const v = String((vRows as any[])[0]?.v ?? '');
      const isV8 = v.startsWith('8.') || v.startsWith('9.') || v.startsWith('10.');
      console.log(`    \x1b[32m✓\x1b[0m MySQL ${v} reachable`);
      if (!isV8) {
        console.log(`    \x1b[33m⚠\x1b[0m MySQL < 8.0 detected — SRID-aware spatial (POINT NOT NULL SRID 4326) requires 8.0+`);
      } else {
        console.log(`    \x1b[32m✓\x1b[0m Spatial built-in (SRID + R-tree available)`);
      }
      await conn.end();
    } else if (kind === 'sqlite') {
      const Database = tryRequire('better-sqlite3');
      if (!Database) return note('    (skip — better-sqlite3 not installed)');
      const path = url.replace(/^sqlite:/, '');
      const db = new Database(path);
      try {
        db.loadExtension?.('mod_spatialite');
        console.log(`    \x1b[32m✓\x1b[0m SpatiaLite loaded — spatial available`);
      } catch (err: any) {
        console.log(`    \x1b[33m⚠\x1b[0m SpatiaLite NOT loaded: ${err?.message ?? 'load_extension failed'}`);
        console.log(`    \x1b[2m       Install:\x1b[0m brew install libspatialite (macOS) / apt install libsqlite3-mod-spatialite (Debian)`);
        console.log(`    \x1b[2m       Or use\x1b[0m  f.geoPoint({ fallback: true }) for JSON storage + app-side Haversine`);
      }
      db.close();
    } else if (kind === 'duckdb') {
      const duckdb = tryRequire('@duckdb/node-api');
      if (!duckdb) return note('    (skip — @duckdb/node-api not installed)');
      const path = url.replace(/^duckdb:/, '') || ':memory:';
      const inst = await duckdb.DuckDBInstance.create(path);
      const conn = await inst.connect();
      try {
        await conn.run("INSTALL spatial; LOAD spatial");
        const r = await conn.run("SELECT extension_name FROM duckdb_extensions() WHERE extension_name = 'spatial' AND loaded");
        const rows = await r.getRowObjects();
        if (rows.length) console.log(`    \x1b[32m✓\x1b[0m DuckDB spatial extension loaded`);
        else console.log(`    \x1b[33m⚠\x1b[0m DuckDB spatial extension not loaded`);
      } catch (err: any) {
        console.log(`    \x1b[33m⚠\x1b[0m DuckDB spatial extension unavailable: ${err?.message ?? err}`);
      }
      await conn.close?.();
    } else if (kind === 'mssql') {
      const sql = tryRequire('mssql');
      if (!sql) return note('    (skip — mssql driver not installed)');
      const pool = await sql.connect(url);
      const v = await pool.request().query("SELECT @@VERSION AS v");
      const text = String(v.recordset[0]?.v ?? '').split('\n')[0];
      console.log(`    \x1b[32m✓\x1b[0m ${text}`);
      console.log(`    \x1b[32m✓\x1b[0m GEOGRAPHY type built-in (no extension needed)`);
      await pool.close();
    } else if (kind === 'mongo') {
      const { MongoClient } = tryRequire('mongodb') ?? {};
      if (!MongoClient) return note('    (skip — mongodb driver not installed)');
      const client = new MongoClient(url);
      await client.connect();
      const r = await client.db().admin().command({ buildInfo: 1 });
      console.log(`    \x1b[32m✓\x1b[0m MongoDB ${r.version} reachable`);
      console.log(`    \x1b[32m✓\x1b[0m 2dsphere index available (built-in since 2.4)`);
      await client.close();
    }
  } catch (err: any) {
    console.log(`    \x1b[31m✗\x1b[0m probe failed: ${err?.message ?? err}`);
  }
}

function tryRequire(name: string): any {
  try { return require(name); } catch { return null; }
}

function note(s: string): void { console.log(s); }

function reportExt(have: Set<string>, name: string, label: string, installCmd: string): void {
  if (have.has(name)) {
    console.log(`    \x1b[32m✓\x1b[0m ${label}`);
  } else {
    console.log(`    \x1b[33m⚠\x1b[0m ${label} NOT installed`);
    console.log(`    \x1b[2m       Install:\x1b[0m ${installCmd}`);
  }
}

main().catch((err) => {
  console.error('doctor crashed:', err);
  process.exit(1);
});
