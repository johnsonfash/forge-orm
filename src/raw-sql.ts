// Raw-SQL tagged template helpers — same shape as Prisma's `Prisma.sql` /
// `Prisma.raw` / `Prisma.join`. Make hand-written SQL safe by default:
// values can't be string-interpolated, only parameter-bound.
//
//   db.$queryRaw`SELECT * FROM users WHERE id = ${userId} AND active = ${true}`
//   // → { sql: 'SELECT * FROM users WHERE id = $1 AND active = $2', params: [userId, true] }
//
// Composition:
//   const tail = active ? forge.sql`AND active = ${true}` : forge.empty;
//   db.$queryRaw`SELECT * FROM users WHERE org_id = ${orgId} ${tail}`
//   // The inner fragment's params get renumbered into the outer one.
//
// Trust-the-caller hatch:
//   forge.raw('TIMESTAMPTZ')  — emit literal SQL (no escaping). Reserved for
//                              identifiers / type names the caller knows are
//                              safe (constants in code, never user input).

export interface SqlFragment {
  readonly __forgeSql: true;
  readonly strings: readonly string[];
  readonly values: readonly unknown[];
}

const FRAG = Symbol.for('forge.sql.fragment');

function makeFragment(strings: readonly string[], values: readonly unknown[]): SqlFragment {
  return { __forgeSql: true, strings, values } as const;
}

export function isSqlFragment(v: unknown): v is SqlFragment {
  return !!v && typeof v === 'object' && (v as any).__forgeSql === true;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export const forgeSql = {
  // Tagged template: builds a SqlFragment with parameter placeholders.
  sql(strings: TemplateStringsArray, ...values: unknown[]): SqlFragment {
    return makeFragment(strings, values);
  },
  // Literal SQL passthrough. ⚠ Anything you pass here is interpolated as-is.
  // Use only for constants known at code-write time (column names, type
  // names). Never pass user input.
  raw(sql: string): SqlFragment {
    return makeFragment([sql], []);
  },
  // Join an array of SqlFragments with a separator. The separator is itself
  // a literal — use forge.raw(',') for typical list cases.
  join(parts: SqlFragment[], separator: string = ', '): SqlFragment {
    if (parts.length === 0) return forgeSql.empty;
    const strings: string[] = [];
    const values: unknown[] = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (i === 0) strings.push(p.strings[0]);
      else strings[strings.length - 1] += separator + p.strings[0];
      for (let j = 0; j < p.values.length; j++) {
        values.push(p.values[j]);
        strings.push(p.strings[j + 1]);
      }
    }
    return makeFragment(strings, values);
  },
  // Empty fragment — useful for "no clause" branches in conditional composition.
  empty: makeFragment([''], []),
};

void FRAG;

// ─── Compilation ────────────────────────────────────────────────────────────
//
// Turn a SqlFragment into final SQL + params for a specific dialect.
// Postgres: $1, $2, $3 placeholders. MySQL/SQLite: ? placeholders.

export interface CompiledRawSql {
  sql: string;
  params: unknown[];
}

export function compileSqlFragment(
  frag: SqlFragment,
  dialect: 'postgres' | 'mysql' | 'sqlite' = 'postgres',
): CompiledRawSql {
  const params: unknown[] = [];
  const sqlParts: string[] = [];
  appendFragment(frag, dialect, params, sqlParts);
  return { sql: sqlParts.join(''), params };
}

function appendFragment(
  frag: SqlFragment,
  dialect: 'postgres' | 'mysql' | 'sqlite',
  params: unknown[],
  out: string[],
): void {
  const { strings, values } = frag;
  out.push(strings[0]);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (isSqlFragment(v)) {
      // Nested fragment: inline its SQL, renumbering placeholders by appending
      // to the same params array.
      appendFragment(v, dialect, params, out);
    } else {
      params.push(v);
      const ph = dialect === 'postgres' ? `$${params.length}` : '?';
      out.push(ph);
    }
    out.push(strings[i + 1]);
  }
}
