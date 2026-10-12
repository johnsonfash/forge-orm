import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * NOTHING REACHABLE FROM THE PUBLIC ENTRY MAY STATICALLY IMPORT A NODE
 * BUILTIN.
 *
 * ---- WHAT THIS COST ------------------------------------------------
 *
 * `object-id.ts` was added in 2.21.0 with `import { randomBytes } from
 * 'node:crypto'` and a `Buffer` at module scope. `src/index.ts` exports
 * `objectIdHex` and `builder/collection.ts` imports it, so that module
 * is reachable from ANY import of forge — including a browser app using
 * the IndexedDB adapter.
 *
 * Both calls run at module scope, so the failure is not "ids are
 * broken". It is the whole bundle throwing on import:
 *
 *     (0 , node_crypto_1.randomBytes) is not a function
 *
 * Measured in a real application: the operator UI never finished
 * booting — the splash sat there and then showed its chunk-load
 * fallback, because the error happens before any of the app's own code
 * runs. The founder found it by opening the app. Nothing here could
 * have: every one of this library's 1,083 tests runs under Node, where
 * the import resolves perfectly, and the consuming app's `tsc --noEmit`
 * passed too — a typecheck cannot see a missing runtime global.
 *
 * ---- WHY A DYNAMIC IMPORT IS FINE ----------------------------------
 *
 * forge genuinely needs Node builtins for the server adapters, and
 * those are loaded with `await import(...)` inside the function that
 * needs them. A dynamic import is not in the static graph, so a bundler
 * never pulls it into a browser build and the code path is only reached
 * when that adapter is actually used. That is the pattern to follow —
 * the rule here is about STATIC, top-level imports.
 */

/*
 * From the package root, not `import.meta.dirname`: jest compiles these
 * specs to CommonJS, where `import.meta` is a syntax error. No other
 * spec here reads the filesystem, so there was no precedent to copy —
 * and the first version of this file failed to load at all, which jest
 * reports as a suite error rather than a failing test, so the total
 * simply did not move.
 */
const SRC = resolve(process.cwd(), 'src');
const ENTRY = join(SRC, 'index.ts');

/** `import … from 'node:x'` / `require('node:x')`, top level only. */
const NODE_BUILTIN = /(?:^|\n)\s*import\s[^;]*?from\s*['"]node:([a-z_/]+)['"]/g;
const NODE_REQUIRE = /(?:^|\n)\s*(?:const|let|var)\s[^;]*?=\s*require\(\s*['"]node:([a-z_/]+)['"]\s*\)/g;

/** Relative specifiers only — a bare package is the bundler's business. */
const RELATIVE_IMPORT = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*['"](\.[^'"]+)['"]/g;

function resolveModule(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    `${base}.js`,
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every module the public entry pulls in STATICALLY, transitively. */
function staticGraph(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    const src = readFileSync(file, 'utf8');
    seen.set(file, src);
    for (const m of src.matchAll(RELATIVE_IMPORT)) {
      const next = resolveModule(file, m[1]!);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

describe('browser safety', () => {
  const graph = staticGraph(ENTRY);

  it('reaches a substantial part of the library, or the walk is broken', () => {
    // A graph that silently stopped resolving would pass every
    // assertion below while checking almost nothing.
    expect(graph.size).toBeGreaterThan(20);
    expect([...graph.keys()].some((f) => f.endsWith('object-id.ts'))).toBe(true);
    expect([...graph.keys()].some((f) => f.endsWith('builder/collection.ts'))).toBe(true);
  });

  it('imports no Node builtin at the top level', () => {
    const offenders: string[] = [];
    for (const [file, src] of graph) {
      for (const re of [NODE_BUILTIN, NODE_REQUIRE]) {
        re.lastIndex = 0;
        for (const m of src.matchAll(re)) {
          offenders.push(`${file.slice(SRC.length + 1)} → node:${m[1]}`);
        }
      }
    }
    // jest's `expect` takes no message argument (that is vitest), so the
    // explanation is thrown instead — the point is that whoever trips
    // this reads WHY and what to do, not just "expected [] to equal".
    if (offenders.length > 0) {
      throw new Error(
        'These are reachable from `src/index.ts`, so a browser build pulls ' +
          'them in and throws on import — before any of the consuming app ' +
          'runs. Use the Web platform equivalent (globalThis.crypto, ' +
          'Uint8Array, TextEncoder), or move the Node call behind ' +
          '`await import(...)` inside the function that needs it.\n\n' +
          offenders.join('\n'),
      );
    }
    expect(offenders).toEqual([]);
  });

  it('would still catch the import that caused this', () => {
    // A guard that passes only because its pattern stopped matching is
    // indistinguishable from one that works, so the exact line that
    // broke the app is pinned here.
    const was = `import { randomBytes } from 'node:crypto';\n\nconst X = randomBytes(5);`;
    NODE_BUILTIN.lastIndex = 0;
    expect([...was.matchAll(NODE_BUILTIN)].map((m) => m[1])).toEqual(['crypto']);
  });

  it('allows a DYNAMIC node import, which is how the server adapters work', () => {
    const fine = `async function connect() {\n  const pg = await import('node:net');\n}`;
    NODE_BUILTIN.lastIndex = 0;
    expect([...fine.matchAll(NODE_BUILTIN)]).toEqual([]);
  });
});

/**
 * The id generator itself, exercised through the Web Crypto path only.
 *
 * Node 18+ has `globalThis.crypto`, so this runs the SAME branch a
 * browser does — which is the point. The previous implementation would
 * have failed at import, before any of these could run.
 */
describe('objectIdHex works without node:crypto', () => {
  it('has Web Crypto available, which is the branch being tested', () => {
    expect(typeof globalThis.crypto?.getRandomValues).toBe('function');
  });

  it('mints a 24-hex id', async () => {
    const { objectIdHex, OBJECT_ID_PATTERN } = await import('../object-id');
    const id = objectIdHex();
    expect(id).toHaveLength(24);
    expect(OBJECT_ID_PATTERN.test(id)).toBe(true);
  });

  it('encodes the timestamp in the first four bytes', async () => {
    const { objectIdHex } = await import('../object-id');
    const when = Date.UTC(2026, 9, 12, 12, 0, 0);
    expect(parseInt(objectIdHex(when).slice(0, 8), 16)).toBe(Math.floor(when / 1000));
  });

  it('sorts by time, which is the whole reason for this shape', async () => {
    const { objectIdHex } = await import('../object-id');
    const older = objectIdHex(Date.UTC(2025, 0, 1));
    const newer = objectIdHex(Date.UTC(2026, 0, 1));
    expect(older < newer).toBe(true);
  });

  it('orders ids minted in the SAME second by the order they were minted', async () => {
    const { objectIdHex } = await import('../object-id');
    const now = Date.now();
    const ids = Array.from({ length: 50 }, () => objectIdHex(now));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(50);
  });

  it('wraps the counter at 2^24 without producing a short id', async () => {
    const { objectIdHex } = await import('../object-id');
    const now = Date.now();
    for (let i = 0; i < 300; i += 1) {
      expect(objectIdHex(now)).toHaveLength(24);
    }
  });
});
