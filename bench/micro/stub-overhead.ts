// forge's own JavaScript per call, with the database taken out: a stub driver
// answers every statement instantly with a plausible row. What is left is
// validation, IR building, compiling and decoding.
//
//   DIALECT=postgres npx ts-node --transpile-only bench/micro/stub-overhead.ts
//   DIALECT=mysql ONLY=create,pk N=50000 npx ts-node --transpile-only bench/micro/stub-overhead.ts
//   node --cpu-prof -r ts-node/register/transpile-only bench/micro/stub-overhead.ts
import { createDb } from "../../src";
import * as S from "../compare/deep/schema";

const dialect = (process.env.DIALECT ?? "postgres") as "postgres" | "mysql";
const now = new Date("2025-01-01T00:00:00.000Z");
const userRow = { id: "u0001", email: "a@b.c", name: "n", role: "USER", active: true, created_at: now, prefs: { theme: "dark", score: 1 } };

function stub(): any {
  if (dialect === "postgres") {
    const q = async (sql: string) => /^\s*(select|with)/i.test(sql) || /returning/i.test(sql)
      ? { rows: [userRow], rowCount: 1 } : { rows: [], rowCount: 1 };
    return { kind: "postgres", jsonParams: "text", query: q, async transaction(fn: any) { return fn({ query: q }); }, close: async () => {} };
  }
  const m = async (sql: string) => /^\s*select/i.test(sql)
    ? [[{ ...userRow, active: 1, prefs: JSON.stringify(userRow.prefs) }], []]
    : [{ affectedRows: 1, changedRows: 1, insertId: 0, info: "Rows matched: 1  Changed: 1  Warnings: 0" }, []];
  return { kind: "mysql", query: m, execute: m, async transaction(fn: any) { return fn({ query: m, execute: m }); }, close: async () => {} };
}

async function main() {
  const schema = S.buildSchema({ geo: "none" });
  const db: any = await createDb({ schema, driver: stub() } as any);
  const ud = (id: string) => ({ id, email: `${id}@x.dev`, name: "c", role: "USER", active: true, created_at: now, prefs: { theme: "dark", score: 1 } });
  const cases: Record<string, (i: number) => any> = {
    pk: (i) => db.user.findUnique({ where: { id: `u${i % 1000}` } }),
    unique_email: (i) => db.user.findUnique({ where: { email: `e${i % 1000}@x` } }),
    or_not_like: () => db.user.findMany({
      where: { OR: [{ name: { contains: "alice", mode: "insensitive" } }, { email: { startsWith: "bob." } }], NOT: { role: "ADMIN" } },
      orderBy: { id: "asc" }, take: 50,
    }),
    create: (i) => db.user.create({ data: ud(`c${i}`), select: false }),
    update_by_id: (i) => db.user.update({ where: { id: `u${i % 1000}` }, data: { name: `r${i}` }, select: { id: true, name: true, email: true } }),
    upsert_update: (i) => db.user.upsert({ where: { email: "x@y" }, create: ud(`up${i}`), update: { name: "U" }, select: false }),
    delete_by_id: (i) => db.user.delete({ where: { id: `d${i}` } }),
    count: () => db.post.count({ where: { status: "PUBLISHED", views: { gte: 500 } } }),
    include_2: () => db.user.findMany({ orderBy: { id: "asc" }, take: 20,
      include: { posts: { orderBy: { id: "asc" }, include: { comments: { orderBy: { id: "asc" }, select: { id: true, post_id: true, body: true } } } } } }),
    include_3: () => db.user.findMany({ where: { active: true }, orderBy: { id: "asc" }, take: 20,
      include: { posts: { where: { status: "PUBLISHED" }, orderBy: [{ published_at: "desc" }, { id: "asc" }], take: 5,
        select: { id: true, title: true, published_at: true, comments: { orderBy: { id: "asc" }, take: 3, select: { id: true, author: { select: { id: true, email: true } } } } } } } }),
    count_rel: () => db.user.findMany({ orderBy: { id: "asc" }, take: 20, include: { _count: { select: { posts: true, comments: true } } } }),
  };
  const N = Number(process.env.N ?? 30000);
  const only = process.env.ONLY?.split(",");
  for (const [name, fn] of Object.entries(cases)) {
    if (only && !only.includes(name)) continue;
    for (let i = 0; i < 3000; i++) await fn(i);
    const t = process.hrtime.bigint();
    for (let i = 0; i < N; i++) await fn(i);
    console.log(`${dialect} ${name.padEnd(14)} ${(Number(process.hrtime.bigint() - t) / 1000 / N).toFixed(2)} us/op`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
