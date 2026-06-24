// Coverage for the Mongo-shaped → SQL WHERE translator that drives partial
// indexes from a single cross-dialect filter object.

import { mongoToSqlWhere } from '../adapters/shared/mongo-to-sql-where';

describe('mongoToSqlWhere — operator coverage', () => {
  it('scalar shorthand → equality', () => {
    expect(mongoToSqlWhere({ status: 'active' })).toBe(`"status" = 'active'`);
    expect(mongoToSqlWhere({ count: 5 })).toBe(`"count" = 5`);
    expect(mongoToSqlWhere({ live: true })).toBe(`"live" = TRUE`);
  });

  it('null shorthand → IS NULL', () => {
    expect(mongoToSqlWhere({ deleted_at: null })).toBe(`"deleted_at" IS NULL`);
  });

  it('comparators', () => {
    expect(mongoToSqlWhere({ price: { $gt: 100 } })).toBe(`"price" > 100`);
    expect(mongoToSqlWhere({ price: { $gte: 100 } })).toBe(`"price" >= 100`);
    expect(mongoToSqlWhere({ price: { $lt: 100 } })).toBe(`"price" < 100`);
    expect(mongoToSqlWhere({ price: { $lte: 100 } })).toBe(`"price" <= 100`);
    expect(mongoToSqlWhere({ status: { $ne: 'archived' } })).toBe(`"status" <> 'archived'`);
  });

  it('$eq and $ne with null translate to IS / IS NOT NULL', () => {
    expect(mongoToSqlWhere({ x: { $eq: null } })).toBe(`"x" IS NULL`);
    expect(mongoToSqlWhere({ x: { $ne: null } })).toBe(`"x" IS NOT NULL`);
  });

  it('$in / $nin', () => {
    expect(mongoToSqlWhere({ status: { $in: ['active', 'pending'] } })).toBe(
      `"status" IN ('active', 'pending')`,
    );
    expect(mongoToSqlWhere({ status: { $nin: ['banned'] } })).toBe(`"status" NOT IN ('banned')`);
  });

  it('$exists', () => {
    expect(mongoToSqlWhere({ deleted_at: { $exists: false } })).toBe(`"deleted_at" IS NULL`);
    expect(mongoToSqlWhere({ providerRef: { $exists: true } })).toBe(`"providerRef" IS NOT NULL`);
  });

  it('$type string → IS NOT NULL (best-effort partial-filter shorthand)', () => {
    expect(mongoToSqlWhere({ txn: { $type: 'string' } })).toBe(`"txn" IS NOT NULL`);
  });

  it('implicit AND on multiple keys', () => {
    expect(mongoToSqlWhere({ status: 'active', archived: false })).toBe(
      `"status" = 'active' AND "archived" = FALSE`,
    );
  });

  it('$and / $or compose', () => {
    expect(
      mongoToSqlWhere({
        $or: [{ status: 'active' }, { isPriority: true }],
      }),
    ).toBe(`("status" = 'active') OR ("isPriority" = TRUE)`);
  });

  it('returns null for unsupported operators (not throws)', () => {
    // $where (server-side JS filter) and $elemMatch are not translated.
    expect(mongoToSqlWhere({ name: { $elemMatch: { sub: 1 } } as any })).toBeNull();
    expect(mongoToSqlWhere({ name: { $near: [0, 0] } as any })).toBeNull();
  });

  it('$regex translates per dialect', () => {
    expect(mongoToSqlWhere({ name: { $regex: '^foo' } })).toBe(`"name" ~ '^foo'`);
    expect(mongoToSqlWhere({ name: { $regex: '^foo' } }, { dialect: 'mysql', quoteIdent: (c) => `\`${c}\`` })).toBe('`name` REGEXP \'^foo\'');
    expect(mongoToSqlWhere({ name: { $regex: '^foo' } }, { dialect: 'sqlite' })).toBeNull();
  });

  it('$size translates on Postgres (array_length)', () => {
    expect(mongoToSqlWhere({ tags: { $size: 3 } })).toBe(`coalesce(array_length("tags", 1), 0) = 3`);
    expect(mongoToSqlWhere({ tags: { $size: 3 } }, { dialect: 'mysql' })).toBeNull();
  });

  it('$not negates the nested expression', () => {
    expect(mongoToSqlWhere({ status: { $not: { $eq: 'archived' } } })).toBe(`NOT ("status" = 'archived')`);
  });

  it('$nor wraps the children in NOT (… OR …)', () => {
    expect(
      mongoToSqlWhere({ $nor: [{ status: 'archived' }, { deleted: true }] }),
    ).toBe(`NOT (("status" = 'archived') OR ("deleted" = TRUE))`);
  });

  it('string literals are SQL-escaped', () => {
    expect(mongoToSqlWhere({ name: "O'Brien" })).toBe(`"name" = 'O''Brien'`);
  });

  it('Date instance literal serialises to ISO', () => {
    const d = new Date('2026-06-24T00:00:00.000Z');
    expect(mongoToSqlWhere({ at: d })).toBe(`"at" = '2026-06-24T00:00:00.000Z'`);
  });

  it('custom quoteIdent supports MySQL backticks', () => {
    expect(
      mongoToSqlWhere({ status: 'active' }, { quoteIdent: (c) => `\`${c}\`` }),
    ).toBe('`status` = \'active\'');
  });
});

describe('mongoToSqlWhere — common partial-filter shapes', () => {
  it("soft-delete: { deletedAt: { $exists: false } } → IS NULL", () => {
    expect(mongoToSqlWhere({ deletedAt: { $exists: false } })).toBe(`"deletedAt" IS NULL`);
  });

  it("provider-ref-present: { providerRef: { $type: 'string' } } → IS NOT NULL", () => {
    expect(mongoToSqlWhere({ providerRef: { $type: 'string' } })).toBe(`"providerRef" IS NOT NULL`);
  });

  it('state-flagged: { isVerified: true } → equality on boolean', () => {
    expect(mongoToSqlWhere({ isVerified: true })).toBe(`"isVerified" = TRUE`);
  });

  it('combined: { isPrimary: true, archivedAt: { $exists: false } }', () => {
    expect(
      mongoToSqlWhere({ isPrimary: true, archivedAt: { $exists: false } }),
    ).toBe(`"isPrimary" = TRUE AND "archivedAt" IS NULL`);
  });
});
