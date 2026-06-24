#!/usr/bin/env node
// Throwaway driver smoke test.
//
// Creates a fresh tmpdir, npm-installs every driver forge-orm supports, runs
// a minimal connect+query+close for each, prints a results table, then tears
// the tmpdir + any Testcontainers down. The drivers are tested AS PACKAGES,
// independent of forge-orm — this verifies the underlying clients install
// and connect on the current Node / platform.
//
// First run is slow (image pulls); subsequent runs ~15s on a warm Docker.
//
//   npm run smoke:drivers              # everything
//   npm run smoke:drivers -- --only=pg # filter by substring(s)
//   npm run smoke:drivers -- --keep    # don't delete the tmpdir on exit

/* eslint-disable no-console */

import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir as osTmpDir } from 'node:os';
import { join, resolve as pathResolve } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { arch } from 'node:os';

// Some packages (e.g. @libsql/client) restrict `exports` so
// require('pkg/package.json') throws even when the package is installed.
// Walk up from the tmpdir's node_modules/<pkg>/ to find the manifest.
function pkgVersion(req, tmp, pkg) {
  try {
    return req(`${pkg}/package.json`).version;
  } catch { /* exports map blocked it; fall through */ }
  try {
    const manifest = JSON.parse(
      readFileSync(join(tmp, 'node_modules', pkg, 'package.json'), 'utf8'),
    );
    return manifest.version;
  } catch {
    return '?';
  }
}

const ARGS = process.argv.slice(2);
const ONLY = ARGS.filter((a) => a.startsWith('--only='))
  .flatMap((a) => a.slice('--only='.length).split(','))
  .map((s) => s.trim()).filter(Boolean);
const KEEP_TMPDIR = ARGS.includes('--keep');
const VERBOSE = ARGS.includes('--verbose');

const IS_ARM = arch() === 'arm64';

// ─── Driver registry ────────────────────────────────────────────────────────
//
// Each entry pairs an npm package with a `test(req)` function that:
//   • imports the driver via `req()` (resolves from the tmpdir's node_modules)
//   • connects, runs a trivial query, closes
//   • returns { version, detail? } on success; throws on failure
//
// `requiresServer: 'pg' | 'mysql' | 'mongo' | 'mssql' | null` controls
// whether a Testcontainer is started for that driver. Embedded drivers
// (sqlite/duckdb) leave it null.
//
// `installCheckOnly: true` is for React Native drivers — exercising the
// binding requires an iOS/Android runtime; we only verify the package
// resolves so we know `npm install` worked.

const DRIVERS = [
  // Embedded — no server needed
  {
    name: 'better-sqlite3',
    package: 'better-sqlite3',
    requiresServer: null,
    test: async (req, ctx) => {
      const Database = req('better-sqlite3');
      const db = new Database(':memory:');
      const row = db.prepare('SELECT 1 AS one').get();
      if (row.one !== 1) throw new Error('unexpected row shape');
      db.close();
      return { version: ctx.pv('better-sqlite3') };
    },
  },
  {
    name: '@libsql/client',
    package: '@libsql/client',
    requiresServer: null,
    test: async (req, ctx) => {
      const { createClient } = req('@libsql/client');
      const client = createClient({ url: ':memory:' });
      const r = await client.execute('SELECT 1 as one');
      if (Number(r.rows[0].one) !== 1) throw new Error('unexpected row');
      await client.close?.();
      return { version: ctx.pv('@libsql/client') };
    },
  },
  {
    name: '@duckdb/node-api',
    package: '@duckdb/node-api',
    requiresServer: null,
    test: async (req, ctx) => {
      const { DuckDBInstance } = req('@duckdb/node-api');
      const instance = await DuckDBInstance.create(':memory:');
      const conn = await instance.connect();
      const r = await conn.run('SELECT 1 AS one');
      const rows = await r.getRowObjects();
      if (Number(rows[0].one) !== 1) throw new Error('unexpected row');
      await conn.close?.();
      return { version: ctx.pv('@duckdb/node-api') };
    },
  },

  // PostgreSQL — testcontainers/postgresql, two drivers share one container
  {
    name: 'pg',
    package: 'pg',
    requiresServer: 'pg',
    test: async (req, ctx) => { const { url } = ctx;
      const { Client } = req('pg');
      const client = new Client({ connectionString: url });
      await client.connect();
      const r = await client.query('SELECT 1 AS one');
      if (r.rows[0].one !== 1) throw new Error('unexpected row');
      await client.end();
      return { version: ctx.pv('pg') };
    },
  },
  {
    name: 'postgres (porsager)',
    package: 'postgres',
    requiresServer: 'pg',
    test: async (req, ctx) => { const { url } = ctx;
      const postgres = req('postgres');
      const sql = postgres(url, { max: 1, prepare: false });
      const r = await sql`SELECT 1 AS one`;
      if (r[0].one !== 1) throw new Error('unexpected row');
      await sql.end({ timeout: 5 });
      return { version: ctx.pv('postgres') };
    },
  },

  // MySQL
  {
    name: 'mysql2',
    package: 'mysql2',
    requiresServer: 'mysql',
    test: async (req, ctx) => { const { url } = ctx;
      const mysql = req('mysql2/promise');
      const conn = await mysql.createConnection(url);
      const [rows] = await conn.query('SELECT 1 AS one');
      if (rows[0].one !== 1) throw new Error('unexpected row');
      await conn.end();
      return { version: ctx.pv('mysql2') };
    },
  },
  {
    name: 'mariadb',
    package: 'mariadb',
    requiresServer: 'mysql',
    test: async (req, ctx) => { const { url } = ctx;
      const mariadb = req('mariadb');
      const conn = await mariadb.createConnection(url);
      const r = await conn.query('SELECT 1 AS one');
      if (Number(r[0].one) !== 1) throw new Error('unexpected row');
      await conn.end();
      return { version: ctx.pv('mariadb') };
    },
  },

  // MongoDB
  {
    name: 'mongodb',
    package: 'mongodb',
    requiresServer: 'mongo',
    test: async (req, ctx) => { const { url } = ctx;
      const { MongoClient } = req('mongodb');
      const client = new MongoClient(url);
      await client.connect();
      const r = await client.db('admin').command({ ping: 1 });
      if (r.ok !== 1) throw new Error('ping failed');
      await client.close();
      return { version: ctx.pv('mongodb') };
    },
  },

  // SQL Server
  {
    name: 'mssql',
    package: 'mssql',
    requiresServer: 'mssql',
    test: async (req, ctx) => { const { url } = ctx;
      const sql = req('mssql');
      const pool = await sql.connect(url);
      const r = await pool.request().query('SELECT 1 AS one');
      if (r.recordset[0].one !== 1) throw new Error('unexpected row');
      await pool.close();
      return { version: ctx.pv('mssql') };
    },
  },

  // React Native — install-only (binding exec'd in JSC/Hermes only)
  {
    name: 'expo-sqlite',
    package: 'expo-sqlite',
    requiresServer: null,
    installCheckOnly: true,
    test: async (req, ctx) => {
      req.resolve('expo-sqlite'); // throws if it didn't install
      return { version: ctx.pv('expo-sqlite'), detail: 'install resolves; exec needs RN runtime' };
    },
  },
  {
    name: '@op-engineering/op-sqlite',
    package: '@op-engineering/op-sqlite',
    requiresServer: null,
    installCheckOnly: true,
    test: async (req, ctx) => {
      req.resolve('@op-engineering/op-sqlite');
      return { version: ctx.pv('@op-engineering/op-sqlite'), detail: 'install resolves; exec needs RN runtime' };
    },
  },

  // Managed-cloud-only — skip unless explicit creds present
  {
    name: '@planetscale/database',
    package: '@planetscale/database',
    requiresServer: 'planetscale',
    skipUnless: () => !!process.env.PLANETSCALE_URL,
    test: async (req, ctx) => { const { url } = ctx;
      const { Client } = req('@planetscale/database');
      const c = new Client({ url });
      const r = await c.execute('SELECT 1 AS one');
      if (Number(r.rows[0].one) !== 1) throw new Error('unexpected row');
      return { version: ctx.pv('@planetscale/database') };
    },
  },
];

// ─── Testcontainers — one container per server kind, shared across drivers ──

const SERVER_KINDS = ['pg', 'mysql', 'mongo', 'mssql'];

async function startServer(kind, req) {
  if (kind === 'pg') {
    const { PostgreSqlContainer } = req('@testcontainers/postgresql');
    const c = await new PostgreSqlContainer('postgres:16-alpine').start();
    return { url: c.getConnectionUri(), stop: () => c.stop() };
  }
  if (kind === 'mysql') {
    const { MySqlContainer } = req('@testcontainers/mysql');
    const c = await new MySqlContainer('mysql:8').start();
    // Build a URL — getConnectionUri yields mysql://user:pass@host:port/db
    return { url: c.getConnectionUri(), stop: () => c.stop() };
  }
  if (kind === 'mongo') {
    const { MongoDBContainer } = req('@testcontainers/mongodb');
    const c = await new MongoDBContainer('mongo:7').start();
    return { url: c.getConnectionString().replace('?directConnection=true', '/test?directConnection=true'), stop: () => c.stop() };
  }
  if (kind === 'mssql') {
    // ARM Macs: full SQL Server image only ships AMD64. azure-sql-edge ships
    // multi-arch and is functionally compatible for our smoke test.
    const image = IS_ARM
      ? 'mcr.microsoft.com/azure-sql-edge:latest'
      : 'mcr.microsoft.com/mssql/server:2022-latest';
    const { MSSQLServerContainer } = req('@testcontainers/mssqlserver');
    const c = await new MSSQLServerContainer(image)
      .acceptLicense()                         // ACCEPT_EULA=Y
      .withPassword('Smoke_Test_Pass_123!')    // complexity requirement
      .start();
    return { url: c.getConnectionUri(), stop: () => c.stop() };
  }
  throw new Error(`unknown server kind ${kind}`);
}

// ─── Reporting ──────────────────────────────────────────────────────────────

function fmtMs(n) {
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(2)}s`;
}

function pad(s, n) { return String(s).padEnd(n); }

function printTable(results) {
  console.log('');
  const groups = [
    ['Embedded (no server)',      results.filter((r) => !r.requiresServer && !r.installCheckOnly)],
    ['Server (Testcontainers)',   results.filter((r) =>  r.requiresServer && !r.skipped)],
    ['Install-only (RN)',         results.filter((r) =>  r.installCheckOnly)],
    ['Skipped',                   results.filter((r) =>  r.skipped)],
  ];
  for (const [title, group] of groups) {
    if (!group.length) continue;
    console.log(`${title}:`);
    for (const r of group) {
      const mark = r.skipped ? '·' : r.status === 'ok' ? '✓' : '✗';
      const name = pad(r.name, 30);
      const ver = pad(r.version ?? '-', 12);
      const tail = r.status === 'fail'
        ? `  → ${r.error}`
        : r.skipped
        ? `  (${r.skipReason})`
        : r.detail
        ? `  (${r.detail})`
        : '';
      const ms = r.ms != null ? fmtMs(r.ms) : '';
      console.log(`  ${mark} ${name} ${ver} ${ms}${tail}`);
    }
    console.log('');
  }
  const ok = results.filter((r) => !r.skipped && r.status === 'ok').length;
  const fail = results.filter((r) => !r.skipped && r.status === 'fail').length;
  const skip = results.filter((r) => r.skipped).length;
  console.log(`Result: ${ok} ok · ${fail} fail · ${skip} skipped`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function runDriverTest(driver, req, pv, serverByKind) {
  const t0 = performance.now();
  try {
    let ctx = { pv };
    if (driver.requiresServer) {
      const server = serverByKind.get(driver.requiresServer);
      if (!server) throw new Error(`no server for kind=${driver.requiresServer}`);
      ctx.url = server.url;
    }
    const out = await driver.test(req, ctx);
    return {
      ...driver,
      status: 'ok',
      ms: performance.now() - t0,
      version: out?.version,
      detail: out?.detail,
    };
  } catch (err) {
    return {
      ...driver,
      status: 'fail',
      ms: performance.now() - t0,
      error: err?.message ?? String(err),
    };
  }
}

async function main() {
  // 1. Filter — by name substring matching when --only= is passed.
  let drivers = DRIVERS;
  if (ONLY.length > 0) {
    drivers = drivers.filter((d) =>
      ONLY.some((needle) => d.name.toLowerCase().includes(needle.toLowerCase())
        || d.package.toLowerCase().includes(needle.toLowerCase())));
    if (drivers.length === 0) {
      console.error(`no drivers matched --only=${ONLY.join(',')}`);
      process.exit(2);
    }
  }

  // 2. Skip drivers with skipUnless guard not satisfied.
  const skippedUpfront = [];
  drivers = drivers.filter((d) => {
    if (d.skipUnless && !d.skipUnless()) {
      skippedUpfront.push({ ...d, skipped: true, skipReason: 'no credentials' });
      return false;
    }
    return true;
  });

  // 3. mktemp + package.json.
  const tmp = mkdtempSync(join(osTmpDir(), 'forge-drvchk-'));
  const cleanup = (code) => {
    if (KEEP_TMPDIR) {
      console.log(`\n[--keep] tmpdir preserved: ${tmp}`);
    } else {
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
    }
    process.exit(code);
  };
  process.on('SIGINT', () => cleanup(130));
  process.on('SIGTERM', () => cleanup(143));

  console.log(`forge-orm driver smoke — Node ${process.version} / ${process.platform}-${arch()}`);
  console.log(`Tempdir: ${tmp}`);
  writeFileSync(join(tmp, 'package.json'),
    JSON.stringify({ name: 'driver-smoke', version: '0.0.0', private: true }, null, 2));

  // 4. npm install all driver packages + testcontainers shims.
  const pkgs = drivers.map((d) => d.package);
  const needsTestcontainers = drivers.some((d) => SERVER_KINDS.includes(d.requiresServer));
  if (needsTestcontainers) {
    pkgs.push(
      'testcontainers',
      '@testcontainers/postgresql',
      '@testcontainers/mysql',
      '@testcontainers/mongodb',
      '@testcontainers/mssqlserver',
    );
  }
  console.log(`Installing ${pkgs.length} package${pkgs.length === 1 ? '' : 's'} (${pkgs.length > 5 ? '…' : pkgs.join(', ')})…`);
  const r = spawnSync('npm', ['install', '--silent', '--no-fund', '--no-audit', ...pkgs],
    { cwd: tmp, stdio: VERBOSE ? 'inherit' : 'pipe' });
  if (r.status !== 0) {
    console.error('npm install failed');
    if (!VERBOSE) {
      console.error(r.stderr?.toString().slice(-1000) ?? '(no stderr)');
    }
    cleanup(1);
  }

  // 5. Resolution helper — required modules live in the tmpdir's node_modules.
  const req = createRequire(pathResolve(tmp, 'package.json'));
  const pv = (pkg) => pkgVersion(req, tmp, pkg);

  // 6. Spin up servers needed by this run (one per kind, in parallel).
  const neededKinds = new Set(
    drivers.filter((d) => SERVER_KINDS.includes(d.requiresServer)).map((d) => d.requiresServer));
  const serverByKind = new Map();
  if (neededKinds.size > 0) {
    console.log(`Starting ${neededKinds.size} server${neededKinds.size === 1 ? '' : 's'}: ${[...neededKinds].join(', ')}…`);
  }
  const serverStarts = [...neededKinds].map(async (kind) => {
    const t0 = performance.now();
    try {
      const server = await startServer(kind, req);
      serverByKind.set(kind, server);
      console.log(`  ✓ ${kind} container ready (${fmtMs(performance.now() - t0)})`);
    } catch (err) {
      console.log(`  ✗ ${kind} container failed: ${err?.message ?? err}`);
      serverByKind.set(kind, { url: null, stop: async () => {}, error: err?.message ?? String(err) });
    }
  });
  await Promise.all(serverStarts);

  // 7. Run all driver tests in parallel. Drivers whose server failed get
  //    a synthetic 'fail' with the container error.
  console.log('Running driver tests…');
  const testRuns = drivers.map(async (d) => {
    if (d.requiresServer && SERVER_KINDS.includes(d.requiresServer)) {
      const srv = serverByKind.get(d.requiresServer);
      if (srv?.error) {
        return {
          ...d,
          status: 'fail',
          ms: 0,
          error: `server unavailable: ${srv.error}`,
        };
      }
    }
    return runDriverTest(d, req, pv, serverByKind);
  });
  const results = [...await Promise.all(testRuns), ...skippedUpfront];

  // 8. Stop containers + cleanup tmpdir.
  for (const s of serverByKind.values()) {
    try { await s.stop?.(); } catch { /* */ }
  }
  printTable(results);

  const exitCode = results.some((r) => !r.skipped && r.status === 'fail') ? 1 : 0;
  cleanup(exitCode);
}

main().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exit(1);
});
