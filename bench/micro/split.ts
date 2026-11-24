// Where does forge's time go on a real server? Interleaves, per iteration:
// forge's call, the exact SQL forge sends issued straight to the pool, and
// Kysely's SQL issued straight to the pool. forge minus "forge SQL direct" is
// forge's own JavaScript; the two direct rows differ only by SQL text.
//
//   npx ts-node --transpile-only bench/micro/split.ts postgres pk
import { openDialect } from "../compare/deep/dialects";
import { kyselyEngine } from "../compare/deep/engines/kysely";
import { forgeEngine } from "../compare/deep/engines/forge";
import { SCENARIOS } from "../compare/deep/scenarios";
import { LADDER } from "../compare/deep/ladder";
import { uncounted } from "../compare/deep/core";

async function main() {
  const [dialect, ...names] = process.argv.slice(2);
  const ctx: any = await openDialect(dialect as any, Number(process.env.BENCH_SEED ?? 1000), () => {});
  const N = Number(process.env.N ?? 400);
  try {
    const fe: any = await forgeEngine(ctx);
    const ky: any = await kyselyEngine(ctx);
    for (const name of names) {
      const sc: any = [...SCENARIOS, ...LADDER].find((s) => s.name === name);
      // Capture the SQL each engine sends for iteration 1.
      const capture = async (fn: () => Promise<any>) => {
        const sent: Array<[string, any[]]> = [];
        const C = require("pg").Client.prototype;
        const orig = C.query;
        C.query = function (this: any, s: any, p: any, ...rest: any[]) {
          const text = typeof s === "string" ? s : s?.text;
          if (text && !/^(BEGIN|COMMIT|ROLLBACK)/i.test(text)) sent.push([text, typeof s === "string" ? p : s.values]);
          return orig.call(this, s, p, ...rest);
        };
        try { await fn(); } finally { C.query = orig; }
        return sent;
      };
      if (sc.before) await uncounted(() => sc.before(ctx, "forge", 1));
      const fsql = await capture(() => fe.ops[name](1, sc.n ?? 0));
      if (sc.after) await uncounted(() => sc.after(ctx, "forge", 1));
      if (sc.before) await uncounted(() => sc.before(ctx, "kysely", 1));
      const ksql = await capture(() => ky.ops[name](1, sc.n ?? 0));
      if (sc.after) await uncounted(() => sc.after(ctx, "kysely", 1));
      const direct = (sql: Array<[string, any[]]>) => async () => { for (const [s, p] of sql) await ctx.pg.query(s, p); };
      const variants: Record<string, (k: number) => Promise<any>> = {
        forge: (k) => fe.ops[name](k, sc.n ?? 0),
        kysely: (k) => ky.ops[name](k, sc.n ?? 0),
        forge_sql_direct: direct(fsql),
        kysely_sql_direct: direct(ksql),
      };
      const t: Record<string, number[]> = Object.fromEntries(Object.keys(variants).map((k) => [k, []]));
      const keys = Object.keys(variants);
      for (let k = 1; k <= N + 40; k++) {
        for (let j = 0; j < keys.length; j++) {
          const v = keys[(j + k) % keys.length];
          const eng = v === "kysely" ? "kysely" : "forge";
          if (sc.before) await uncounted(() => sc.before(ctx, eng, k));
          const t0 = process.hrtime.bigint();
          await variants[v](k);
          const dt = Number(process.hrtime.bigint() - t0) / 1e6;
          if (sc.after) await uncounted(() => sc.after(ctx, eng, k));
          if (k > 40) t[v].push(dt);
        }
      }
      const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
      console.log(name, Object.entries(t).map(([k, a]) => `${k}=${med(a).toFixed(4)}`).join("  "));
      if (process.env.SHOW) { console.log("  forge sql:", fsql.map(([s]) => s).join(" | ")); console.log("  kysely sql:", ksql.map(([s]) => s).join(" | ")); }
    }
  } finally { await ctx.close(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
