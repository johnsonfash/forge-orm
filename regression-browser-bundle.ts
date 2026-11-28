// forge's main entry must bundle for a browser (2.29.2).
//
// forge runs in browsers through the IndexedDB and wasm adapters. 2.24 added
// the .sql migration runners, which read files with node:fs / node:crypto;
// they were loaded lazily, but compiled to CommonJS a literal `await
// import('./x')` is a plain require() that esbuild and Rollup follow, so an
// app bundling forge for the browser failed on node built-ins it never runs.
// The Postgres adapter's postgres.js fallback had the same problem.
//
// Bundles dist/index.js (run `npm run build` first) for the browser with the
// database drivers external — an app that does not install a driver must
// not need it — and fails on any import a browser cannot resolve.
import * as esbuild from 'esbuild';

const DRIVERS = [
  'mongodb', 'pg', 'postgres', 'mysql2', 'mariadb', 'better-sqlite3', 'mssql', 'tedious',
  '@libsql/client', '@electric-sql/pglite', '@duckdb/node-api', '@duckdb/node-bindings',
  '@sqlite.org/sqlite-wasm', '@tauri-apps/plugin-sql',
];

async function main() {
  const result = await esbuild
    .build({
      entryPoints: [process.argv[2] ?? 'dist/index.js'],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      logLevel: 'silent',
      external: DRIVERS,
    })
    .catch((e: esbuild.BuildFailure) => e);
  const errors = result.errors ?? [];
  for (const e of errors) console.log(`  ✗ ${e.text}  <- ${e.location?.file}:${e.location?.line}`);
  console.log(`[browser-bundle] ${errors.length === 0 ? 'clean' : `${errors.length} unresolvable import(s)`}`);
  if (errors.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
