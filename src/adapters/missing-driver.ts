import type { AdapterKind } from './types';
import { DRIVER_PACKAGE_FOR } from './detect';

// Actionable error shown when a consumer uses an adapter whose underlying driver
// isn't installed — far clearer than a bare `Cannot find module 'pg'`.

export class ForgeMissingDriverError extends Error {
  readonly code = 'FORGE_MISSING_DRIVER' as const;
  constructor(
    readonly kind: AdapterKind,
    readonly pkg: string,
    readonly originalUrl?: string,
  ) {
    super(buildMessage(kind, pkg, originalUrl));
    this.name = 'ForgeMissingDriverError';
  }
}

function buildMessage(kind: AdapterKind, pkg: string, url?: string): string {
  const inferLine = url
    ? `\n  Detected:    DATABASE_URL=${redactUrl(url)}  (inferred adapter: ${kind})`
    : `\n  Adapter:     ${kind}`;
  return (
    `[forge] ${kind} adapter needs the '${pkg}' driver, but it's not installed.${inferLine}` +
    `\n  Install:     npm install ${pkg}` +
    `\n  Or override: createDb({ type: 'mongo' | 'postgres' | 'mysql' | 'sqlite', url: '...' })`
  );
}

// Strip credentials from the URL before printing so we don't leak secrets to
// stderr / log aggregators.
function redactUrl(url: string): string {
  return url.replace(/(:\/\/[^:@/]+):([^@/]+)@/, '$1:****@');
}

// Lazy require helper. Returns the loaded module or throws ForgeMissingDriverError.
// Adapters call this inside `connect()` so the wrapper itself imports nothing
// at module-eval time.
export function loadDriver(kind: AdapterKind, url?: string): any {
  const pkg = DRIVER_PACKAGE_FOR[kind];
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(pkg);
  } catch (err: any) {
    if (err?.code === 'MODULE_NOT_FOUND') {
      throw new ForgeMissingDriverError(kind, pkg, url);
    }
    throw err;
  }
}

export function isDriverInstalled(kind: AdapterKind): { installed: boolean; version?: string } {
  const pkg = DRIVER_PACKAGE_FOR[kind];
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(`${pkg}/package.json`);
    return { installed: true, version: mod?.version };
  } catch {
    return { installed: false };
  }
}
