// Compile-only probe for the nullable-column filter fix (v2.7.0). Must pass
// `tsc --noEmit` with zero errors, including the @ts-expect-error negatives.
import type { WhereInput, ModelFields } from './src/schema/core';
import { Post, User } from './src/schema';

type PostWhere = WhereInput<ModelFields<typeof Post>>;
type UserWhere = WhereInput<ModelFields<typeof User>>;

// published_at is dateTime().optional() — comparison ops must type-check.
const a: PostWhere = { published_at: { lte: new Date(), gte: '2026-01-01' } };
// …and null must stay allowed where it means something.
const b: PostWhere = { published_at: { not: null } };
const c: PostWhere = { published_at: { equals: null } };
// tag_names stringArray().optional() — list ops.
const d: PostWhere = { tag_names: { has: 'x', isEmpty: false } };
// Required string columns unchanged; optional embeds don't regress.
const e: UserWhere = { name: { contains: 'x', mode: 'insensitive' } };
const f2: PostWhere = { view_count: { gte: 1, lt: 100 } };
// Nested not-filter is part of the typed surface.
const g: PostWhere = { title: { not: { contains: 'x' } } };

// Wrong shapes must still be rejected.
// @ts-expect-error — contains is not valid on an int column
const h: PostWhere = { view_count: { contains: 'x' } };
// @ts-expect-error — lte takes the scalar, not null
const i: PostWhere = { published_at: { lte: null } };

void [a, b, c, d, e, f2, g, h, i];
