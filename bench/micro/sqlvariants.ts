// Time SQL variants against a seeded bench database, interleaved.
//   npx ts-node --transpile-only bench/micro/sqlvariants.ts postgres variants.json
// variants.json: { "name": ["SQL", [params]], ... }
import { openDialect } from "../compare/deep/dialects";
import * as fs from "fs";

async function main() {
  const [dialect, file] = process.argv.slice(2);
  const variants: Record<string, [string, any[]]> = JSON.parse(fs.readFileSync(file, "utf8"));
  const ctx: any = await openDialect(dialect as any, Number(process.env.BENCH_SEED ?? 1000), () => {});
  const N = Number(process.env.N ?? 600);
  try {
    const run = async (s: string, p: any[]) => {
      if (ctx.pg) return (await ctx.pg.query(s, p)).rows;
      if (ctx.mysql) return (await ctx.mysql.query(s, p))[0];
      if (ctx.sqlite) return ctx.sqlite.prepare(s).all(...p);
    };
    const keys = Object.keys(variants);
    const t: Record<string, number[]> = Object.fromEntries(keys.map((k) => [k, []]));
    const rows: Record<string, number> = {};
    for (let k = 0; k < N + 30; k++) {
      for (let j = 0; j < keys.length; j++) {
        const v = keys[(j + k) % keys.length];
        const t0 = process.hrtime.bigint();
        const r = await run(...variants[v]);
        const dt = Number(process.hrtime.bigint() - t0) / 1e6;
        rows[v] = Array.isArray(r) ? r.length : -1;
        if (k >= 30) t[v].push(dt);
      }
    }
    const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
    for (const k of keys) console.log(`${k.padEnd(24)} ${med(t[k]).toFixed(4)} ms  rows=${rows[k]}`);
  } finally { await ctx.close(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
