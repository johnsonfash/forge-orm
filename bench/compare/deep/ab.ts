// Interleaved comparison: every engine runs one iteration in turn, in a
// rotating order, so a noisy machine slows all of them alike instead of
// whichever engine happened to be running. Settles results the sequential
// deep bench leaves within noise.
//
//   TZ=UTC npx ts-node --transpile-only bench/compare/deep/ab.ts --dialect=postgres \
//     --scenario=pk,fts --engines=forge,kysely,knex [--iter=200]
//
// Same scenarios, engines, fixtures and hooks as run.ts; nothing is written to
// results/. Prints the median per engine and forge's ratio to the best other.

import { EngineImpl, EngineName, now, uncounted } from "./core";
import { DialectCtx, openDialect } from "./dialects";
import { SCENARIOS as BASE, Scenario } from "./scenarios";
import { LADDER } from "./ladder";

const LOADERS: Record<EngineName, () => Promise<(ctx: DialectCtx) => Promise<EngineImpl | { na: string }>>> = {
  raw: async () => (await import("./engines/raw")).rawEngine,
  forge: async () => (await import("./engines/forge")).forgeEngine,
  prisma: async () => (await import("./engines/prisma")).prismaEngine,
  drizzle: async () => (await import("./engines/drizzle")).drizzleEngine,
  kysely: async () => (await import("./engines/kysely")).kyselyEngine,
  knex: async () => (await import("./engines/knex")).knexEngine,
};

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];

async function main() {
  const dialect = arg("dialect") as any;
  const engines = (arg("engines") ?? "forge,kysely,knex").split(",") as EngineName[];
  const iters = Number(arg("iter") ?? 200);
  const all = [...BASE, ...LADDER];
  const wanted = arg("scenario")?.split(",");
  const scenarios: Scenario[] = wanted ? all.filter((s) => wanted.includes(s.name)) : all;
  const ctx = await openDialect(dialect, Number(process.env.BENCH_SEED ?? 1000), () => {});
  try {
    const impls = new Map<EngineName, EngineImpl>();
    for (const e of engines) {
      const im = await (await LOADERS[e]())(ctx);
      if (!("na" in im && typeof (im as any).na === "string")) impls.set(e, im as EngineImpl);
    }
    console.log(`${dialect}: ${iters} interleaved iterations, median ms`);
    console.log(`${"scenario".padEnd(22)}${[...impls.keys()].map((e) => e.padStart(10)).join("")}   forge vs best`);
    for (const sc of scenarios) {
      const live = [...impls.entries()].filter(([, im]) => im.ops[sc.name]);
      if (live.length < 2) continue;
      const times = new Map<EngineName, number[]>(live.map(([e]) => [e, []]));
      const warm = Math.max(5, iters / 10);
      for (let k = 1; k <= warm + iters; k++) {
        const order = live.map((_, j) => live[(j + k) % live.length]);
        for (const [e, im] of order) {
          if (sc.before) await uncounted(() => sc.before!(ctx, e, k));
          const t0 = now();
          try { await im.ops[sc.name](k, sc.n ?? 0); }
          finally {
            const dt = now() - t0;
            if (k > warm) times.get(e)!.push(dt);
            if (sc.after) await uncounted(() => sc.after!(ctx, e, k));
          }
        }
      }
      const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
      const m = new Map([...times].map(([e, a]) => [e, med(a)]));
      const others = [...m].filter(([e]) => e !== "forge" && e !== "raw").map(([, v]) => v);
      const best = others.length ? Math.min(...others) : NaN;
      const f = m.get("forge");
      const verdict = f == null || !Number.isFinite(best) ? "" : f <= best * 1.03 ? "level or faster" : `+${Math.round((f / best - 1) * 100)}%`;
      console.log(`${sc.name.padEnd(22)}${[...impls.keys()].map((e) => (m.has(e) ? m.get(e)!.toFixed(3) : "n/a").padStart(10)).join("")}   ${verdict}`);
    }
  } finally {
    await ctx.forge.$disconnect?.().catch?.(() => {});
    await ctx.close();
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
