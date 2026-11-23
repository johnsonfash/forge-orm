// Round-trip counting. Each driver's lowest public "send a statement" method is
// wrapped once, at the prototype, so every engine sharing that driver package
// (forge, raw, Drizzle, Kysely, Knex, Prisma's driver adapter) is counted the
// same way. A depth guard stops a convenience method that delegates to another
// patched method (DuckDB's runAndReadAll -> run) from counting twice.
//
// Prisma on MySQL goes through the `mariadb` package, which has no single
// stable prototype to wrap, so that engine counts via Prisma's own query event.

import { RT } from "./core";

let depth = 0;
const done = new Set<string>();

// BENCH_LATENCY_MS simulates a network: every round trip waits this long
// before it is sent, for every engine alike. Only where the call is
// asynchronous anyway (pg, mysql2); a streaming call is left alone.
const LATENCY = Number(process.env.BENCH_LATENCY_MS ?? 0);

function wrap(proto: any, methods: string[], textOf: (this: any, args: any[]) => unknown = (a) => a[0], delayable = false) {
  for (const m of methods) {
    const orig = proto?.[m];
    if (typeof orig !== "function" || orig.__benchWrapped) continue;
    const w = function (this: any, ...args: any[]) {
      const top = depth === 0;
      if (top) RT.hit(textOf.call(this, args));
      const run = () => { depth++; try { return orig.apply(this, args); } finally { depth--; } };
      if (LATENCY > 0 && delayable && top) {
        const cb = typeof args[args.length - 1] === "function";
        const submittable = args[0] && typeof args[0] === "object" && typeof args[0].submit === "function";
        if (cb && !submittable) { setTimeout(run, LATENCY); return undefined; }
        if (!cb && !submittable && m === "query" && proto.constructor?.name === "Client") {
          return new Promise((r) => setTimeout(r, LATENCY)).then(run);
        }
      }
      return run();
    };
    (w as any).__benchWrapped = true;
    proto[m] = w;
  }
}

export function instrument(dialect: string, extra?: { sqliteHandle?: any }): void {
  if (dialect === "postgres" && !done.has("pg")) {
    done.add("pg");
    wrap(require("pg").Client.prototype, ["query"], undefined, true);
  }
  if (dialect === "mysql" && !done.has("mysql2")) {
    done.add("mysql2");
    // mysql2's package "exports" hide lib/, so load the file by its path.
    wrap(require(require("node:path").join(require("node:path").dirname(require.resolve("mysql2")), "lib/base/connection.js")).prototype, ["query", "execute"], undefined, true);
  }
  if (dialect === "sqlite" && extra?.sqliteHandle && !done.has("sqlite")) {
    done.add("sqlite");
    const h = extra.sqliteHandle;
    wrap(Object.getPrototypeOf(h), ["exec"]);
    // A statement carries its SQL on `this.source`, not in its arguments.
    const st = h.prepare("SELECT 1");
    wrap(Object.getPrototypeOf(st), ["run", "get", "all", "iterate"], function (this: any) { return this?.source; });
  }
  if (dialect === "duckdb" && !done.has("duckdb")) {
    done.add("duckdb");
    const d = require("@duckdb/node-api");
    wrap(d.DuckDBConnection.prototype, ["run", "runAndRead", "runAndReadAll", "runAndReadUntil", "stream",
      "streamAndRead", "streamAndReadAll", "streamAndReadUntil", "start", "startStream"]);
    if (d.DuckDBPreparedStatement) wrap(d.DuckDBPreparedStatement.prototype, ["run", "runAndReadAll", "stream", "streamAndReadAll"], () => "prepared");
  }
  // tedious is the wire layer under the mssql package, Kysely and Knex alike,
  // so it is the one place that sees every SQL Server round trip once.
  if (dialect === "mssql" && !done.has("tedious")) {
    done.add("tedious");
    wrap(require("tedious").Connection.prototype,
      ["execSql", "execSqlBatch", "execute", "callProcedure", "beginTransaction", "commitTransaction", "rollbackTransaction", "saveTransaction"],
      (a) => a[0]?.sqlTextOrProcedure ?? "TRANSACTION");
  }
}

const IGNORED_MONGO = new Set(["hello", "ismaster", "isMaster", "ping", "saslStart", "saslContinue", "endSessions", "buildInfo", "getParameter"]);

export function instrumentMongoClient(client: any): void {
  client.on("commandStarted", (e: any) => {
    if (IGNORED_MONGO.has(e.commandName)) return;
    const cmd = { ...e.command };
    delete cmd.lsid; delete cmd.$clusterTime; delete cmd.$db; delete cmd.txnNumber;
    RT.hit({ text: `${e.commandName} ${safe(cmd)}` });
  });
}

function safe(o: any): string {
  try {
    return JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? Number(v) : v)).slice(0, 1500);
  } catch { return "[unserialisable]"; }
}
