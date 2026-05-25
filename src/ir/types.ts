// Query IR — adapter-agnostic intermediate representation.
//
// Every wrapper method (findMany, create, update, ...) converts user args into
// one of these nodes. Adapters then either:
//   • Execute it (adapters/<kind>/execute.ts)        — Wave 1b
//   • Compile it (adapters/<kind>/compile-from-ir.ts) — Wave 1a (this file)
//   • Emit DDL from it (Wave 2)
//
// The IR is pure data. No driver types leak in. SQL compilers and Mongo
// compilers consume the exact same tree.

// ─── Top-level nodes ────────────────────────────────────────────────────────

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
  pipeline?: any[];               // Mongo passthrough — Wave 4 adds typed sugar
}

// GroupByNode — typed aggregations across rows, grouped by a set of fields.
// Compiles to SQL `GROUP BY` + aggregate functions on PG/MySQL/SQLite, and
// to a `$group` stage on Mongo.
export interface GroupByNode {
  kind: 'groupBy';
  model: string;
  by: string[];                            // schema field names to group by
  where?: WhereTree;                       // pre-aggregation filter
  // Aggregations — each is a map of `field name → true`. `_count._all` is a
  // synthetic key meaning COUNT(*) (no specific column).
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

// ─── Where tree ─────────────────────────────────────────────────────────────

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
  | 'jsonPath'                    // reserved for Wave 4 (Postgres jsonb)
  | 'search';                     // reserved for Wave 4 (full-text)

// ─── Projection + relations ─────────────────────────────────────────────────

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

// ─── Order, cursor ──────────────────────────────────────────────────────────

export interface OrderByEntry {
  // Either a scalar field on the model, or a relation-scoped order
  // (Wave 1: scalar only; Wave 2 SQL adds relation-ordered).
  field: string;
  direction: 'asc' | 'desc';
  // SQL-only; ignored by Mongo. 'first' = NULLS FIRST.
  nulls?: 'first' | 'last';
}

export interface CursorSpec {
  // Single-field: { id: 'x' } or composite: { user_id_video_id: { user_id, video_id } }.
  // The IR carries them flat: a map of schema field name → value.
  fields: Record<string, any>;
}
