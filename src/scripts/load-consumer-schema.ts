/* eslint-disable no-console */
//
// Load the CONSUMER's schema for forge:push / forge:diff / forge:rollback.
//
// Why this exists: previous releases of `forge:push` hardwired the require
// path to forge's own bundled sample schema. That meant consumers running
// `npx forge:push` against their own DB were silently pushing forge's sample
// indexes instead of their own — i.e. nothing useful happened. (Detected in
// the wild: a BigBite production env shipped with NO indexes on critical
// collections, including a unique constraint on a webhook idempotency key.
// The application-layer guards held, but the DB-layer safety net wasn't there.)
//
// Resolution order:
//   1. --schema=<path>            CLI flag
//   2. FORGE_SCHEMA_PATH=<path>   env var
//   3. Auto-detect from these convention paths, first hit wins:
//        ./src/schema.ts
//        ./src/schema.js
//        ./schema.ts
//        ./schema.js
//        ./src/core/database/schema.ts
//        ./src/db/schema.ts
//        ./src/database/schema.ts
//   4. Fall back to forge's bundled sample with a loud warning. The fallback
//      is there so `npm test` / `forge:push` against an in-repo dev DB inside
//      forge's own monorepo keeps working — consumers will never hit it.
//
// The loaded module is expected to either:
//   • Export `schema` — the typical `export const schema = { Users, Posts… } as const`
//   • Export `default` — fallback for module authors who prefer default exports
//

import path from 'node:path';
import fs from 'node:fs';
import { setActiveSchema } from '../schema/active';

const CONVENTION_PATHS = [
  'src/schema.ts',
  'src/schema.js',
  'schema.ts',
  'schema.js',
  'src/core/database/schema.ts',
  'src/db/schema.ts',
  'src/database/schema.ts',
];

export interface LoadedSchema {
  schema: any;
  source: string;     // human-readable path or '(forge bundled sample)'
  isFallback: boolean;
}

function parseFlag(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--schema') return argv[i + 1];
    if (a.startsWith('--schema=')) return a.slice('--schema='.length);
  }
  return undefined;
}

function resolveAbsolute(candidate: string): string {
  if (path.isAbsolute(candidate)) return candidate;
  return path.resolve(process.cwd(), candidate);
}

let tsNodeRegistered = false;
/**
 * Register ts-node in transpile-only mode so loading a TypeScript schema is
 * fast (milliseconds) instead of slow (~30-60s) due to full type-checking.
 *
 * Type errors at this layer are not the migrator's concern — the consumer's
 * own TypeScript build catches those. Here we just need the runtime values.
 *
 * Idempotent: re-running this is a no-op.
 */
function ensureTsNodeRegistered(): void {
  if (tsNodeRegistered) return;
  tsNodeRegistered = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const tsNode = require('ts-node');
    tsNode.register({
      transpileOnly: true,
      compilerOptions: {
        module: 'commonjs',
        moduleResolution: 'node',
        esModuleInterop: true,
        target: 'es2020',
        skipLibCheck: true,
      },
    });
  } catch (err: any) {
    // ts-node isn't installed; that's fine if the consumer is loading a .js
    // file. If they hand us a .ts and ts-node is absent we'll fail on require
    // below with a clearer message.
  }
}

function importSchemaModule(absPath: string): any {
  // Auto-register ts-node in transpile-only mode for .ts schemas. Skipping
  // this would push the cost of compile + full type-check onto whatever
  // loader the consumer happens to have registered globally (commonly the
  // default ts-node setup, which type-checks the WHOLE file — that's the
  // 30-60s "why is this so slow?" everyone hits on first run).
  if (absPath.endsWith('.ts') || absPath.endsWith('.tsx')) {
    ensureTsNodeRegistered();
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(absPath);
  if (mod?.schema) return mod.schema;
  if (mod?.default?.schema) return mod.default.schema;
  if (mod?.default && typeof mod.default === 'object' && !Array.isArray(mod.default)) return mod.default;
  throw new Error(
    `[forge] ${absPath} loaded but no \`schema\` (or default) export found. ` +
      `Expected: export const schema = { Users, Posts, … } as const;`,
  );
}

export function loadConsumerSchema(argv: string[] = process.argv): LoadedSchema {
  // 1. CLI flag
  const flagPath = parseFlag(argv);
  if (flagPath) {
    const abs = resolveAbsolute(flagPath);
    if (!fs.existsSync(abs)) {
      console.error(`[forge:push] --schema=${flagPath} does not exist (resolved to ${abs})`);
      process.exit(1);
    }
    const schema = importSchemaModule(abs);
    setActiveSchema(schema);
    return { schema, source: abs, isFallback: false };
  }

  // 2. Env var
  const envPath = process.env.FORGE_SCHEMA_PATH;
  if (envPath) {
    const abs = resolveAbsolute(envPath);
    if (!fs.existsSync(abs)) {
      console.error(`[forge:push] FORGE_SCHEMA_PATH=${envPath} does not exist (resolved to ${abs})`);
      process.exit(1);
    }
    const schema = importSchemaModule(abs);
    setActiveSchema(schema);
    return { schema, source: abs, isFallback: false };
  }

  // 3. Convention paths
  const cwd = process.cwd();
  for (const rel of CONVENTION_PATHS) {
    const abs = path.join(cwd, rel);
    if (fs.existsSync(abs)) {
      try {
        const schema = importSchemaModule(abs);
        setActiveSchema(schema);
        console.log(`[forge:push] auto-detected schema at ${rel}`);
        return { schema, source: abs, isFallback: false };
      } catch (err: any) {
        // Found the file but it didn't export schema — surface, don't keep
        // hunting (would confuse the user about which file forge looked at).
        console.error(`[forge:push] ${rel} found but failed to load schema: ${err?.message || err}`);
        process.exit(1);
      }
    }
  }

  // 4. Bundled-sample fallback — for forge's own monorepo dev/test runs.
  // Consumers should NEVER hit this; surface a loud warning so it can't go
  // unnoticed.
  console.warn(
    `[forge:push] ⚠ no consumer schema found. Falling back to forge's bundled\n` +
      `             sample schema (development only — won't reflect your models).\n` +
      `             Pass --schema=<path> or set FORGE_SCHEMA_PATH=<path>, or put\n` +
      `             your schema at one of these conventional paths:\n` +
      CONVENTION_PATHS.map((p) => `               • ${p}`).join('\n'),
  );
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sample = require('../schema').schema;
  setActiveSchema(sample);
  return { schema: sample, source: '(forge bundled sample)', isFallback: true };
}
