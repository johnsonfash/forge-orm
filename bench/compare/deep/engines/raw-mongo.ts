// The Mongo baseline: the native driver, written the way an experienced Mongo
// developer would. Relations load in ONE aggregation with $lookup pipelines;
// relation filters use distinct() + $in. forge stores `id` as `_id`, JSON as
// sub-documents and geo points as GeoJSON, so this reads the same documents.

import type { EngineImpl } from "../core";
import type { DialectCtx } from "../dialects";
import { params, postData, userData, wid } from "../scenarios";
import * as S from "../schema";

const asId = (d: any) => (d ? { ...d, id: d._id } : d);

export async function rawMongoEngine(ctx: DialectCtx): Promise<EngineImpl> {
  const db = ctx.mongo!.db, client = ctx.mongo!.client;
  const users = db.collection("users"), posts = db.collection("posts"), comments = db.collection("comments");
  const tags = db.collection("tags"), postTags = db.collection("post_tags"), places = db.collection("places"), profiles = db.collection("profiles");
  const P = params(ctx.sizes);
  const T = "raw";
  const doc = (o: any) => { const { id, ...rest } = o; return { _id: id, ...rest }; };

  const ops: EngineImpl["ops"] = {
    pk: async (i) => asId(await users.findOne({ _id: P.pkUser(i) })),
    unique_email: async (i) => asId(await users.findOne({ email: P.emailUser(i) })),
    filter_offset: () => users.find({ role: P.filterRole, active: true, created_at: { $gte: P.filterFrom, $lt: P.filterTo } })
      .sort({ created_at: -1, _id: 1 }).skip(P.filterSkip).limit(20).toArray(),
    cursor: (i) => posts.find({ _id: { $gt: P.cursorAfter(i) } }).sort({ _id: 1 }).limit(20).toArray(),
    count_filter: () => posts.countDocuments({ status: "PUBLISHED", views: { $gte: P.countMinViews } }),
    exists: async (i) => (await users.findOne({ email: P.existsEmail(i) }, { projection: { _id: 1 } })) !== null,
    select_cols: (i) => posts.find({ author_id: P.selectAuthor(i) }, { projection: { title: 1, views: 1 } }).sort({ _id: 1 }).toArray(),
    in_100: async () => (await users.find({ _id: { $in: P.in100 } }, { projection: { email: 1 } }).toArray()).map(asId),
    or_not_like: () => users.find({
      $or: [{ name: { $regex: P.likeName, $options: "i" } }, { email: { $regex: `^${P.likePrefix.replace(".", "\\.")}` } }],
      role: { $ne: "ADMIN" },
    }).sort({ _id: 1 }).limit(50).toArray(),
    rel_some: async () => users.find({ _id: { $in: await posts.distinct("author_id", { status: "PUBLISHED" }) } }, { projection: { _id: 1 } }).sort({ _id: 1 }).limit(50).toArray(),
    rel_none: async () => users.find({ _id: { $nin: await posts.distinct("author_id", { status: "PUBLISHED" }) } }, { projection: { _id: 1 } }).sort({ _id: 1 }).limit(50).toArray(),
    rel_every: async () => users.find({ _id: { $nin: await posts.distinct("author_id", { status: { $ne: "PUBLISHED" } }) } }, { projection: { _id: 1 } }).sort({ _id: 1 }).limit(50).toArray(),

    include_1: async (_i, n) => (await posts.aggregate([
      { $match: { status: "PUBLISHED" } }, { $sort: { _id: 1 } }, { $limit: n },
      { $lookup: { from: "users", localField: "author_id", foreignField: "_id", as: "author" } },
      { $unwind: { path: "$author", preserveNullAndEmptyArrays: true } },
    ]).toArray()).map((p: any) => ({ ...asId(p), author: asId(p.author) })),
    include_2: async (_i, n) => (await users.aggregate([
      { $sort: { _id: 1 } }, { $limit: n },
      { $lookup: { from: "posts", localField: "_id", foreignField: "author_id", as: "posts", pipeline: [
        { $sort: { _id: 1 } },
        { $lookup: { from: "comments", localField: "_id", foreignField: "post_id", as: "comments", pipeline: [{ $sort: { _id: 1 } }] } },
      ] } },
    ]).toArray()).map((u: any) => ({ ...asId(u), posts: u.posts.map((p: any) => ({ ...asId(p), comments: p.comments.map(asId) })) })),
    include_3: async (_i, n) => (await users.aggregate([
      { $match: { active: true } }, { $sort: { _id: 1 } }, { $limit: n },
      { $lookup: { from: "posts", localField: "_id", foreignField: "author_id", as: "posts", pipeline: [
        { $match: { status: "PUBLISHED" } }, { $sort: { published_at: -1, _id: 1 } }, { $limit: 5 },
        { $lookup: { from: "comments", localField: "_id", foreignField: "post_id", as: "comments", pipeline: [
          { $sort: { _id: 1 } }, { $limit: 3 },
          { $lookup: { from: "users", localField: "author_id", foreignField: "_id", as: "author", pipeline: [{ $project: { email: 1 } }] } },
          { $unwind: { path: "$author", preserveNullAndEmptyArrays: true } },
        ] } },
      ] } },
    ]).toArray()).map((u: any) => ({ ...asId(u), posts: u.posts.map((p: any) => ({ ...asId(p), comments: p.comments.map((c: any) => ({ ...asId(c), author: asId(c.author) ?? null })) })) })),
    m2m_post_tags: async (_i, n) => (await posts.aggregate([
      { $sort: { _id: 1 } }, { $limit: n },
      { $lookup: { from: "post_tags", localField: "_id", foreignField: "post_id", as: "post_tags", pipeline: [
        { $lookup: { from: "tags", localField: "tag_id", foreignField: "_id", as: "tag" } }, { $unwind: "$tag" },
      ] } },
    ]).toArray()).map(asId),
    m2m_tag_counts: async () => (await tags.aggregate([
      { $sort: { name: 1 } },
      { $lookup: { from: "post_tags", localField: "_id", foreignField: "tag_id", as: "c", pipeline: [{ $count: "n" }] } },
      { $project: { name: 1, _count: { post_tags: { $ifNull: [{ $first: "$c.n" }, 0] } } } },
    ]).toArray()),
    count_rel: async (_i, n) => (await users.aggregate([
      { $sort: { _id: 1 } }, { $limit: n },
      { $lookup: { from: "posts", localField: "_id", foreignField: "author_id", as: "p", pipeline: [{ $count: "n" }] } },
      { $lookup: { from: "comments", localField: "_id", foreignField: "author_id", as: "c", pipeline: [{ $count: "n" }] } },
      { $project: { _count: { posts: { $ifNull: [{ $first: "$p.n" }, 0] }, comments: { $ifNull: [{ $first: "$c.n" }, 0] } } } },
    ]).toArray()).map(asId),
    aggregate: async () => {
      const [r] = await posts.aggregate([{ $match: { status: "PUBLISHED" } },
        { $group: { _id: null, n: { $sum: 1 }, s: { $sum: "$views" }, a: { $avg: "$views" }, mn: { $min: "$views" }, mx: { $max: "$views" } } }]).toArray();
      return { _count: { _all: r?.n ?? 0 }, _sum: { views: r?.s }, _avg: { views: r?.a }, _min: { views: r?.mn }, _max: { views: r?.mx } };
    },
    groupby: async () => (await posts.aggregate([
      { $match: { status: { $ne: "DRAFT" } } },
      { $group: { _id: "$author_id", n: { $sum: 1 }, s: { $sum: "$views" } } },
      { $match: { n: { $gte: P.groupMinCount } } }, { $sort: { s: -1, _id: 1 } }, { $limit: 20 },
    ]).toArray()).map((r: any) => ({ author_id: r._id, _count: { _all: r.n }, _sum: { views: r.s } })),
    distinct: async () => (await posts.distinct("author_id", { views: { $lt: P.distinctMaxViews } })).sort(),
    json_prefs: () => users.find({ "prefs.theme": P.jsonTheme, "prefs.score": { $gte: P.jsonMinScore } }, { projection: { _id: 1 } }).sort({ _id: 1 }).limit(100).toArray(),
    json_meta: () => posts.countDocuments({ "meta.lang": P.metaLang, "meta.score": { $gte: P.metaMinScore } }),
    fts: () => posts.find({ $text: { $search: P.ftsTerm } }, { projection: { _id: 1 } }).sort({ _id: 1 }).limit(50).toArray(),
    geo_near: () => places.aggregate([
      { $geoNear: { near: { type: "Point", coordinates: [S.GEO_CENTER.lng, S.GEO_CENTER.lat] }, distanceField: "d", maxDistance: P.geoRadius, spherical: true } },
      { $limit: 20 },
    ]).toArray(),
    large_findmany: (_i, n) => posts.find({}).sort({ _id: 1 }).limit(n).toArray().then((r: any[]) => r.map(asId)),
    stream: async (_i, n) => {
      let count = 0, views = 0, first: string | undefined, last: string | undefined;
      for await (const r of posts.find({}).sort({ _id: 1 }).limit(n)) { count++; views += Number(r.views); first ??= r._id; last = r._id; }
      return { count, first, last, views };
    },

    create: async (i) => { const u = userData(wid(T, "create", i)); await users.insertOne(doc(u)); return u; },
    create_many: async (i) => ({ count: (await users.insertMany(Array.from({ length: 1000 }, (_, k) => doc({ ...userData(`${wid(T, "cm", i)}_${k}`, wid(T, "cm", i)), role: "USER" })))).insertedCount }),
    nested_create: async (i) => {
      const U = wid(T, "nc", i);
      await users.insertOne(doc(userData(U)));
      await profiles.insertOne({ _id: `${U}_pr`, user_id: U, bio: "nested bio" });
      await posts.insertMany([0, 1, 2].map((k) => doc(postData(`${U}_p${k}`, U, k))));
      const names = [...P.connectTags, wid(T, "nctag", i)];
      await tags.bulkWrite(names.map((name, j) => ({ updateOne: { filter: { name }, update: { $setOnInsert: { _id: `t_${U}_${j}`, name } }, upsert: true } })));
      const found = await tags.find({ name: { $in: names } }).toArray();
      const byName = new Map(found.map((t: any) => [t.name, t._id]));
      await postTags.insertMany(names.map((name, j) => ({ _id: `${U}_p0_pt${j}`, post_id: `${U}_p0`, tag_id: byName.get(name) })));
      return { id: U };
    },
    update_by_id: async (i) => asId(await users.findOneAndUpdate({ _id: P.updUser(i) }, { $set: { name: `Renamed ${i}` } }, { returnDocument: "after" })),
    update_many: async (i) => ({ count: (await posts.updateMany({ author_id: P.updManyAuthor(i) }, { $set: { views: 42 } })).matchedCount }),
    increment_concurrent: (i) => Promise.all(Array.from({ length: 20 }, () => posts.updateOne({ _id: wid(T, "inc", i) }, { $inc: { views: 1 } }))),
    upsert_insert: (i) => {
      const { id, name, ...rest } = userData(wid(T, "ups", i));
      return users.updateOne({ email: rest.email }, { $set: { name: "Upserted" }, $setOnInsert: { _id: id, ...rest } }, { upsert: true });
    },
    upsert_update: (i) => {
      const { id, name, email, ...rest } = userData(wid(T, "upu", i));
      return users.updateOne({ email: P.upsertUpdateEmail }, { $set: { name: "Upserted 5" }, $setOnInsert: { _id: id, ...rest } }, { upsert: true });
    },
    delete_cascade: async (i) => {
      const id = wid(T, "dc", i);
      const pids = await posts.distinct("_id", { author_id: id });
      if (pids.length) {
        await postTags.deleteMany({ post_id: { $in: pids } });
        await comments.deleteMany({ post_id: { $in: pids } });
        await posts.deleteMany({ _id: { $in: pids } });
      }
      await comments.updateMany({ author_id: id }, { $set: { author_id: null } });
      await profiles.deleteMany({ user_id: id });
      return users.deleteOne({ _id: id });
    },
    delete_many: async (i) => ({ count: (await users.deleteMany({ name: wid(T, "dm", i) })).deletedCount }),
    tx_interactive: async (i) => {
      const s = client.startSession();
      try {
        return await s.withTransaction(async () => {
          const U = wid(T, "tx", i);
          await users.insertOne(doc(userData(U)), { session: s });
          await posts.insertOne(doc(postData(`${U}_p`, U, 0)), { session: s });
          const n = await posts.countDocuments({ author_id: U }, { session: s });
          await users.updateOne({ _id: U }, { $set: { name: `has ${n} posts` } }, { session: s });
          await comments.insertOne({ _id: `${U}_c`, post_id: `${U}_p`, author_id: U, parent_id: null, body: "tx", created_at: new Date(S.BASE_TIME) }, { session: s });
          return n;
        });
      } finally { await s.endSession(); }
    },
    tx_rollback: async (i) => {
      const s = client.startSession();
      try {
        s.startTransaction();
        await users.insertOne(doc(userData(wid(T, "rb", i))), { session: s });
        await s.abortTransaction();
      } finally { await s.endSession(); }
      return null;
    },
    optimistic_update: async (i) => {
      const id = wid(T, "occ", i);
      const { version } = (await posts.findOne({ _id: id }, { projection: { version: 1 } })) as any;
      const fresh = await posts.updateOne({ _id: id, version }, { $set: { version: version + 1, title: "occ" } });
      const stale = await posts.updateOne({ _id: id, version }, { $set: { version: version + 1, title: "stale" } });
      return { fresh: fresh.matchedCount, stale: stale.matchedCount };
    },
  };
  // Documents come back keyed by `_id`; expose `id` too, as every other engine does.
  const fix = (v: any) => Array.isArray(v) ? v.map((x) => x && typeof x === "object" && "_id" in x && !("id" in x) ? asId(x) : x) : v;
  for (const k of Object.keys(ops)) { const f = ops[k]!; ops[k] = async (i, n) => fix(await f(i, n)); }
  const na: Record<string, string> = {};
  if (!ctx.features.tx) { na.tx_interactive = na.tx_rollback = "transactions need a replica set"; delete ops.tx_interactive; delete ops.tx_rollback; }
  return { ops, na, close: async () => {} };
}
