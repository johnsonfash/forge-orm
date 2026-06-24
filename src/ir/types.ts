// Query IR — adapter-agnostic intermediate representation.
//
// Every wrapper method converts user args into one of these nodes; adapters
// then execute, compile, or emit DDL from them. The IR is pure data — no driver
// types leak in, so SQL and Mongo compilers consume the exact same tree.

export type IRNode =
  | SelectNode
  | InsertNode
  | UpdateNode
  | DeleteNode
  | CountNode
  | AggregateNode
  | GroupByNode;

export interface SelectNode {
  kind: 'select';
  model: string;                  // schema key (e.g. 'user'), not collection name
  where?: WhereTree;
  projection?: ProjectionPlan;    // null/undefined = all scalars
  hydration?: RelationPlan[];     // nested include / relation-select
  orderBy?: OrderByEntry[];
  limit?: number;
  offset?: number;
  cursor?: CursorSpec;
  distinct?: string[];
  // Cardinality intent: 'one' for findFirst/findUnique, 'many' for findMany.
  // Drivers may optimise differently (e.g. Mongo `findOne` vs `find().limit(1)`).
  cardinality: 'one' | 'many';
}

export interface InsertNode {
  kind: 'insert';
  model: string;
  // Documents are pre-coerced by the wrapper (id→ObjectId, dates, defaults).
  // Adapters insert verbatim.
  rows: Record<string, any>[];
  skipDuplicates?: boolean;
  returning?: ProjectionPlan;
  hydration?: RelationPlan[];
}

export interface UpdateNode {
  kind: 'update';
  model: string;
  where: WhereTree;
  set?: Record<string, any>;
  increment?: Record<string, number>;
  multiply?: Record<string, number>;
  push?: Record<string, any>;
  unset?: string[];
  many: boolean;                  // updateMany when true, updateOne when false
  // Present when this is an upsert. Adapters do the right thing per dialect
  // (Mongo: $setOnInsert + upsert:true; PG: ON CONFLICT DO UPDATE; etc.).
  upsertCreate?: Record<string, any>;
  returning?: ProjectionPlan;
  hydration?: RelationPlan[];
  /**
   * Schema-level intent for the update. Set by the wrapper / compile API
   * when the caller invoked softDelete / restore so replay / audit tools
   * can distinguish a soft-delete from a regular update by inspecting the
   * IR alone, without parsing the `set` payload to look for the soft-delete
   * column. Optional; absent for plain update / upsert calls.
   */
  semantic?: 'softDelete' | 'softDeleteMany' | 'restore' | 'restoreMany';
}

export interface DeleteNode {
  kind: 'delete';
  model: string;
  where: WhereTree;
  many: boolean;
  returning?: ProjectionPlan;
}

export interface CountNode {
  kind: 'count';
  model: string;
  where?: WhereTree;
  distinct?: string[];
}

export interface AggregateNode {
  kind: 'aggregate';
  model: string;
  pipeline?: any[];               // Mongo passthrough
}

export interface GroupByNode {
  kind: 'groupBy';
  model: string;
  by: string[];                            // schema field names to group by
  where?: WhereTree;                       // pre-aggregation filter
  // `_count._all` is a synthetic key meaning COUNT(*) (no specific column).
  _count?: { _all?: boolean } & Record<string, boolean | undefined>;
  _avg?: Record<string, boolean>;
  _sum?: Record<string, boolean>;
  _min?: Record<string, boolean>;
  _max?: Record<string, boolean>;
  // Post-aggregation filter — Prisma `having` takes the aggregation result
  // shape (e.g. `{ _count: { id: { gt: 5 } } }`). Passed through; compiler
  // interprets.
  having?: Record<string, any>;
  orderBy?: OrderByEntry[];                // applied after grouping
  limit?: number;
  offset?: number;
}

export type WhereTree =
  | WhereLeaf
  | WhereAnd
  | WhereOr
  | WhereNot
  | WhereRelation;

export interface WhereLeaf {
  kind: 'leaf';
  field: string;                  // schema-side field name (not column name)
  op: WhereOp;
  value: any;                     // already coerced by the IR builder
  // For string ops; ignored elsewhere.
  caseInsensitive?: boolean;
  // Field-to-field comparison: when set, the leaf compares `field <op> rhsField`
  // (both schema-side field names) instead of `field <op> value`, and `value`
  // is ignored. Produced by `col('rhsField')`. Only the comparison ops
  // (eq/ne/lt/lte/gt/gte) are valid here — enforced at IR-build time.
  rhsField?: string;
  // For `jsonPath`: the dotted/indexed path inside the JSON column, plus the
  // SCALAR sub-op (`eq`, `gte`, etc.) to apply at that path. The IR shape is
  // separated from the outer `op` because the dialect compilers need both
  // the path AND the comparison together to emit native JSON operators.
  jsonPath?: { path: string[]; subOp: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'contains' | 'in' | 'has' };
}

export interface WhereAnd { kind: 'and'; children: WhereTree[] }
export interface WhereOr  { kind: 'or';  children: WhereTree[] }
export interface WhereNot { kind: 'not'; child: WhereTree }

// Relation filter. `nested` recurses with the target model's where tree.
export interface WhereRelation {
  kind: 'relation';
  relation: string;               // relation name on the parent model
  mode: 'is' | 'isNot' | 'some' | 'every' | 'none';
  nested: WhereTree | null;       // null === "any row exists" / "no row exists"
}

export type WhereOp =
  | 'eq' | 'ne'
  | 'in' | 'nin'
  | 'lt' | 'lte' | 'gt' | 'gte'
  | 'contains' | 'startsWith' | 'endsWith'
  | 'has' | 'hasSome' | 'hasEvery' | 'isEmpty'
  | 'jsonPath'                    // reserved (Postgres jsonb)
  | 'search'                      // reserved (full-text)
  // Geo — distance-based filter on a geoPoint field. `value` carries
  // { lng, lat, withinMeters } (also called the "search circle"). Per
  // dialect:
  //   PG     → ST_DWithin(loc, ST_GeogFromText('SRID=4326;POINT(lng lat)'), N)
  //   MySQL  → ST_Distance_Sphere(loc, ST_GeomFromText('POINT(lat lng)', 4326)) < N
  //   SQLite → Distance(loc, MakePoint(lng, lat, 4326), 1) < N  (SpatiaLite)
  //   DuckDB → ST_Distance(loc, ST_Point(lng, lat)) < N         (spatial ext)
  //   MSSQL  → loc.STDistance(geography::STGeomFromText('POINT(lng lat)', 4326)) < N
  //   Mongo  → { $near: { $geometry: …Point…, $maxDistance: N } }
  | 'near'
  // Geo polygon containment.
  //
  // Accepted user-facing input shapes:
  //   • Single ring (legacy):     [{lng,lat}, {lng,lat}, …]
  //   • Polygon with holes:       { type: 'Polygon', rings: [outer, hole1, hole2, …] }
  //   • MultiPolygon:             { type: 'MultiPolygon', polygons: [[outer, …holes], …] }
  //   • GeometryCollection:       { type: 'GeometryCollection', geometries: [Polygon | MultiPolygon, …] }
  //
  // The IR builder normalises ALL of those to a single internal shape on the
  // leaf: `value = { multiPolygon: Array<Array<Array<{lng,lat}>>> }` — an
  // array of polygons, each polygon an array of rings, each ring an array
  // of {lng,lat} points (auto-closed). A single ring becomes a single
  // polygon with a single ring; a GeometryCollection is flattened to its
  // constituent polygons. This way every dialect compiler / fallback path
  // sees the same shape.
  //
  // Per dialect (one MULTIPOLYGON per call, even when the source was a single
  // ring — most SQL geo libs accept MULTIPOLYGON over a single-polygon input):
  //   PG     → ST_Within(loc, ST_GeogFromText('SRID=4326;MULTIPOLYGON(((…)))'))
  //   MySQL  → ST_Within(loc, ST_GeomFromText('MULTIPOLYGON(((lat lng,…)))', 4326))
  //   SQLite → Within(loc, GeomFromText('MULTIPOLYGON(((…)))', 4326))   (SpatiaLite)
  //   DuckDB → ST_Within(loc, ST_GeomFromText('MULTIPOLYGON(((…)))'))
  //   MSSQL  → geography::STGeomFromText('MULTIPOLYGON(((…)))').STContains(loc) = 1
  //   Mongo  → { $geoWithin: { $geometry: { type:'MultiPolygon', coordinates:… } } }
  | 'withinPolygon';

export interface ProjectionPlan {
  // Scalar field names (schema-side). Empty array + exclusive=true means
  // "return only relations / counts, no scalars."
  fields: string[];
  // Inverted-set view: when omit is used, this is the list of fields to drop.
  // Adapters pick whichever is more efficient.
  omit?: string[];
  // Relation names to count without fetching rows (`_count: { posts: true }`).
  counts: string[];
  // True if caller used `select` (only listed fields). False if caller used
  // `include` (all scalars + listed relations) or neither (all scalars).
  exclusive: boolean;
}

export interface RelationPlan {
  name: string;                   // relation key on parent (e.g. 'profile')
  kind: 'one' | 'many';
  target: string;                 // schema key of target model
  on: string;                     // FK field on the holding side
  refs: string;                   // referenced field on the other side
  // Nested args carried down: select/include/where/orderBy/limit/offset.
  nested?: Omit<SelectNode, 'kind' | 'model' | 'cardinality'> & {
    cardinality?: 'one' | 'many';
  };
}

export interface OrderByEntry {
  field: string;
  direction: 'asc' | 'desc';
  // SQL-only; ignored by Mongo. 'first' = NULLS FIRST.
  nulls?: 'first' | 'last';
  // Geo or vector — when `field` is a geoPoint, rows are ordered by distance
  // to {lng, lat} with a synthetic `_distanceMeters` column. When `field` is
  // a vector, rows are ordered by vector distance to {vector} with a
  // synthetic `_distance` column. On Mongo, geo uses $geoNear (first stage),
  // vector uses $vectorSearch (first stage); the executor routes either.
  nearTo?: { lng: number; lat: number } | { vector: number[] };
}

export interface CursorSpec {
  // Single-field: { id: 'x' } or composite: { user_id_video_id: { user_id, video_id } }.
  // The IR carries them flat: a map of schema field name → value.
  fields: Record<string, any>;
}
