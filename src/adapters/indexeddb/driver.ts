// Pluggable driver interface.
//
// The IDB "driver" is thinner than the SQL ones — the browser API IS the
// driver. The wrapper exists so tests can inject fake-indexeddb, and so
// consumers can override the DB name / persistence policy at construction.
//
//   createDb({ driver: indexedDbDriver({ name: 'app' }) })
//
// A shipped version would also let you inject a scoped IDBFactory (e.g.
// a Web Worker's `self.indexedDB`, or a tab-partitioned prefix).

import type { SchemaShape } from '../../schema/active';
import { openDb, deleteDb } from './open';

export interface IdbDriverOptions {
  name: string;
  factory?: IDBFactory;
  logger?: (line: string) => void;
}

export interface IdbDriver {
  readonly kind: 'indexeddb';
  readonly name: string;
  open(schema: SchemaShape): Promise<IDBDatabase>;
  close(): void;
  drop(): Promise<void>;
}

export function indexedDbDriver(opts: IdbDriverOptions): IdbDriver {
  let handle: IDBDatabase | null = null;
  const driver: IdbDriver = {
    kind: 'indexeddb',
    name: opts.name,
    async open(schema) {
      if (handle) return handle;
      const r = await openDb({ name: opts.name, schema, logger: opts.logger });
      handle = r.db;
      return handle;
    },
    close() { if (handle) { handle.close(); handle = null; } },
    async drop() {
      driver.close();
      await deleteDb(opts.name);
    },
  };
  return driver;
}

export function isIdbDriver(v: unknown): v is IdbDriver {
  return !!v && typeof v === 'object' && (v as { kind?: unknown }).kind === 'indexeddb';
}
