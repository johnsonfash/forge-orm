import { f, model, rel } from '../schema/core';
import type { ModelDef } from '../schema/types';
import {
  buildCount,
  buildDelete,
  buildInsert,
  buildSelect,
  buildUpdate,
} from '../ir/build';
import {
  compileCount,
  compileDelete,
  compileInsert,
  compileSelect,
  compileUpdate,
} from '../adapters/postgres/compile-from-ir';

// Postgres SQL compiler tests — drive the IR through the PG compiler and
// assert exact parameterised SQL + params. These pin the dialect's surface
// area; MySQL/SQLite variants (Wave 3) will get their own equivalent suites.

const User: ModelDef<any> = model('users', {
  id: f.id(),
  email: f.string().unique(),
  age: f.int().optional(),
  active: f.bool().default(false),
  tags: f.stringArray().optional(),
  created_at: f.dateTime().default('now'),
}).relate(() => ({
  posts: rel.many('post', { on: 'author_id', refs: 'id' }),
})) as ModelDef<any>;

describe('PG compile — SELECT', () => {
  it('findMany with no args → SELECT * FROM "users"', () => {
    const a = compileSelect(buildSelect('user', User, undefined, 'many'), User);
    expect(a.kind).toBe('sql');
    expect(a.dialect).toBe('postgres');
    expect(a.sql).toBe(
      'SELECT "users"."id", "users"."email", "users"."age", "users"."active", "users"."tags", "users"."created_at" FROM "users"',
    );
    expect(a.params).toEqual([]);
  });

  it('findMany with where + take + skip + orderBy', () => {
    const a = compileSelect(buildSelect('user', User, {
      where: { active: true, age: { gte: 18 } },
      orderBy: { age: 'desc' },
      take: 10, skip: 20,
    }, 'many'), User);
    expect(a.sql).toMatch(/WHERE \("users"\."active" = \$1 AND "users"\."age" >= \$2\)/);
    expect(a.sql).toMatch(/ORDER BY "users"\."age" DESC/);
    expect(a.sql).toMatch(/LIMIT 10/);
    expect(a.sql).toMatch(/OFFSET 20/);
    expect(a.params).toEqual([true, 18]);
  });

  it('findMany with select projection', () => {
    const a = compileSelect(buildSelect('user', User, {
      select: { email: true, active: true },
    }, 'many'), User);
    expect(a.sql.startsWith('SELECT "users"."email", "users"."active" FROM "users"')).toBe(true);
  });

  it('findMany with omit', () => {
    const a = compileSelect(buildSelect('user', User, {
      omit: { email: true, tags: true },
    }, 'many'), User);
    expect(a.sql).not.toMatch(/"email"/);
    expect(a.sql).not.toMatch(/"tags"/);
    expect(a.sql).toMatch(/"id".*"age".*"active"/);
  });

  it('findMany with contains (ILIKE for case-insensitive)', () => {
    const a = compileSelect(buildSelect('user', User, {
      where: { email: { contains: 'gmail', mode: 'insensitive' } },
    }, 'many'), User);
    expect(a.sql).toMatch(/"users"\."email" ILIKE \$1/);
    expect(a.params).toEqual(['%gmail%']);
  });

  it('findMany with composite cursor', () => {
    const a = compileSelect(buildSelect('user', User, {
      cursor: { user_id_video_id: { id: 'x', email: 'a@b.co' } },
    }, 'many'), User);
    expect(a.sql).toMatch(/\("users"\."id", "users"\."email"\) > \(\$1, \$2\)/);
    expect(a.params).toEqual(['x', 'a@b.co']);
  });

  it('findMany with distinct', () => {
    const a = compileSelect(buildSelect('user', User, {
      distinct: ['email'],
    }, 'many'), User);
    expect(a.sql).toMatch(/SELECT DISTINCT ON \("users"\."email"\)/);
  });

  it('findMany with NULLS LAST', () => {
    const a = compileSelect(buildSelect('user', User, {
      orderBy: { age: { sort: 'desc', nulls: 'last' } },
    }, 'many'), User);
    expect(a.sql).toMatch(/ORDER BY "users"\."age" DESC NULLS LAST/);
  });

  it('findMany with `in` operator', () => {
    const a = compileSelect(buildSelect('user', User, {
      where: { id: { in: ['a', 'b', 'c'] } },
    }, 'many'), User);
    expect(a.sql).toMatch(/"users"\."id" IN \(\$1, \$2, \$3\)/);
    expect(a.params).toEqual(['a', 'b', 'c']);
  });

  it('findOne uses LIMIT 1 (cardinality=one)', () => {
    const a = compileSelect(buildSelect('user', User, { where: { email: 'x@y.co' } }, 'one'), User);
    expect(a.sql).toMatch(/WHERE "users"\."email" = \$1/);
    expect(a.params).toEqual(['x@y.co']);
  });
});

describe('PG compile — COUNT', () => {
  it('count with no args → SELECT COUNT(*)', () => {
    const a = compileCount(buildCount('user', User, undefined), User);
    expect(a.sql).toBe('SELECT COUNT(*) AS count FROM "users"');
    expect(a.params).toEqual([]);
  });

  it('count with where', () => {
    const a = compileCount(buildCount('user', User, { where: { active: true } }), User);
    expect(a.sql).toBe('SELECT COUNT(*) AS count FROM "users" WHERE "users"."active" = $1');
    expect(a.params).toEqual([true]);
  });

  it('count with distinct → COUNT(DISTINCT (...))', () => {
    const a = compileCount(buildCount('user', User, { distinct: ['email'] }), User);
    expect(a.sql).toMatch(/COUNT\(DISTINCT \("users"\."email"\)\) AS count/);
  });
});

describe('PG compile — INSERT', () => {
  it('insertOne with returning *', () => {
    const a = compileInsert(buildInsert('user', User, { rows: [{ email: 'a@b.co', age: 25 }] }), User);
    expect(a.sql).toBe('INSERT INTO "users" ("email", "age") VALUES ($1, $2) RETURNING *');
    expect(a.params).toEqual(['a@b.co', 25]);
  });

  it('insertMany batches into one statement', () => {
    const a = compileInsert(buildInsert('user', User, { rows: [
      { email: 'a@b.co' }, { email: 'c@d.co', age: 30 },
    ] }), User);
    expect(a.sql).toMatch(/INSERT INTO "users" \("email", "age"\) VALUES \(\$1, \$2\), \(\$3, \$4\)/);
    expect(a.params).toEqual(['a@b.co', null, 'c@d.co', 30]);
  });

  it('skipDuplicates → ON CONFLICT DO NOTHING', () => {
    const a = compileInsert(buildInsert('user', User, {
      rows: [{ email: 'a@b.co' }], skipDuplicates: true,
    }), User);
    expect(a.sql).toMatch(/ON CONFLICT DO NOTHING RETURNING/);
  });

  it('returning narrows on select projection', () => {
    const a = compileInsert(buildInsert('user', User, {
      rows: [{ email: 'a@b.co' }],
      returning: { select: { email: true } },
    }), User);
    expect(a.sql).toMatch(/RETURNING "email"$/);
  });
});

describe('PG compile — UPDATE', () => {
  it('update with set', () => {
    const a = compileUpdate(buildUpdate('user', User, {
      where: { email: 'a@b.co' }, data: { active: true }, many: false,
    }), User);
    // Single-row idiom via ctid subquery.
    expect(a.sql).toMatch(/UPDATE "users" SET "active" = \$1/);
    expect(a.sql).toMatch(/WHERE ctid = \(SELECT ctid FROM "users" WHERE "users"\."email" = \$2 LIMIT 1\)/);
    expect(a.params).toEqual([true, 'a@b.co']);
  });

  it('updateMany emits a flat WHERE', () => {
    const a = compileUpdate(buildUpdate('user', User, {
      where: { active: false }, data: { active: true }, many: true,
    }), User);
    expect(a.sql).toMatch(/UPDATE "users" SET "active" = \$1 WHERE "users"\."active" = \$2 RETURNING/);
    expect(a.params).toEqual([true, false]);
  });

  it('update with increment → col = col + $n', () => {
    const a = compileUpdate(buildUpdate('user', User, {
      where: { email: 'a@b.co' }, data: { age: { increment: 1 } }, many: true,
    }), User);
    expect(a.sql).toMatch(/SET "age" = "users"\."age" \+ \$1/);
    expect(a.params).toEqual([1, 'a@b.co']);
  });

  it('upsert → INSERT … ON CONFLICT (col) DO UPDATE SET …', () => {
    const a = compileUpdate(buildUpdate('user', User, {
      where: { email: 'a@b.co' },
      data: { age: { increment: 1 } },
      upsertCreate: { email: 'a@b.co', age: 30 },
    }), User);
    expect(a.sql).toMatch(/INSERT INTO "users" \("email", "age"\) VALUES \(\$1, \$2\) ON CONFLICT \("email"\) DO UPDATE SET "age" = "users"\."age" \+ \$3 RETURNING \*/);
    expect(a.params).toEqual(['a@b.co', 30, 1]);
  });
});

describe('PG compile — DELETE', () => {
  it('deleteOne uses ctid idiom', () => {
    const a = compileDelete(buildDelete('user', User, { where: { email: 'a@b.co' }, many: false }), User);
    expect(a.sql).toMatch(/DELETE FROM "users" WHERE ctid = \(SELECT ctid FROM "users" WHERE "users"\."email" = \$1 LIMIT 1\) RETURNING \*/);
    expect(a.params).toEqual(['a@b.co']);
  });

  it('deleteMany emits flat WHERE', () => {
    const a = compileDelete(buildDelete('user', User, { where: { active: false }, many: true }), User);
    expect(a.sql).toMatch(/DELETE FROM "users" WHERE "users"\."active" = \$1 RETURNING \*/);
    expect(a.params).toEqual([false]);
  });
});

describe('PG compile — relation filters (EXISTS subqueries)', () => {
  const Post: ModelDef<any> = model('posts', {
    id: f.id(),
    author_id: f.objectId(),
    title: f.string(),
    published: f.bool().default(false),
  }) as ModelDef<any>;

  // For ad-hoc test models we feed schemaOverride so the EXISTS compiler can
  // resolve relation targets without going through the project schema map.
  const SCHEMA: Record<string, ModelDef<any>> = { user: User, post: Post };

  it('relation `some` → EXISTS subquery joined on FK', () => {
    const a = compileSelect(
      buildSelect('user', User, {
        where: { posts: { some: { title: { contains: 'forge' } } } },
      }, 'many', SCHEMA),
      User, undefined, SCHEMA,
    );
    expect(a.sql).toMatch(
      /EXISTS \(SELECT 1 FROM "posts" "t1" WHERE "t1"\."author_id" = "users"\."id" AND "t1"\."title" LIKE \$1\)/,
    );
    expect(a.params).toEqual(['%forge%']);
  });

  it('relation `none` → NOT EXISTS', () => {
    const a = compileSelect(
      buildSelect('user', User, {
        where: { posts: { none: { published: true } } },
      }, 'many', SCHEMA),
      User, undefined, SCHEMA,
    );
    expect(a.sql).toMatch(/NOT EXISTS \(SELECT 1 FROM "posts" "t1" WHERE "t1"\."author_id" = "users"\."id" AND "t1"\."published" = \$1\)/);
    expect(a.params).toEqual([true]);
  });

  it('relation `every` → NOT EXISTS … AND NOT (condition)', () => {
    const a = compileSelect(
      buildSelect('user', User, {
        where: { posts: { every: { published: true } } },
      }, 'many', SCHEMA),
      User, undefined, SCHEMA,
    );
    expect(a.sql).toMatch(/NOT EXISTS \(SELECT 1 FROM "posts" "t1" WHERE "t1"\."author_id" = "users"\."id" AND NOT \("t1"\."published" = \$1\)\)/);
  });

  it('nested EXISTS (relation → relation) gets unique aliases', () => {
    const Comment = model('comments', {
      id: f.id(),
      post_id: f.objectId(),
      body: f.string(),
    }) as ModelDef<any>;
    const PostWithComments = model('posts', {
      id: f.id(),
      author_id: f.objectId(),
      title: f.string(),
    }).relate(() => ({
      comments: rel.many('comment', { on: 'post_id', refs: 'id' }),
    })) as ModelDef<any>;
    const UserWithPosts = model('users', {
      id: f.id(),
      email: f.string(),
    }).relate(() => ({
      posts: rel.many('post', { on: 'author_id', refs: 'id' }),
    })) as ModelDef<any>;
    const SCHEMA2 = { user: UserWithPosts, post: PostWithComments, comment: Comment };

    const a = compileSelect(
      buildSelect('user', UserWithPosts, {
        where: { posts: { some: { comments: { some: { body: { contains: 'hi' } } } } } },
      }, 'many', SCHEMA2),
      UserWithPosts, undefined, SCHEMA2,
    );
    expect(a.sql).toMatch(/"t1"\..*"t2"\./);   // two distinct aliases used
    expect(a.params).toEqual(['%hi%']);
  });
});

describe('PG compile — injection safety', () => {
  it('identifiers with quote/null characters are rejected', () => {
    const bad = model('user"--', { id: f.id() }) as ModelDef<any>;
    expect(() => compileSelect(buildSelect('user', bad, undefined, 'many'), bad)).toThrow(/invalid identifier/);
  });

  it('LIKE wildcards from user input are escaped', () => {
    const a = compileSelect(buildSelect('user', User, {
      where: { email: { contains: '50% off_' } },
    }, 'many'), User);
    // Wildcards escaped before placeholder so user can't widen the match.
    expect(a.params).toEqual(['%50\\% off\\_%']);
  });

  it('values are parameterised, never interpolated', () => {
    const evil = "1'; DROP TABLE users;--";
    const a = compileSelect(buildSelect('user', User, { where: { email: evil } }, 'many'), User);
    expect(a.sql).not.toContain('DROP TABLE');
    expect(a.params).toEqual([evil]);
  });
});
