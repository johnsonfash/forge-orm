// Where a 10k-row SQLite findMany spends its time: the driver, dates, JSON, and forge's own overhead.
// npx ts-node --transpile-only bench/micro/sqlite-decode-split.ts
import { createDb, betterSqlite3Driver } from "../../src";
import * as S from "../compare/deep/schema";
import { parseIsoDate } from "../../src/adapters/shared/row-decoder";
const Database = require("better-sqlite3");
const { buildSchemaDDL } = require("../../src/adapters/sqlite/ddl");
const { applyMigration } = require("../../src/adapters/sqlite/migrate");
async function main() {
  const h = new Database(":memory:");
  const schema = S.buildSchema({ geo: "none" });
  const driver = betterSqlite3Driver(h);
  await applyMigration(driver, buildSchemaDDL(schema as any));
  const db: any = await createDb({ schema, driver } as any);
  const insP = h.prepare("INSERT INTO posts (id,author_id,title,body,status,views,version,published_at,created_at,meta) VALUES (?,?,?,?,?,?,?,?,?,?)");
  h.prepare("INSERT INTO users (id,email,name,role,active,created_at,prefs) VALUES ('u','e','n','USER',1,'2025-01-01T00:00:00.000Z','{}')").run();
  const posts = S.seedPosts(S.sizesFor(1000));
  for (const p of posts) insP.run(p.id, "u", p.title, p.body, p.status, p.views, p.version, p.published_at?.toISOString() ?? null, p.created_at.toISOString(), JSON.stringify(p.meta));
  const st = h.prepare('SELECT "posts"."id", "posts"."author_id", "posts"."title", "posts"."body", "posts"."status", "posts"."views", "posts"."version", "posts"."published_at", "posts"."created_at", "posts"."meta" FROM "posts" ORDER BY "posts"."id" ASC LIMIT 10000');
  const cases: Record<string, () => unknown> = {
    driver: () => st.all(),
    "driver+dates": () => { const r = st.all(); for (const x of r) { if (x.published_at) x.published_at = parseIsoDate(x.published_at); x.created_at = parseIsoDate(x.created_at); } return r; },
    "driver+json": () => { const r = st.all(); for (const x of r) x.meta = JSON.parse(x.meta); return r; },
    "driver+dates+json": () => { const r = st.all(); for (const x of r) { if (x.published_at) x.published_at = parseIsoDate(x.published_at); x.created_at = parseIsoDate(x.created_at); x.meta = JSON.parse(x.meta); } return r; },
    forge: () => db.post.findMany({ orderBy: { id: "asc" }, take: 10000 }),
  };
  for (let round = 0; round < 2; round++) for (const [name, fn] of Object.entries(cases)) {
    for (let i = 0; i < 10; i++) await fn();
    const t = process.hrtime.bigint();
    for (let i = 0; i < 60; i++) await fn();
    if (round) console.log(`${name.padEnd(20)} ${(Number(process.hrtime.bigint() - t) / 1e6 / 60).toFixed(2)} ms`);
  }
}
main();
