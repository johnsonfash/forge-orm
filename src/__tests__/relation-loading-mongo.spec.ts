import { f, model, rel, setActiveSchema } from '../index';
import type { ModelDef } from '../schema/types';
import type { SelectNode } from '../ir/types';
import { buildSelect, buildCount } from '../ir/build';
import { executeCount, executeSelect } from '../adapters/mongo/execute';
import { compileSelectPipeline } from '../adapters/mongo/compile-from-ir';

// Mongo's half of relation loading. A nested `take` used to cost one find per
// parent; it is one aggregation per level now ($setWindowFields). Relation
// filters (`some` / `none` / `every`) used to be refused outright; they resolve
// to an $in / $nin on the parent key, or to a $lookup when the key set is too
// large to inline. The fake database below evaluates the stages forge sends,
// so these assert both what was sent and what it returns.

const User = model('users', { id: f.id({ type: 'string' }), email: f.string() }).relate(() => ({
  posts: rel.many('post', { on: 'author_id', refs: 'id' }),
}));
const Post = model('posts', {
  id: f.id({ type: 'string' }),
  author_id: f.string(),
  status: f.string(),
  rank: f.int(),
  deleted_at: f.dateTime().optional().softDeleteAt(),
}).relate(() => ({
  author: rel.one('user', { on: 'author_id', refs: 'id' }),
  comments: rel.many('comment', { on: 'post_id', refs: 'id' }),
}));
const Comment = model('comments', { id: f.id({ type: 'string' }), post_id: f.string(), body: f.string() });

const sch = { user: User, post: Post, comment: Comment } as never;
const SC = sch as unknown as Record<string, ModelDef<any>>;

// ---- a small evaluator for the filters and stages forge emits ----------------

type Doc = Record<string, any>;

function get(doc: Doc, path: string): any {
  return path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), doc as any);
}
function cmp(a: any, b: any): number {
  if (a === b) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([k, cond]) => {
    if (k === '$and') return (cond as Doc[]).every((c) => matches(doc, c));
    if (k === '$or') return (cond as Doc[]).some((c) => matches(doc, c));
    if (k === '$nor') return !(cond as Doc[]).some((c) => matches(doc, c));
    const v = get(doc, k);
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
      return Object.entries(cond).every(([op, arg]) => {
        switch (op) {
          case '$in': return (arg as any[]).some((a) => cmp(a, v ?? null) === 0);
          case '$nin': return !(arg as any[]).some((a) => cmp(a, v ?? null) === 0);
          case '$ne': return cmp(v ?? null, arg) !== 0;
          case '$exists': return (v !== undefined) === arg;
          case '$gt': return v != null && cmp(v, arg) > 0;
          case '$lte': return v != null && cmp(v, arg) <= 0;
          default: throw new Error(`fake: ${op}`);
        }
      });
    }
    return cmp(v ?? null, cond) === 0;
  });
}
function sortBy(docs: Doc[], spec: Record<string, 1 | -1>): Doc[] {
  return [...docs].sort((a, b) => {
    for (const [k, d] of Object.entries(spec)) { const c = cmp(get(a, k), get(b, k)); if (c) return c * d; }
    return 0;
  });
}

function fakeDb(data: Record<string, Doc[]>, opts: { noWindows?: boolean } = {}) {
  const calls: { op: string; coll: string; arg: any; options?: any }[] = [];
  const run = (coll: string, pipeline: Doc[]): Doc[] => {
    let docs = (data[coll] ?? []).map((d) => ({ ...d }));
    for (const st of pipeline) {
      const [name, a] = Object.entries(st)[0] as [string, any];
      if (name === '$match') docs = docs.filter((d) => matches(d, a));
      else if (name === '$sort') docs = sortBy(docs, a);
      else if (name === '$skip') docs = docs.slice(a);
      else if (name === '$limit') docs = docs.slice(0, a);
      else if (name === '$unset') docs.forEach((d) => (a as string[]).forEach((k) => delete d[k]));
      else if (name === '$project') docs = docs.map((d) => Object.fromEntries(Object.keys(a).filter((k) => k in d).map((k) => [k, d[k]])));
      else if (name === '$group') {
        const seen = new Map<any, Doc>();
        for (const d of docs) { const k = get(d, a._id.slice(1)); if (!seen.has(k)) seen.set(k, { _id: k }); }
        docs = [...seen.values()];
      } else if (name === '$setWindowFields') {
        if (opts.noWindows) throw Object.assign(new Error("Unrecognized pipeline stage name: '$setWindowFields'"), { code: 40324 });
        const out = Object.keys(a.output)[0];
        const parts = new Map<any, Doc[]>();
        for (const d of docs) { const k = get(d, a.partitionBy.slice(1)); parts.set(k, [...(parts.get(k) ?? []), d]); }
        docs = [];
        for (const list of parts.values()) sortBy(list, a.sortBy).forEach((d, i) => docs.push({ ...d, [out]: i + 1 }));
      } else if (name === '$lookup') {
        docs = docs.map((d) => ({
          ...d,
          [a.as]: run(a.from, [{ $match: { [a.foreignField]: get(d, a.localField) ?? null } }, ...a.pipeline]),
        }));
      } else throw new Error(`fake: stage ${name}`);
    }
    return docs;
  };
  const db = {
    collection(coll: string) {
      return {
        find(filter: Doc) {
          const st: Doc = { filter };
          const cur: any = {
            project(p: Doc) { st.project = p; return cur; },
            sort(s: [string, 1 | -1][]) { st.sort = Object.fromEntries(s); return cur; },
            skip(n: number) { st.skip = n; return cur; },
            limit(n: number) { st.limit = n; return cur; },
            batchSize(n: number) { st.batchSize = n; return cur; },
            async toArray() {
              calls.push({ op: 'find', coll, arg: st });
              const p: Doc[] = [{ $match: filter }];
              if (st.sort) p.push({ $sort: st.sort });
              if (st.skip) p.push({ $skip: st.skip });
              if (st.limit) p.push({ $limit: st.limit });
              if (st.project) p.push({ $project: st.project });
              return run(coll, p);
            },
          };
          return cur;
        },
        async countDocuments(filter: Doc) {
          calls.push({ op: 'count', coll, arg: filter });
          return run(coll, [{ $match: filter }]).length;
        },
        aggregate(pipeline: Doc[], options?: Doc) {
          return { toArray: async () => { calls.push({ op: 'aggregate', coll, arg: pipeline, options }); return run(coll, pipeline); } };
        },
      };
    },
  };
  return { db: db as any, calls };
}

const DATA = () => ({
  users: [1, 2, 3, 4].map((n) => ({ _id: `u${n}`, email: `u${n}@x` })),
  posts: [
    { _id: 'p1', author_id: 'u1', status: 'PUBLISHED', rank: 3 },
    { _id: 'p2', author_id: 'u1', status: 'DRAFT', rank: 1 },
    { _id: 'p3', author_id: 'u1', status: 'PUBLISHED', rank: 2 },
    { _id: 'p4', author_id: 'u2', status: 'PUBLISHED', rank: 5 },
    { _id: 'p5', author_id: 'u3', status: 'DRAFT', rank: 1 },
    { _id: 'p6', author_id: 'u3', status: 'PUBLISHED', rank: 9, deleted_at: new Date() },
  ],
  comments: [1, 2, 3, 4, 5].map((n) => ({ _id: `c${n}`, post_id: n <= 3 ? 'p1' : 'p4', body: 'b' })),
});

const users = (args: any): SelectNode => buildSelect('user', SC.user, { ...args, where: { ...(args.where ?? {}) } }, 'many', SC as any);
const ids = (rows: any[]) => rows.map((r) => r.id);

beforeAll(() => setActiveSchema(sch));

describe('a nested take is one aggregation per level', () => {
  test('every parent gets its own page, in one query', async () => {
    const { db, calls } = fakeDb(DATA());
    const rows = await executeSelect(users({ orderBy: { id: 'asc' }, include: { posts: { orderBy: [{ rank: 'desc' }], take: 1, skip: 1 } } }), SC.user, { db });
    expect(calls.map((c) => `${c.op} ${c.coll}`)).toEqual(['find users', 'aggregate posts']);
    const pipe = calls[1].arg;
    expect(pipe.find((s: any) => s.$setWindowFields).$setWindowFields).toMatchObject({ partitionBy: '$author_id', sortBy: { rank: -1 } });
    expect(pipe).toContainEqual({ $match: { __forge_rn: { $gt: 1, $lte: 2 } } });
    // u1 has p1 (3), p3 (2), p2 (1): skip 1 take 1 → p3. u3's live post is p5 only.
    expect(rows.map((u: any) => ids(u.posts))).toEqual([['p3'], [], [], []]);
    expect(rows[0].posts[0]).not.toHaveProperty('__forge_rn');
  });

  test('a server before 5.0 falls back to a find per parent and remembers', async () => {
    const { db, calls } = fakeDb(DATA(), { noWindows: true });
    const node = users({ orderBy: { id: 'asc' }, include: { posts: { orderBy: [{ rank: 'desc' }], take: 1 } } });
    const rows = await executeSelect(node, SC.user, { db });
    expect(rows.map((u: any) => ids(u.posts))).toEqual([['p1'], ['p4'], ['p5'], []]);
    calls.length = 0;
    await executeSelect(node, SC.user, { db });
    expect(calls.filter((c) => c.op === 'aggregate')).toHaveLength(0);
    expect(calls.filter((c) => c.coll === 'posts')).toHaveLength(4);
  });

  test('a batched level sorts by the join key first and asks for the whole result in one batch', async () => {
    const { db, calls } = fakeDb(DATA());
    const rows = await executeSelect(users({ orderBy: { id: 'asc' }, include: { posts: { orderBy: { id: 'desc' }, include: { comments: { orderBy: { id: 'desc' } } } } } }), SC.user, { db });
    const comments = calls.find((c) => c.coll === 'comments')!;
    expect(comments.arg.sort).toEqual({ post_id: 1, _id: -1 });
    expect(comments.arg.batchSize).toBeGreaterThan(1000);
    expect(ids(rows[0].posts)).toEqual(['p3', 'p2', 'p1']);
    expect(ids(rows[0].posts[2].comments)).toEqual(['c3', 'c2', 'c1']);
  });
});

describe('relation filters on Mongo', () => {
  const cases: Array<[string, any, string[]]> = [
    ['some', { posts: { some: { status: 'PUBLISHED' } } }, ['u1', 'u2']],
    ['none', { posts: { none: { status: 'PUBLISHED' } } }, ['u3', 'u4']],
    // u3's only published post is soft-deleted, so its live posts are all drafts.
    ['every', { posts: { every: { status: 'DRAFT' } } }, ['u3', 'u4']],
    ['every, no filter', { posts: { every: {} } }, ['u1', 'u2', 'u3']],
    ['nested some', { posts: { some: { comments: { some: { body: 'b' } } } } }, ['u1', 'u2']],
    ['inside OR', { OR: [{ email: 'u4@x' }, { posts: { some: { rank: { gt: 4 } } } }] }, ['u2', 'u4']],
  ];

  test.each(cases)('%s: resolved to a key list, then a plain find', async (_n, where, expected) => {
    const { db, calls } = fakeDb(DATA());
    const rows = await executeSelect(users({ where, orderBy: { id: 'asc' } }), SC.user, { db });
    expect(ids(rows)).toEqual(expected);
    expect(calls.at(-1)!.op).toBe('find');
    expect(calls.filter((c) => c.op === 'aggregate').every((c) => c.arg.some((s: any) => s.$group))).toBe(true);
  });

  test.each(cases)('%s: the $lookup form returns the same rows', async (_n, where, expected) => {
    const { db } = fakeDb(DATA());
    const pipeline = compileSelectPipeline(users({ where, orderBy: { id: 'asc' } }), SC.user);
    expect(pipeline.some((s) => s.$lookup)).toBe(true);
    const docs = await db.collection('users').aggregate(pipeline).toArray();
    expect(docs.map((d: any) => d._id)).toEqual(expected);
    expect(docs.every((d: any) => Object.keys(d).every((k) => !k.startsWith('__forge')))).toBe(true);
  });

  test('the $lookup form sorts before joining, so a page stops the joins early', () => {
    const pipeline = compileSelectPipeline(users({ where: { posts: { some: {} } }, orderBy: { id: 'asc' }, take: 2 }), SC.user);
    const at = (k: string) => pipeline.findIndex((s) => k in s);
    expect(at('$sort')).toBeLessThan(at('$lookup'));
    expect(at('$lookup')).toBeLessThan(at('$limit'));
  });

  test('count takes a relation filter too', async () => {
    const { db } = fakeDb(DATA());
    const node = buildCount('user', SC.user, { where: { posts: { none: { status: 'PUBLISHED' } } } }, SC as any);
    expect(await executeCount(node, SC.user, { db })).toBe(2);
  });
});
