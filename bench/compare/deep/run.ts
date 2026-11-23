/* eslint-disable no-console */
// Deep comparison runner. One dialect per invocation:
//
//   npm run forge:bench:deep -- --dialect=sqlite [--scenario=a,b] [--engines=forge,raw] [--capture-only]
//
// See bench/compare/README.md for what each scenario means and how to read the
// report it writes to bench/compare/results/.

process.env.TZ = "UTC";

import * as fs from "fs";
import * as path from "path";
import { counted, DIALECTS, Dialect, EngineImpl, EngineName, ENGINES, now, RT, stable, summarize, uncounted } from "./core";
import { DialectCtx, openDialect } from "./dialects";
import { SCENARIOS as BASE, Scenario } from "./scenarios";
import { LADDER } from "./ladder";

// The ladder rungs sit with their kind, after the original catalogue.
const SCENARIOS: Scenario[] = [
  ...BASE.filter((s) => s.kind === "read"), ...LADDER.filter((s) => s.kind === "read"),
  ...BASE.filter((s) => s.kind === "write"), ...LADDER.filter((s) => s.kind === "write"),
];
import { EngineResult, ScenarioResult, RunResult, writeReport } from "./report";
import { runCapture } from "./capture";

const ENGINE_LOADERS: Record<EngineName, () => Promise<(ctx: DialectCtx) => Promise<EngineImpl | { na: string }>>> = {
  raw: async () => (await import("./engines/raw")).rawEngine,
  forge: async () => (await import("./engines/forge")).forgeEngine,
  prisma: async () => (await import("./engines/prisma")).prismaEngine,
  drizzle: async () => (await import("./engines/drizzle")).drizzleEngine,
  kysely: async () => (await import("./engines/kysely")).kyselyEngine,
  knex: async () => (await import("./engines/knex")).knexEngine,
};

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "true";
}

const log = (s: string) => console.log(`[deep] ${s}`);

async function main() {
  const dialect = arg("dialect") as Dialect | undefined;
  if (!dialect || !DIALECTS.includes(dialect)) {
    console.error(`--dialect is required, one of: ${DIALECTS.join(", ")}`);
    process.exit(2);
  }
  const onlyScen = arg("scenario")?.split(",").filter(Boolean);
  const engines = (arg("engines")?.split(",").filter(Boolean) as EngineName[] | undefined) ?? ENGINES;
  for (const e of engines) if (!ENGINES.includes(e)) { console.error(`unknown engine ${e}`); process.exit(2); }
  const scenarios = SCENARIOS.filter((s) => !onlyScen || onlyScen.includes(s.name));
  if (onlyScen) for (const n of onlyScen) if (!SCENARIOS.some((s) => s.name === n)) { console.error(`unknown scenario ${n}`); process.exit(2); }

  const resultsDir = path.join(__dirname, "..", "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  if (arg("capture-only")) {
    const out = await runCapture(dialect, scenarios, log);
    const file = path.join(resultsDir, `${dialect}-capture-${stamp}`);
    fs.writeFileSync(`${file}.json`, JSON.stringify(out, null, 2));
    fs.writeFileSync(`${file}.md`, out.markdown);
    log(`wrote ${file}.md`);
    return;
  }

  const users = Number(process.env.BENCH_SEED ?? 1000);
  const iters = Number(process.env.BENCH_ITER ?? 30);
  const warm = Number(process.env.BENCH_WARMUP ?? Math.max(2, Math.ceil(iters / 10)));
  log(`dialect=${dialect} users=${users} iter=${iters} warmup=${warm} engines=${engines.join(",")}`);

  const ctx = await openDialect(dialect, users, log);
  const impls = new Map<EngineName, EngineImpl | { na: string }>();
  const result: RunResult = {
    dialect, startedAt: new Date().toISOString(), users, iters, warmup: warm,
    sizes: ctx.sizes, features: ctx.features, notes: ctx.notes, engines, scenarios: [],
  };
  try {
    for (const e of engines) {
      try { impls.set(e, await (await ENGINE_LOADERS[e]())(ctx)); }
      catch (err: any) { impls.set(e, { na: `failed to start: ${firstLine(err)}` }); }
      const im = impls.get(e)!;
      log(`engine ${e}: ${"na" in im && typeof (im as any).na === "string" ? `n/a (${(im as any).na})` : "ready"}`);
    }

    for (const sc of scenarios) {
      const sr: ScenarioResult = { name: sc.name, kind: sc.kind, desc: sc.desc, engines: {} };
      result.scenarios.push(sr);
      const missing = (sc.needs ?? []).filter((n) => !ctx.features[n]);
      for (const e of engines) {
        const im = impls.get(e)!;
        let er: EngineResult;
        if (missing.length) er = { status: "na", reason: `server lacks ${missing.join(", ")}` };
        else if (typeof (im as any).na === "string") er = { status: "na", reason: (im as any).na };
        else {
          const impl = im as EngineImpl;
          const op = impl.ops[sc.name];
          if (!op) er = { status: "na", reason: impl.na?.[sc.name] ?? "not implemented for this engine" };
          else er = await runOne(ctx, sc, e, op, iters, warm);
        }
        sr.engines[e] = er;
        const tag = er.status === "ok" ? `${er.sample!.median.toFixed(3)}ms rt=${er.rt}` : er.status === "na" ? `n/a` : `ERROR ${er.error}`;
        log(`${sc.name.padEnd(22)} ${e.padEnd(8)} ${tag}`);
      }
    }
  } finally {
    for (const im of impls.values()) if ((im as EngineImpl).close) await (im as EngineImpl).close().catch(() => {});
    await ctx.forge.$disconnect?.().catch?.(() => {});
    await ctx.close().catch((e) => log(`cleanup failed: ${e.message}`));
  }

  const file = path.join(resultsDir, `${dialect}-${stamp}`);
  const summary = writeReport(result, file);
  log(`wrote ${file}.md and ${file}.json`);
  console.log(summary.console);
  if (summary.mismatches > 0) {
    console.error(`\n!!!!!!!! ${summary.mismatches} CORRECTNESS MISMATCH(ES) - engines returned different results. See the report. !!!!!!!!\n`);
    process.exitCode = 1;
  }
}

async function runOne(ctx: DialectCtx, sc: Scenario, engine: EngineName, op: (i: number, n: number) => Promise<unknown>, iters: number, warm: number): Promise<EngineResult> {
  const n = sc.n ?? 0;
  const hooks = async (fn: Scenario["before"], i: number) => { if (fn) await uncounted(() => fn(ctx, engine, i)); };
  try {
    await hooks(sc.before, 0);
    let first;
    try { first = await counted(() => op(0, n), true); }
    finally { if (!sc.check) await hooks(sc.after, 0); }
    let value = first.value;
    if (sc.check) {
      try { value = await uncounted(() => sc.check!(ctx, engine, 0)); }
      finally { await hooks(sc.after, 0); }
    }
    const canon = stable(sc.canon(value));

    let probe: [number, number] | undefined;
    if (sc.probe) {
      const a = await counted(() => op(0, sc.probe![0]));
      const b = await counted(() => op(0, sc.probe![1]));
      probe = [a.rt, b.rt];
    }

    const runs: number[] = [];
    let rtTotal = 0;
    for (let k = 1; k <= warm + iters; k++) {
      await hooks(sc.before, k);
      RT.n = 0; RT.on = true;
      const t0 = now();
      try { await op(k, n); }
      finally {
        const dt = now() - t0;
        RT.on = false;
        if (k > warm) { runs.push(dt); rtTotal += RT.n; }
        await hooks(sc.after, k);
      }
    }
    return {
      status: "ok", sample: summarize(runs), rt: first.rt, rtAvg: iters ? rtTotal / iters : first.rt,
      sql: first.sql, canon, probe,
    };
  } catch (err: any) {
    RT.on = false;
    return { status: "error", error: firstLine(err), stack: String(err?.stack ?? "").split("\n").slice(0, 6).join("\n") };
  }
}

function firstLine(e: any): string {
  return String(e?.message ?? e).split("\n").filter(Boolean)[0]?.slice(0, 300) ?? String(e);
}

main().catch((e) => { console.error(e); process.exit(1); });
