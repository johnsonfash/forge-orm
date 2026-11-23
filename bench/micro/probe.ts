// Ad-hoc probe: open a seeded bench dialect and time SQL variants.
// npx ts-node --transpile-only bench/micro/probe.ts <dialect> "<sql1>" "<sql2>" ...
import { openDialect } from "../compare/deep/dialects";

async function main() {
  const [dialect, ...sqls] = process.argv.slice(2);
  const ctx: any = await openDialect(dialect as any, Number(process.env.BENCH_SEED ?? 1000), () => {});
  try {
    for (const sql of sqls) {
      const run = async () => {
        if (ctx.mysql) return (await ctx.mysql.query(sql))[0];
        if (ctx.pg) return (await ctx.pg.query(sql)).rows;
        if (ctx.sqlite) return ctx.sqlite.prepare(sql).all();
        throw new Error("unsupported");
      };
      for (let i = 0; i < 3; i++) await run();
      const t = process.hrtime.bigint();
      const N = 20;
      let n = 0;
      for (let i = 0; i < N; i++) n = (await run()).length;
      console.log(`${(Number(process.hrtime.bigint() - t) / 1e6 / N).toFixed(3)} ms  rows=${n}  ${sql}`);
    }
    if (process.env.EXPLAIN && ctx.mysql) for (const sql of sqls) console.log(JSON.stringify((await ctx.mysql.query("EXPLAIN " + sql))[0]));
  } finally { await ctx.close(); }
}
main();
