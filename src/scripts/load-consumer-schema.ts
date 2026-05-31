/* eslint-disable no-console */
//
// Load the CONSUMER's schema for forge:push / forge:diff / forge:diff:apply.
//
// Layered resolver (cheap things first, scan as fallback, hard-fail on miss):
//
//   1. --schema=<path>                  CLI flag
//   2. FORGE_SCHEMA_PATH=<path>         env var
//   3. package.json → forge.schema      consumer config
//   4. node_modules/.cache/forge/       cached scan result (instant)
//        schema-cache.json
//   5. Filesystem scan                  ~150ms cold, ~30ms warm OS cache
//        → on success, write cache so the next run hits layer 4
//   6. Hard fail                         no silent fallback
//
// The scan looks for a file that BOTH imports from `forge-orm` AND exports a
// `schema` const (or default), skipping node_modules / dist / build / .git /
// .next / coverage / .cache / .turbo / test fixtures. On a 10k-file project
// the whole walk is sub-300ms because 99% of files are eliminated by a raw
// byte-search for the string "forge-orm" before we look any deeper.
//
// On multi-match the resolver fails with the full candidate list and asks
// the consumer to disambiguate via package.json or --schema=.
//
// The loaded module is expected to either:
//   • Export `schema` — the typical `export const schema = { Users, Posts… } as const`
//   • Export `default` — fallback for module authors who prefer default exports
//

import path from 'node:path';
import fs from 'node:fs';
import { setActiveSchema } from '../schema/active';

const FILE_EXT_RE = /\.(?:m|c)?[tj]sx?$/;
const TEST_PATTERN_RE = [
  /\.test\.(?:m|c)?[tj]sx?$/,
  /\.spec\.(?:m|c)?[tj]sx?$/,
  /[/\\]__tests__[/\\]/,
  /[/\\]__mocks__[/\\]/,
  /[/\\]fixtures?[/\\]/,
];
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage',
  '.git', '.next', '.cache', '.turbo', '.svelte-kit', '.nuxt',
  '.parcel-cache', '.vercel', '.netlify', '.serverless', '.output',
  '.idea', '.vscode',
]);
const MAX_FILE_BYTES = 1024 * 1024; // 1 MB — schemas are small
const FORGE_IMPORT_RE = /['"`]forge-orm['"`]/;
const SCHEMA_EXPORT_RE = /export\s+(?:const\s+schema|default)/;

export interface LoadedSchema {
  schema: any;
  source: string;     // human-readable path or '(forge bundled sample)'
  origin: 'flag' | 'env' | 'package.json' | 'cache' | 'scan' | 'fallback';
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
 * Type errors at this layer are not the migrator's concern — the consumer's
 * own TypeScript build catches those. Idempotent.
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
  } catch {
    /* ts-node not installed; .js consumer schemas still work via plain require */
  }
}

function importSchemaModule(absPath: string): any {
  if (absPath.endsWith('.ts') || absPath.endsWith('.tsx') ||
      absPath.endsWith('.mts') || absPath.endsWith('.cts')) {
    ensureTsNodeRegistered();
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(absPath);
  if (mod?.schema) return mod.schema;
  if (mod?.default?.schema) return mod.default.schema;
  if (mod?.default && typeof mod.default === 'object' && !Array.isArray(mod.default)) {
    return mod.default;
  }
  throw new Error(
    `[forge] ${absPath} loaded but no \`schema\` (or default) export found. ` +
      `Expected: export const schema = { Users, Posts, … } as const;`,
  );
}

// ─── Layer 3: package.json ──────────────────────────────────────────────────

function readPackageJsonSchema(): string | undefined {
  const pkgPath = path.join(process.cwd(), 'package.json');
  if (!fs.existsSync(pkgPath)) return undefined;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg?.forge?.schema ?? undefined;
  } catch {
    return undefined;
  }
}

// ─── Layer 4: cache ─────────────────────────────────────────────────────────

function cacheDir(): string {
  return path.join(process.cwd(), 'node_modules', '.cache', 'forge');
}

function cacheFile(): string {
  return path.join(cacheDir(), 'schema-cache.json');
}

function readCachedPath(): string | undefined {
  try {
    const raw = fs.readFileSync(cacheFile(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.path && typeof parsed.path === 'string') {
      // Verify file still exists; if not, ignore cache.
      if (fs.existsSync(parsed.path)) return parsed.path;
    }
  } catch { /* missing file / parse error / stale cache */ }
  return undefined;
}

function writeCachedPath(absPath: string): void {
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFileSync(
      cacheFile(),
      JSON.stringify({
        path: absPath,
        discoveredAt: new Date().toISOString(),
      }, null, 2),
    );
  } catch { /* cache write is best-effort; not a hard failure */ }
}

// ─── Layer 5: filesystem scan ───────────────────────────────────────────────

function scanForSchemas(root: string): string[] {
  const found: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (e.name.startsWith('.')) continue;
        walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (!FILE_EXT_RE.test(e.name)) continue;
      if (TEST_PATTERN_RE.some((p) => p.test(full))) continue;

      let stat: fs.Stats;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.size > MAX_FILE_BYTES) continue;

      let content: string;
      try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }

      // Cheap reject — vast majority of files exit here.
      if (!FORGE_IMPORT_RE.test(content)) continue;
      if (!SCHEMA_EXPORT_RE.test(content)) continue;

      found.push(full);
    }
  }

  walk(root);
  return found;
}

// ─── Failure modes ──────────────────────────────────────────────────────────

function failNotFound(): never {
  console.error(`
[forge] no schema found.

Searched in order:
  1. --schema=<path> flag             (not provided)
  2. FORGE_SCHEMA_PATH env var        (not set)
  3. package.json → forge.schema      (not set)
  4. node_modules/.cache/forge/       (no cached path)
       schema-cache.json
  5. filesystem scan                  (0 candidates)

To fix, do ONE of these:

  • Add to package.json:
      "forge": { "schema": "./src/your-schema.ts" }

  • Pass on the command line:
      npx forge push --schema=./path/to/schema.ts

  • Or make sure your schema file:
      (a) imports something from 'forge-orm', and
      (b) exports a \`schema\` const, e.g.
          export const schema = { Users, Posts } as const;
`);
  process.exit(1);
}

function failMultiMatch(candidates: string[]): never {
  console.error(`
[forge] multiple schema candidates found (${candidates.length}):

${candidates.map((c) => `  • ${path.relative(process.cwd(), c)}`).join('\n')}

To resolve, pick ONE and either:

  • Add to package.json:
      "forge": { "schema": "./src/your-schema.ts" }

  • Pass on the command line:
      npx forge push --schema=./src/your-schema.ts
`);
  process.exit(1);
}

// ─── Resolver ───────────────────────────────────────────────────────────────

export function loadConsumerSchema(argv: string[] = process.argv): LoadedSchema {
  // 1. Flag
  const flagPath = parseFlag(argv);
  if (flagPath) {
    const abs = resolveAbsolute(flagPath);
    if (!fs.existsSync(abs)) {
      console.error(`[forge] --schema=${flagPath} does not exist (resolved to ${abs})`);
      process.exit(1);
    }
    const schema = importSchemaModule(abs);
    setActiveSchema(schema);
    return { schema, source: abs, origin: 'flag' };
  }

  // 2. Env var
  const envPath = process.env.FORGE_SCHEMA_PATH;
  if (envPath) {
    const abs = resolveAbsolute(envPath);
    if (!fs.existsSync(abs)) {
      console.error(`[forge] FORGE_SCHEMA_PATH=${envPath} does not exist (resolved to ${abs})`);
      process.exit(1);
    }
    const schema = importSchemaModule(abs);
    setActiveSchema(schema);
    return { schema, source: abs, origin: 'env' };
  }

  // 3. package.json
  const pkgSchema = readPackageJsonSchema();
  if (pkgSchema) {
    const abs = resolveAbsolute(pkgSchema);
    if (!fs.existsSync(abs)) {
      console.error(`[forge] package.json → forge.schema=${pkgSchema} does not exist (resolved to ${abs})`);
      process.exit(1);
    }
    const schema = importSchemaModule(abs);
    setActiveSchema(schema);
    return { schema, source: abs, origin: 'package.json' };
  }

  // 4. Cache
  const cached = readCachedPath();
  if (cached) {
    try {
      const schema = importSchemaModule(cached);
      setActiveSchema(schema);
      return { schema, source: cached, origin: 'cache' };
    } catch {
      // Cache is stale; fall through to scan
    }
  }

  // 5. Scan
  const candidates = scanForSchemas(process.cwd());
  if (candidates.length === 1) {
    const abs = candidates[0];
    writeCachedPath(abs);
    const schema = importSchemaModule(abs);
    setActiveSchema(schema);
    return { schema, source: abs, origin: 'scan' };
  }
  if (candidates.length === 0) {
    failNotFound();
  }
  failMultiMatch(candidates);
}
