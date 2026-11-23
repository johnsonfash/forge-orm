// Before/after table from two deep-bench JSON reports of the same dialect.
// node bench/micro/compare-runs.js <before.json> <after.json>
const [a, b] = process.argv.slice(2).map((f) => require(require("path").resolve(f)));
const cell = (e) => (!e ? "-" : e.status === "ok" ? `${e.sample.median.toFixed(3)}/${e.rt}` : e.status === "na" ? "n/a" : e.status === "mismatch" ? "MISMATCH" : "ERR");
const ms = (e) => (e && e.status === "ok" ? e.sample.median : Infinity);
const mismatch = (r, s, e) => (r.flags || []).some((f) => f.scenario === s && f.engine === e && f.kind === "mismatch");
const before = new Map(a.scenarios.map((s) => [s.name, s]));
console.log(`### ${b.dialect}\n`);
console.log("| scenario | forge before | forge after | raw | best other ORM | verdict |");
console.log("|---|---|---|---|---|---|");
for (const s of b.scenarios) {
  const f = s.engines.forge, r = s.engines.raw;
  let best = null, bestName = "";
  for (const [n, e] of Object.entries(s.engines)) {
    if (n === "forge" || n === "raw" || !e || e.status !== "ok") continue;
    if (!best || ms(e) < ms(best)) { best = e; bestName = n; }
  }
  const pre = before.get(s.name)?.engines?.forge;
  const mm = mismatch(b, s.name, "forge") ? " MISMATCH" : "";
  const verdict = !best ? "" : ms(f) <= ms(best) * 1.05 ? "best" : `+${Math.round((ms(f) / ms(best) - 1) * 100)}% vs ${bestName}`;
  console.log(`| \`${s.name}\` | ${cell(pre)}${pre && mismatch(a, s.name, "forge") ? " MISMATCH" : ""} | ${cell(f)}${mm} | ${cell(r)} | ${best ? `${bestName} ${cell(best)}` : "-"} | ${verdict} |`);
}
