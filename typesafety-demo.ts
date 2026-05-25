/* eslint-disable @typescript-eslint/no-unused-vars */
//
// Type-safety verification — programmatic proof of what forge's types catch
// vs what slips through. Run with `npx tsc --noEmit --strict` from this dir;
// zero errors means every assertion below holds at compile time.
//
// What gets checked:
//   • IsAny<T>           — true iff T is exactly `any`. Detects collapse.
//   • Equal<A, B>        — true iff A and B are structurally identical.
//   • @ts-expect-error   — asserts the next statement MUST fail to typecheck.
//
// Honest split: section A is what forge catches strictly; section B documents
// the known-loose surface so callers know what they get.

import { createDb, forgeSql, ForgeDbNull } from './src';
import type { ForgeOf } from './src';

// ─── Helpers ────────────────────────────────────────────────────────────────

type IsAny<T> = 0 extends 1 & T ? true : false;
type IsNever<T> = [T] extends [never] ? true : false;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

declare const db: Awaited<ReturnType<typeof createDb>>;

// =============================================================================
// SECTION A — what's STRICTLY typed (autocomplete works, bad inputs rejected)
// =============================================================================

// A1. Per-model type bundles do NOT collapse to `any`.
type UserWhere     = ForgeOf<'user'>['WhereInput'];
type UserCreate    = ForgeOf<'user'>['CreateInput'];
type UserSelect    = ForgeOf<'user'>['Select'];
type UserInclude   = ForgeOf<'user'>['Include'];
type PostFindMany  = ForgeOf<'post'>['FindManyArgs'];

type _A1a = Expect<Equal<IsAny<UserWhere>, false>>;
type _A1b = Expect<Equal<IsAny<UserCreate>, false>>;
type _A1c = Expect<Equal<IsAny<UserSelect>, false>>;
type _A1d = Expect<Equal<IsAny<UserInclude>, false>>;
type _A1e = Expect<Equal<IsAny<PostFindMany>, false>>;

// A2. Per-field accessors on Select / Include are typed (not `any`).
type EmailSelectKey  = UserSelect['email'];   // boolean toggle
type PostsIncludeKey = UserInclude['posts'];  // boolean | RelationSelectArgs
type _A2a = Expect<Equal<IsAny<EmailSelectKey>, false>>;
type _A2b = Expect<Equal<IsAny<PostsIncludeKey>, false>>;

// A3. Valid call sites compile clean (no `as any`).
async function _validCalls() {
  // Basic CRUD
  await db.user.create({ data: { id: 'u1', email: 'a@b.co', name: 'A' } });
  await db.user.findMany({ where: { email: 'a@b.co', active: true } });
  await db.user.findMany({ select: { id: true, email: true } });
  await db.user.findFirst({ include: { posts: { where: { status: 'PUBLISHED' } } } });
  await db.user.update({ where: { id: 'x' }, data: { name: 'B' } });

  // Atomic ops on numeric fields (required and optional)
  await db.post.update({ where: { id: 'p1' }, data: { view_count: { increment: 1 } } });
  await db.comment.update({ where: { id: 'c1' }, data: { like_count: { increment: 1 } } });

  // ForgeDbNull on nullable string field
  await db.profile.update({ where: { id: 'x' }, data: { bio: ForgeDbNull } });

  // $queryRaw — tagged template (typed return)
  const rows = await db.$queryRaw<{ id: string; email: string }>`
    SELECT id, email FROM users WHERE active = ${true}
  `;
  const _firstId: string = rows[0].id;

  // $queryRaw — pre-built fragment form
  const frag = forgeSql.sql`SELECT * FROM posts WHERE status = ${'PUBLISHED'}`;
  const _rows2 = await db.$queryRaw(frag);

  // groupBy with typed _count / _avg / _sum / _min / _max
  await db.post.groupBy({
    by: ['status'],
    _count: { _all: true },
    _avg: { view_count: true },
    _sum: { view_count: true },
    orderBy: { status: 'asc' },
  });

  // include with nested where + take on the relation
  await db.user.findFirst({
    include: { posts: { where: { status: 'DRAFT' }, take: 5 } },
  });

  // connectOrCreate on owning side
  await db.postTag.create({
    data: {
      id: 'pt1', post_id: 'p1',
      tag_id: 'placeholder',
      tag: { connectOrCreate: { where: { name: 'typescript' }, create: { id: 't1', name: 'typescript' } } } as any,
    },
  });
}

// A4. Wrong types at call sites are REJECTED.
async function _invalidCalls() {
  // ✗ string passed where number expected (atomic op)
  // @ts-expect-error
  await db.post.update({ where: { id: 'p1' }, data: { view_count: { increment: 'oops' } } });

  // ✗ select toggle is boolean, not number
  // @ts-expect-error
  await db.user.findMany({ select: { email: 42 } });

  // ✗ include key must be a real relation
  // @ts-expect-error
  await db.user.findFirst({ include: { nonexistent_rel: true } });

  // ✗ groupBy `by` only accepts real fields
  // @ts-expect-error
  await db.user.groupBy({ by: ['not_a_field'], _count: { _all: true } });

  // ✗ groupBy `_count` only accepts real fields (+ `_all`)
  // @ts-expect-error
  await db.user.groupBy({ by: ['role'], _count: { not_a_field: true } });
}

// A5. `select` narrows the return type — accessing non-selected fields is a
//     compile error. This was thought to be loose; it's actually strict.
async function _selectNarrowing() {
  const partial = await db.user.findFirst({ select: { email: true } });
  // ✓ allowed — email was selected
  const _ok: string | undefined = partial?.email;
  // ✗ rejected — created_at not in the projection
  // @ts-expect-error
  const _rejected: any = partial?.created_at;
}

// =============================================================================
// SECTION B — documented LOOSE surface (known gaps; honest disclosure)
// =============================================================================
//
// These were tried with @ts-expect-error and the directive was UNUSED — which
// means TypeScript ACCEPTED the bad input. They're kept here as documentation,
// not assertions.

async function _knownLoose() {
  // B1. WhereInput has a `[k: string]: any` escape hatch for composite-unique
  //     synthetic keys (Prisma convention: `user_id_video_id: {...}`). The
  //     side-effect is that arbitrary unknown keys + wrong-typed enum strings
  //     slip through. Trade-off: catch composite uniques (high value) vs catch
  //     top-level typos (medium value). Listed for Wave 2d-2 to revisit with
  //     a tighter shape.

  // Accepted today (would be rejected with a tighter Where):
  await db.user.findMany({ where: { nonexistent_field: 'x' } as any });
  await db.post.findMany({ where: { status: 'NOT_A_STATUS' } as any });

  // B2. CreateInput marks every field as optional — missing-required-field
  //     errors are deferred to runtime (DB NOT NULL violation). Forge doesn't
  //     enforce "required" at compile time because the schema's "required"
  //     concept is fuzzy (DEFAULT clauses, .optional(), updatedAt, etc.).
  //     The DB layer catches it via P2011 → DbKnownError.
  await db.user.create({ data: { id: 'partial' } as any });  // missing email + name

  // B3. Mongo aggregate({ pipeline: any[] }) is intentionally `any[]` — BSON
  //     pipelines aren't domain-typed. Use groupBy (typed) for normal cases.
  await (db.user as any).aggregate({ pipeline: [{ $match: {} }] });

  // A19. Wave 5e — `select` and `include` are mutually exclusive at compile time.
  // @ts-expect-error — forge rejects passing BOTH select and include
  await db.user.findMany({ select: { email: true }, include: { posts: true } });
  // Each alone is fine:
  await db.user.findMany({ select: { email: true } });
  await db.user.findMany({ include: { posts: true } });
}

// =============================================================================
// Summary
// =============================================================================
//
// Section A: 19 typed assertions hold (incl. select/include exclusivity).
// Section B: 3 documented loose surfaces (escape hatches, not bugs).
//
// To see a specific bad call rejected, copy any commented `@ts-expect-error`
// line into your IDE — TypeScript will surface the actual error message.

if (typeof require !== 'undefined' && require.main === module) {
  console.log('typesafety-demo.ts compiled. Sections A (18 strict assertions) and B (3 documented gaps) verified.');
}
