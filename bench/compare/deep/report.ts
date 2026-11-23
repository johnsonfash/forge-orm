// Turns a run into results/<dialect>-<stamp>.json + .md and computes the flags.

import * as fs from "fs";
import type { EngineName, Sample } from "./core";
import type { Features } from "./dialects";
import type { SeedSizes } from "./schema";

export interface EngineResult {
  status: "ok" | "na" | "error";
  reason?: string;
  error?: string;
  stack?: string;
  sample?: Sample;
  rt?: number;
  rtAvg?: number;
  sql?: string[];
  canon?: string;
  probe?: [number, number];
  mismatch?: boolean;
}

export interface ScenarioResult { name: string; kind: "read" | "write"; desc: string; engines: Partial<Record<EngineName, EngineResult>> }

export interface RunResult {
  dialect: string; startedAt: string; users: number; iters: number; warmup: number;
  sizes: SeedSizes; features: Features; notes: string[]; engines: EngineName[]; scenarios: ScenarioResult[];
  flags?: Flag[];
}

export interface Flag { scenario: string; engine: EngineName; kind: "slower-than-orm" | "slower-than-raw" | "more-round-trips" | "n-plus-one" | "mismatch" | "error"; detail: string }

const ORMS: EngineName[] = ["prisma", "drizzle", "kysely", "knex"];

export function computeFlags(r: RunResult): Flag[] {
  const flags: Flag[] = [];
  for (const s of r.scenarios) {
    const E = s.engines;
    const ok = (e: EngineName) => E[e]?.status === "ok" ? E[e]! : undefined;
    const raw = ok("raw"), forge = ok("forge");

    const baseName = (raw ? "raw" : forge ? "forge" : r.engines.find((e) => ok(e))) as EngineName | undefined;
    const base = baseName ? ok(baseName) : undefined;
    if (base) {
      for (const e of r.engines) {
        const x = ok(e);
        if (!x || e === baseName) continue;
        if (x.canon !== base.canon) {
          x.mismatch = true;
          flags.push({ scenario: s.name, engine: e, kind: "mismatch", detail: `differs from ${baseName}: ${e}=${clip(x.canon)} vs ${baseName}=${clip(base.canon)}` });
        }
      }
    }
    for (const e of r.engines) {
      const x = E[e];
      if (x?.status === "error") flags.push({ scenario: s.name, engine: e, kind: "error", detail: x.error ?? "" });
      if (x?.status === "ok" && x.probe && x.probe[1] > x.probe[0]) {
        flags.push({ scenario: s.name, engine: e, kind: "n-plus-one", detail: `round trips grow with row count: ${x.probe[0]} -> ${x.probe[1]}` });
      }
    }
    if (forge) {
      const others = ORMS.map((e) => [e, ok(e)] as const).filter(([, v]) => v) as [EngineName, EngineResult][];
      if (others.length) {
        const [bn, best] = others.reduce((a, b) => (b[1].sample!.median < a[1].sample!.median ? b : a));
        const pct = (forge.sample!.median / best.sample!.median - 1) * 100;
        if (pct > 20) flags.push({ scenario: s.name, engine: "forge", kind: "slower-than-orm", detail: `forge ${ms(forge)} vs ${bn} ${ms(best)} (+${pct.toFixed(0)}%)` });
      }
      if (raw) {
        const pct = (forge.sample!.median / raw.sample!.median - 1) * 100;
        if (pct > 30) flags.push({ scenario: s.name, engine: "forge", kind: "slower-than-raw", detail: `forge ${ms(forge)} vs raw ${ms(raw)} (+${pct.toFixed(0)}%)` });
        if ((forge.rt ?? 0) > (raw.rt ?? 0)) flags.push({ scenario: s.name, engine: "forge", kind: "more-round-trips", detail: `forge ${forge.rt} vs raw ${raw.rt}` });
      }
    }
  }
  return flags;
}

const ms = (x: EngineResult) => `${x.sample!.median.toFixed(3)}ms`;
const clip = (s?: string, n = 220) => !s ? String(s) : s.length > n ? s.slice(0, n) + "..." : s;

export function writeReport(r: RunResult, file: string): { console: string; mismatches: number } {
  r.flags = computeFlags(r);
  fs.writeFileSync(`${file}.json`, JSON.stringify(r, null, 2));
  const md = markdown(r);
  fs.writeFileSync(`${file}.md`, md);
  const mismatches = r.flags.filter((f) => f.kind === "mismatch").length;
  return { console: consoleSummary(r), mismatches };
}

function cell(x: EngineResult | undefined, raw: EngineResult | undefined): string {
  if (!x) return "-";
  if (x.status === "na") return "n/a";
  if (x.status === "error") return "**ERROR**";
  const s = x.sample!;
  const vs = raw?.status === "ok" && x !== raw ? ` (${fmtPct(s.median / raw.sample!.median - 1)})` : "";
  return `${s.median.toFixed(3)} / ${s.p95.toFixed(3)} ms${vs} · ${x.rt} rt${x.mismatch ? " · **MISMATCH**" : ""}`;
}

const fmtPct = (f: number) => `${f >= 0 ? "+" : ""}${(f * 100).toFixed(0)}%`;

function markdown(r: RunResult): string {
  const L: string[] = [];
  L.push(`# Deep bench: ${r.dialect}`, "");
  L.push(`Started ${r.startedAt}. Seed: ${r.sizes.users} users, ${r.sizes.posts} posts, ${r.sizes.comments} comments, ${r.sizes.tags} tags, ${r.sizes.places} places. ${r.iters} measured iterations after ${r.warmup} warm-up.`, "");
  L.push(`Server features: ${Object.entries(r.features).map(([k, v]) => `${k}=${v}`).join(", ")}`, "");
  for (const n of r.notes) L.push(`- ${n}`);
  L.push("", "Cells read `median / p95 ms (vs raw) · round trips`. Round trips are counted at the driver for every engine.", "");

  const flags = r.flags ?? [];
  const byKind = (k: Flag["kind"]) => flags.filter((f) => f.kind === k);
  L.push("## Flags", "");
  if (!flags.length) L.push("None.");
  for (const [k, title] of [["mismatch", "Correctness mismatches (FAIL)"], ["error", "Errors"], ["n-plus-one", "N+1 (round trips grow with rows)"],
    ["more-round-trips", "forge uses more round trips than raw"], ["slower-than-raw", "forge > raw by more than 30%"], ["slower-than-orm", "forge > best other ORM by more than 20%"]] as const) {
    const fl = byKind(k);
    if (!fl.length) continue;
    L.push(`### ${title} (${fl.length})`, "");
    for (const f of fl) L.push(`- \`${f.scenario}\` **${f.engine}**: ${f.detail.replace(/\|/g, "\\|")}`);
    L.push("");
  }

  for (const kind of ["read", "write"] as const) {
    L.push(`## ${kind === "read" ? "Reads" : "Writes"}`, "");
    L.push(`| scenario | ${r.engines.join(" | ")} |`, `|---|${r.engines.map(() => "---").join("|")}|`);
    for (const s of r.scenarios.filter((x) => x.kind === kind)) {
      L.push(`| \`${s.name}\` | ${r.engines.map((e) => cell(s.engines[e], s.engines.raw)).join(" | ")} |`);
    }
    L.push("");
  }

  L.push("## Not run", "");
  for (const s of r.scenarios) for (const e of r.engines) {
    const x = s.engines[e];
    if (x?.status === "na") L.push(`- \`${s.name}\` ${e}: ${x.reason}`);
  }
  L.push("");

  L.push("## What forge and raw sent", "");
  for (const s of r.scenarios) {
    L.push(`### \`${s.name}\``, "", s.desc, "");
    for (const e of ["forge", "raw"] as const) {
      const x = s.engines[e];
      if (!x) continue;
      if (x.status === "error") { L.push(`**${e}** ERROR: ${x.error}`, "", "```", x.stack ?? "", "```", ""); continue; }
      if (x.status !== "ok") continue;
      L.push(`**${e}** (${x.rt} round trip${x.rt === 1 ? "" : "s"}${x.probe ? `, probe ${x.probe[0]} -> ${x.probe[1]}` : ""})`, "", "```sql");
      const sql = x.sql ?? [];
      for (const q of sql.slice(0, 12)) L.push(q.length > 1200 ? q.slice(0, 1200) + " ..." : q);
      if (sql.length > 12) L.push(`-- ... ${sql.length - 12} more statements`);
      L.push("```", "");
    }
  }
  return L.join("\n");
}

function consoleSummary(r: RunResult): string {
  const L: string[] = [];
  const w = 12;
  L.push("", `${"scenario".padEnd(22)}${r.engines.map((e) => e.padStart(w)).join("")}   (median ms / round trips)`);
  for (const s of r.scenarios) {
    L.push(s.name.padEnd(22) + r.engines.map((e) => {
      const x = s.engines[e];
      const t = !x ? "-" : x.status === "na" ? "n/a" : x.status === "error" ? "ERR" : `${x.sample!.median.toFixed(2)}/${x.rt}${x.mismatch ? "!" : ""}`;
      return t.padStart(w);
    }).join(""));
  }
  const fl = r.flags ?? [];
  L.push("", `flags: ${fl.length} (${["mismatch", "error", "n-plus-one", "more-round-trips", "slower-than-raw", "slower-than-orm"].map((k) => `${k}=${fl.filter((f) => f.kind === k).length}`).join(", ")})`);
  for (const f of fl.filter((f) => f.kind === "mismatch" || f.kind === "error")) L.push(`  ${f.kind.toUpperCase()} ${f.scenario} ${f.engine}: ${f.detail}`);
  return L.join("\n");
}
