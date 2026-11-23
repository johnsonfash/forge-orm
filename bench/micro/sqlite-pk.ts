// Per-call overhead on SQLite, where the database cost is near zero.
// npx ts-node --transpile-only bench/micro/sqlite-pk.ts
import { createDb, betterSqlite3Driver } from "../../src";
import * as S from "../compare/deep/schema";
const Database = require("better-sqlite3");
const { buildSchemaDDL } = require("../../src/adapters/sqlite/ddl");
const { applyMigration } = require("../../src/adapters/sqlite/migrate");

async function main() {
  const h = new Database(":memory:");
  const schema = S.buildSchema({ geo: "none" });
  const driver = betterSqlite3Driver(h);
  await applyMigration(driver, buildSchemaDDL(schema as any));
  const db: any = await createDb({ schema, driver } as any);
  const ins = h.prepare("INSERT INTO users (id,email,name,role,active,created_at,prefs) VALUES (?,?,?,?,?,?,?)");
  const insP = h.prepare("INSERT INTO posts (id,author_id,title,body,status,views,version,published_at,created_at,meta) VALUES (?,?,?,?,?,?,?,?,?,?)");
  for (let n = 1; n <= 1000; n++) {
    ins.run(S.userId(n), S.emailFor(n), `n${n}`, "USER", 1, new Date().toISOString(), JSON.stringify({ theme: "dark", score: n }));
    for (let k = 0; k < 10; k++) insP.run(S.postId(n * 10 + k), S.userId(n), "t", "body kilo", "PUBLISHED", k, 0, null, new Date().toISOString(), "{}");
  }
  const N = Number(process.env.N ?? 20000);
  const only = process.env.ONLY;
  const cases: Record<string, (i: number) => any> = {
    raw_pk: (() => { const st = h.prepare("SELECT * FROM users WHERE id = ?"); return (i: number) => { const r = st.get(S.userId((i % 1000) + 1)); if (r) { r.active = !!r.active; r.created_at = new Date(r.created_at); r.prefs = JSON.parse(r.prefs); } return r; }; })(),
    pk: (i) => db.user.findUnique({ where: { id: S.userId((i % 1000) + 1) } }),
    email: (i) => db.user.findUnique({ where: { email: S.emailFor((i % 1000) + 1) } }),
    exists: (i) => db.user.findFirst({ where: { email: S.emailFor((i % 1000) + 1) }, select: { id: true } }),
    select_cols: (i) => db.post.findMany({ where: { author_id: S.userId((i % 1000) + 1) }, select: { id: true, title: true, views: true }, orderBy: { id: "asc" } }),
    update: (i) => db.user.update({ where: { id: S.userId((i % 1000) + 1) }, data: { name: `r${i}` } }),
    update_many: (i) => db.post.updateMany({ where: { author_id: S.userId((i % 1000) + 1) }, data: { views: 42 } }),
    create: (i) => db.user.create({ data: { id: `c_${i}_${Math.random()}`, email: `c${i}_${Math.random()}@x.dev`, name: "c", role: "USER", active: true, created_at: new Date(), prefs: { a: 1 } } }),
    delete: async (i) => { const id = `d_${i}_${Math.random()}`; h.prepare("INSERT INTO users (id,email,name,role,active,created_at,prefs) VALUES (?,?,?,?,?,?,?)").run(id, id, "d", "USER", 1, "2025-01-01T00:00:00.000Z", "{}"); return db.user.delete({ where: { id } }); },
    raw_delete: async (i) => { const id = `rd_${i}_${Math.random()}`; h.prepare("INSERT INTO users (id,email,name,role,active,created_at,prefs) VALUES (?,?,?,?,?,?,?)").run(id, id, "d", "USER", 1, "2025-01-01T00:00:00.000Z", "{}"); return h.prepare("DELETE FROM users WHERE id = ? RETURNING *").get(id); },
    stream: async () => { let n = 0; for await (const r of db.post.findManyStream({ orderBy: { id: "asc" }, take: 10000 })) n += r.views; return n; },
    large: () => db.post.findMany({ orderBy: { id: "asc" }, take: 10000 }),
  };
  for (const [name, fn] of Object.entries(cases)) {
    if (only && !only.split(",").includes(name)) continue;
    const n = name === "large" || name === "stream" ? 50 : N;
    for (let i = 0; i < Math.min(n, 2000); i++) await fn(i);
    const t = process.hrtime.bigint();
    for (let i = 0; i < n; i++) await fn(i);
    const us = Number(process.hrtime.bigint() - t) / 1000 / n;
    console.log(`${name.padEnd(12)} ${us.toFixed(2)} us/op`);
  }
}
main();
