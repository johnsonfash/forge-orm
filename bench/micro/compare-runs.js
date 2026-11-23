// Before/after table from two deep-bench JSON reports of the same dialect.
//   node bench/micro/compare-runs.js <before.json> <after.json> [out.md]
// Every scenario: forge before and after, then raw and each other engine
// (median ms / round trips), and forge's standing against Kysely, Knex and
// the best other ORM: faster, level (within 5%) or slower.
const fs = require("fs");
const path = require("path");
const [a, b] = process.argv.slice(2, 4).map((f) => require(path.resolve(f)));
const out = process.argv[4];
const ok = (e) => e && e.status === "ok";
const ms = (e) => (ok(e) ? e.sample.median : Infinity);
const cell = (e) => (!e ? "-" : ok(e) ? `${e.sample.median.toFixed(3)}/${e.rt}` : e.status === "na" ? "n/a" : "ERR");
const mm = (r, s, e) => ((r.flags || []).some((f) => f.scenario === s && f.engine === e && f.kind === "mismatch") ? " MISMATCH" : "");
const mark = (f, o) => (!ok(f) || !ok(o) ? "" : ms(f) <= ms(o) * 0.95 ? "faster" : ms(f) <= ms(o) * 1.05 ? "level" : `slower +${Math.round((ms(f) / ms(o) - 1) * 100)}%`);
const before = new Map(a.scenarios.map((s) => [s.name, s]));
const lines = [`### ${b.dialect}`, "", `Seed ${b.users} users, ${b.iters} iterations. Cells: median ms / round trips. Before = 2.26.0, after = this tree.`, "",
  "| scenario | forge before | forge after | raw | prisma | drizzle | kysely | knex | vs kysely | vs knex | vs best ORM |",
  "|---|---|---|---|---|---|---|---|---|---|---|"];
for (const s of b.scenarios) {
  const E = s.engines, f = E.forge;
  const best = ["prisma", "drizzle", "kysely", "knex"].filter((n) => ok(E[n])).sort((x, y) => ms(E[x]) - ms(E[y]))[0];
  const pre = before.get(s.name)?.engines?.forge;
  lines.push(`| \`${s.name}\` | ${cell(pre)}${pre ? mm(a, s.name, "forge") : ""} | ${cell(f)}${mm(b, s.name, "forge")} | ${cell(E.raw)} | ${cell(E.prisma)} | ${cell(E.drizzle)} | ${cell(E.kysely)} | ${cell(E.knex)} | ${mark(f, E.kysely)} | ${mark(f, E.knex)} | ${best ? `${mark(f, E[best])} (${best})` : ""} |`);
}
const text = lines.join("\n") + "\n";
if (out) fs.writeFileSync(out, text);
process.stdout.write(text);
