import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ClientSession, Document } from 'mongodb';
import { CollectionWrapper } from './builder/collection';
import { coerceExtendedJSON } from './adapters/mongo/coerce';
import { dbClient } from './client';
import { schema, SchemaMap } from './schema';
import { ModelFields, ModelRelations, TypedModel } from './schema/core';
import { ModelDef } from './schema/types';

// ============================================================================
// DatabaseService — drop-in replacement for PrismaService.
//
// Exposes one wrapper per collection on `this`, keyed by the friendly model
// name from `schema` (e.g. `db.user`, `db.userProfile`, `db.video` …).
// Each wrapper is typed with the model's fields F and relations R, so:
//   • `data: { ... }`        autocompletes scalar field names + relation ops
//   • `where: { ... }`       autocompletes scalar fields + Prisma operators
//                            (equals, not, in, contains, mode, gte, …)
//   • `select: { ... }`      autocompletes both scalars and relation names
//   • `include: { ... }`     autocompletes relation names
//   • `orderBy: { ... }`     autocompletes scalar field names
//
// `$transaction(fn)` mirrors Prisma's interactive transaction signature.
// ============================================================================

// Map each schema entry → typed CollectionWrapper. The phantom `_fields` and
// `_relations` carriers on TypedModel make this resolution cycle-free.
type CollectionFor<M> = M extends TypedModel<any, any>
  ? CollectionWrapper<ModelFields<M>, ModelRelations<M>>
  : never;

type Collections = {
  [K in keyof SchemaMap]: CollectionFor<SchemaMap[K]>;
};

const PROXY_PASSTHROUGH = new Set<PropertyKey>([
  'then',
  'toJSON',
  'toString',
  'valueOf',
  'inspect',
  'constructor',
  'asymmetricMatch',
  '$$typeof',
  'nodeType',
]);

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly cache: Partial<Record<keyof SchemaMap, CollectionWrapper<any>>> = {};

  // Proxy presents the typed `Collections` shape from outside while lazily
  // creating wrappers on first access.
  public readonly collections: Collections = new Proxy({} as Collections, {
    get: (_target, prop) => {
      if (typeof prop === 'symbol' || PROXY_PASSTHROUGH.has(prop)) return undefined;
      const key = prop as keyof SchemaMap;
      const model = (schema as any)[key] as ModelDef<any> | undefined;
      if (!model) return undefined;
      if (!this.cache[key]) {
        this.cache[key] = new CollectionWrapper(model);
      }
      return this.cache[key];
    },
  });

  // Mirror of Prisma's $transaction. Two forms:
  //   • Callback form:  $transaction(async (tx) => { ... })
  //                     `tx` is a Db-shape object whose every collection
  //                     wrapper is bound to the transaction session, so
  //                     `tx.comment.create(...)` participates in the txn.
  //   • Array form:     $transaction([call1, call2, call3])
  //                     resolves the promises in parallel and returns the
  //                     tuple — same semantics Prisma gave on Mongo.
  //
  // Mongo only supports real ACID transactions on replica sets. On a
  // standalone Mongo, `withTransaction` throws — which mirrors Prisma's
  // behaviour, so we don't paper over it.
  $transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  $transaction<T extends readonly unknown[] | []>(
    promises: T,
  ): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }>;
  $transaction(arg: any): any {
    if (Array.isArray(arg)) {
      return Promise.all(arg);
    }
    return dbClient.transaction(async (session) => {
      const tx = makeTxProxy(session);
      return arg(tx);
    });
  }

  // Drop-in for Prisma's $runCommandRaw — passes the command straight to
  // Mongo. Existing call sites use extended-JSON shapes ({ $oid, $date }),
  // which we coerce to native ObjectId/Date before dispatch so the driver's
  // BSON layer accepts them.
  async $runCommandRaw(command: Document): Promise<any> {
    const coerced = coerceExtendedJSON(command);
    return dbClient.db.command(coerced);
  }

  async onModuleInit() {
    await dbClient.connect();
  }

  async onModuleDestroy() {
    // Don't aggressively close — multiple Nest microservices share the
    // process in some setups. Close hooks are idempotent.
    try {
      await dbClient.close();
    } catch (err) {
      this.logger.warn(`Database close warning: ${(err as Error).message}`);
    }
  }
}

// Expose top-level proxy keys directly on the service for ergonomic parity
// with `prisma.user.findMany(...)` (no extra `.collections.` hop).
//
// We do this by mixing a proxy into the prototype chain at construction time.
// Using a class field initializer would not capture `this`. The simplest
// reliable approach: define a thin façade class that forwards to `collections`.

// Db is the shape returned by makeTxProxy and the public type of the
// service. Self-referential: nested $transaction callbacks receive another
// Db proxy bound to the same session.
export type Db = Collections & {
  $transaction: {
    <T>(fn: (tx: Db) => Promise<T>): Promise<T>;
    <T extends readonly unknown[] | []>(
      promises: T,
    ): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }>;
  };
  $runCommandRaw: (command: Document) => Promise<any>;
};

// Augment DatabaseService at the type level so it indexes like `Collections`.
// At runtime we proxy on the instance in a small wrapper below.
export interface DatabaseService extends Collections {}

// Patch the prototype so `service.user` resolves to `service.collections.user`.
// (Done once on module load.)
{
  const proto = DatabaseService.prototype as any;
  for (const key of Object.keys(schema)) {
    if (key in proto) continue;
    Object.defineProperty(proto, key, {
      get(this: DatabaseService) {
        return (this.collections as any)[key];
      },
    });
  }
}

// ─── Tx proxy ───────────────────────────────────────────────────────────────
//
// Builds a Db-shape object whose collection wrappers are session-bound, so
// every operation issued inside `$transaction(callback)` participates in
// the same Mongo transaction.

function makeTxProxy(session: ClientSession): Db {
  const cache: Record<string, CollectionWrapper<any>> = {};
  return new Proxy({} as any, {
    get: (_target, prop) => {
      if (typeof prop === 'symbol' || PROXY_PASSTHROUGH.has(prop)) return undefined;
      const key = String(prop);
      if (key === '$transaction' || key === '$runCommandRaw') {
        // Inside a tx, callers shouldn't open another tx. Return a no-op
        // that just runs the inner work on the same session for safety.
        if (key === '$transaction') {
          return (arg: any) => {
            if (Array.isArray(arg)) return Promise.all(arg);
            return arg(makeTxProxy(session));
          };
        }
        return (cmd: any) => dbClient.db.command(cmd, { session });
      }
      const model = (schema as any)[key] as ModelDef<any> | undefined;
      if (!model) return undefined;
      if (!cache[key]) cache[key] = new CollectionWrapper(model, session);
      return cache[key];
    },
  });
}

// `coerceExtendedJSON` lives in builder/coerce.ts (single source of truth);
// see import at top of this file.
