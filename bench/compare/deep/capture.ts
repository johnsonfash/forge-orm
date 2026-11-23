// --capture-only: run forge's side of every scenario against a recording stub
// driver, so the SQL forge generates can be read without a server (the point
// for MSSQL, which has none locally). Nothing executes; the stub answers every
// statement with an empty result, so a multi-step op may stop early (an
// `update` of a row the stub "did not find" throws P2025). The statements
// issued up to that point are still recorded, and the error is reported.

import { createDb } from "../../../src";
import { Dialect } from "./core";
import type { DialectCtx } from "./dialects";
import { forgeEngine } from "./engines/forge";
import type { Scenario } from "./scenarios";
import * as S from "./schema";

function stubDriver(dialect: Dialect, rec: (s: string, p?: unknown[]) => void): any {
  const q = async (sql: string, params?: unknown[]) => { rec(sql, params); return { rows: [], rowCount: 0 }; };
  switch (dialect) {
    case "postgres":
      return { kind: "postgres", jsonParams: "text", query: q, async transaction(fn: any) { rec("BEGIN"); const r = await fn({ query: q }); rec("COMMIT"); return r; }, close: async () => {} };
    case "mysql": {
      const m = async (sql: string, params?: unknown[]) => { rec(sql, params); return [[], []]; };
      return { kind: "mysql", query: m, execute: m, async transaction(fn: any) { rec("START TRANSACTION"); const r = await fn({ query: m, execute: m }); rec("COMMIT"); return r; }, close: async () => {} };
    }
    case "sqlite":
      return {
        kind: "sqlite",
        all: async (s: string, p: unknown[]) => { rec(s, p); return []; },
        get: async (s: string, p: unknown[]) => { rec(s, p); return undefined; },
        run: async (s: string, p: unknown[]) => { rec(s, p); return { changes: 0 }; },
        exec: async (s: string) => { rec(s); },
        close: async () => {},
      };
    case "duckdb":
    case "mssql":
      return { kind: dialect, query: q, async transaction(fn: any) { rec("BEGIN TRANSACTION"); const r = await fn({ query: q }); rec("COMMIT"); return r; }, close: async () => {} };
    default:
      throw new Error(`capture-only is not supported for ${dialect}: forge's Mongo path needs a MongoClient (use db.$explain or db.<model>.compile there)`);
  }
}

export async function runCapture(dialect: Dialect, scenarios: Scenario[], log: (s: string) => void) {
  let current: string[] = [];
  const rec = (s: string, p?: unknown[]) => {
    if (/^\s*select 1\s*$/i.test(s)) return;
    current.push(s.replace(/\s+/g, " ").trim() + (p && p.length ? `   -- params: ${JSON.stringify(p).slice(0, 300)}` : ""));
  };
  const schema = S.buildSchema({ geo: dialect === "sqlite" ? "fallback" : "native" });
  const ddlMod = require(`../../../src/adapters/${dialect}/ddl`);
  const ddl = ddlMod.buildSchemaDDL(schema as any).map((x: any) => (typeof x === "string" ? x : x.sql ?? JSON.stringify(x)));
  const db: any = await createDb({ schema, driver: stubDriver(dialect, rec) } as any);
  const ctx = {
    dialect, sizes: S.sizesFor(Number(process.env.BENCH_SEED ?? 1000)), schema, forge: db, url: "", conn: {}, notes: [],
    features: { geo: true, fts: true, tx: true, json: true, geoMode: dialect === "sqlite" ? "fallback" : "native" },
    close: async () => {},
  } as unknown as DialectCtx;
  const eng = await forgeEngine(ctx, db);
  const out: { scenario: string; sql: string[]; error?: string }[] = [];
  for (const sc of scenarios) {
    current = [];
    const op = eng.ops[sc.name];
    let error: string | undefined;
    if (!op) error = `n/a: ${eng.na?.[sc.name] ?? "not implemented"}`;
    else { try { await op(0, sc.n ?? 0); } catch (e: any) { error = String(e?.message ?? e).split("\n")[0]; } }
    out.push({ scenario: sc.name, sql: current, error });
    log(`${sc.name.padEnd(22)} ${current.length} statement(s)${error ? `  (${error})` : ""}`);
  }
  const L: string[] = [`# forge SQL capture: ${dialect}`, "", "Recorded against a stub driver that returns empty results; nothing executed.", "", "## DDL", "", "```sql", ...ddl, "```", ""];
  for (const o of out) {
    L.push(`## \`${o.scenario}\``, "");
    if (o.error) L.push(`> stopped / note: ${o.error}`, "");
    L.push("```sql", ...(o.sql.length ? o.sql : ["-- (no statements)"]), "```", "");
  }
  return { dialect, ddl, scenarios: out, markdown: L.join("\n") };
}
