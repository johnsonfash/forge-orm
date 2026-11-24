// Include plans head to head on a seeded bench database: JSON in the parent's
// one statement vs one statement per level, interleaved, across shapes.
//
//   DIALECT=postgres N=40 npx ts-node --transpile-only bench/micro/include-plans.ts
//   BENCH_LATENCY_MS=1 ...           (every round trip waits 1 ms)
//
// The plan is forced through the dialect's bench hook; "auto" is forge's own
// choice (AUTO=1 adds it as a third column).
import { openDialect } from "../compare/deep/dialects";
import { forcePgIncludePlan } from "../../src/adapters/postgres/compile-from-ir";
import { configureCompileCache } from "../../src/ir/compile-cache";

const SIZES = (process.env.SIZES ?? "1,10,100,1000").split(",").map(Number);
type Shape = { name: string; run: (db: any, n: number) => Promise<any>; sizes: number[] };

const SHAPES: Shape[] = [
  { name: "d1 to-one  posts+author", sizes: SIZES,
    run: (db, n) => db.post.findMany({ orderBy: { id: "asc" }, take: n, include: { author: true } }) },
  { name: "d1 to-many users+posts", sizes: SIZES,
    run: (db, n) => db.user.findMany({ orderBy: { id: "asc" }, take: n, include: { posts: { orderBy: { id: "asc" } } } }) },
  { name: "d1 paged   users+posts take5", sizes: SIZES,
    run: (db, n) => db.user.findMany({ orderBy: { id: "asc" }, take: n, include: { posts: { orderBy: { id: "asc" }, take: 5 } } }) },
  { name: "d1 m2m     posts+tags", sizes: SIZES,
    run: (db, n) => db.post.findMany({ orderBy: { id: "asc" }, take: n, select: { id: true, title: true, post_tags: { select: { id: true, tag: { select: { id: true, name: true } } } } } }) },
  { name: "d2 unpaged users+posts+comments", sizes: SIZES,
    run: (db, n) => db.user.findMany({ orderBy: { id: "asc" }, take: n, include: { posts: { orderBy: { id: "asc" }, include: { comments: { orderBy: { id: "asc" }, select: { id: true, post_id: true, body: true } } } } } }) },
  { name: "d2 paged   users+posts5+comments3", sizes: SIZES,
    run: (db, n) => db.user.findMany({ orderBy: { id: "asc" }, take: n, include: { posts: { orderBy: { id: "asc" }, take: 5, include: { comments: { orderBy: { id: "asc" }, take: 3 } } } } }) },
  { name: "d3 paged   include_3", sizes: SIZES,
    run: (db, n) => db.user.findMany({ where: { active: true }, orderBy: { id: "asc" }, take: n,
      include: { posts: { where: { status: "PUBLISHED" }, orderBy: [{ published_at: "desc" }, { id: "asc" }], take: 5,
        select: { id: true, title: true, published_at: true, comments: { orderBy: { id: "asc" }, take: 3, select: { id: true, author: { select: { id: true, email: true } } } } } } } }) },
  { name: "d1 counts  users+_count", sizes: SIZES,
    run: (db, n) => db.user.findMany({ orderBy: { id: "asc" }, take: n, include: { _count: { select: { posts: true, comments: true } } } }) },
  { name: "d2 incl+cnt include_count", sizes: SIZES,
    run: (db, n) => db.user.findMany({ orderBy: { id: "asc" }, take: n, include: { posts: { orderBy: { id: "asc" }, take: 3, include: { _count: { select: { comments: true } } } }, _count: { select: { posts: true } } } }) },
];

async function main() {
  const dialect = process.env.DIALECT ?? "postgres";
  const force = (p: any) => (dialect === "mysql" ? require("../../src/adapters/mysql/execute").forceMysqlIncludePlan(p) : forcePgIncludePlan(p));
  const plans = process.env.AUTO ? ["json", "batched", "auto"] : ["json", "batched"];
  const ctx: any = await openDialect(dialect as any, Number(process.env.BENCH_SEED ?? 1000), () => {});
  const N = Number(process.env.N ?? 40);
  const only = process.env.ONLY?.split(",");
  const db = ctx.forge;
  // A forced plan changes the SQL for an unchanged query shape.
  configureCompileCache({ enabled: false });
  try {
    console.log(`${dialect} latency=${process.env.BENCH_LATENCY_MS ?? 0}ms, ${N} interleaved iterations, median ms (json / per-level)`);
    for (const sh of SHAPES) {
      if (only && !only.some((o) => sh.name.includes(o))) continue;
      const cells: string[] = [];
      for (const n of sh.sizes) {
        const t: Record<string, number[]> = { json: [], batched: [], auto: [] };
        let same = true;
        let ref: string | undefined;
        for (let k = 0; k < N + 4; k++) {
          for (let q = 0; q < plans.length; q++) {
            const plan = plans[(q + k) % plans.length];
            force(plan === "auto" ? undefined : plan);
            const t0 = process.hrtime.bigint();
            const r = await sh.run(db, n);
            const dt = Number(process.hrtime.bigint() - t0) / 1e6;
            if (k >= 4) t[plan].push(dt);
            if (k === 0) { const s = JSON.stringify(r); if (ref === undefined) ref = s; else if (s !== ref) same = false; }
          }
        }
        force(undefined);
        const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
        const j = med(t.json), b = med(t.batched);
        const a = t.auto.length ? `/${med(t.auto).toFixed(2)}` : "";
        cells.push(`${String(n).padStart(4)}: ${j.toFixed(2)}/${b.toFixed(2)}${a}${j < b ? "J" : "B"}${same ? "" : " MISMATCH"}`);
      }
      console.log(`${sh.name.padEnd(34)} ${cells.join("  ")}`);
    }
  } finally { await ctx.close(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
