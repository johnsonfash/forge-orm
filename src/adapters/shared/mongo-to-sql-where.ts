// Translator for partial-index `where` objects: Mongo query-document → SQL.
//
// Scope is deliberately small. It only covers the operators that show up in
// real `partialFilterExpression` clauses on production schemas (the audit
// across forge consumers found that ~95% of partial-filter expressions use
// only a handful of operators). The goal is "Mongo schemas don't have to
// hand-author parallel SQL strings for portable `where` clauses"; if you need
// arbitrary Mongo query translation, pass a raw SQL string instead.
//
// Supported operators (Mongo → SQL):
//
//   { col: <scalar> }                 → "col" = <param>
//   { col: { $eq: <scalar> } }        → "col" = <param>
//   { col: { $ne: <scalar> } }        → "col" <> <param>      (or IS NOT NULL when <scalar> is null)
//   { col: { $gt:  <scalar> } }       → "col" > <param>
//   { col: { $gte: <scalar> } }       → "col" >= <param>
//   { col: { $lt:  <scalar> } }       → "col" < <param>
//   { col: { $lte: <scalar> } }       → "col" <= <param>
//   { col: { $in:  [<v>, …] } }       → "col" IN (<params>)
//   { col: { $nin: [<v>, …] } }       → "col" NOT IN (<params>)
//   { col: { $exists: true } }        → "col" IS NOT NULL
//   { col: { $exists: false } }       → "col" IS NULL
//   { col: { $type: 'string' } }      → "col" IS NOT NULL          (best-effort — Mongo $type checks BSON
//                                                                    type; the closest SQL approximation
//                                                                    for a partial-filter "field is present
//                                                                    and the right type" is IS NOT NULL.)
//
//   Top-level $and / $or compose recursively.
//   Implicit AND on multiple top-level keys.
//
// Anything we can't translate returns `null` — the caller (push.ts, doctor)
// is expected to warn and either skip the WHERE clause (push) or surface a
// portability finding (doctor). The function NEVER throws.
//
// All values are inlined as SQL literals (not parameters). Partial-index
// WHERE clauses are part of DDL, not query execution, so there's nothing to
// parameterise — but the literals are escaped to be injection-safe against
// the values the user put in their schema.

const COMPARATORS: Record<string, string> = {
  $eq: '=',
  $ne: '<>',
  $gt: '>',
  $gte: '>=',
  $lt: '<',
  $lte: '<=',
};

export interface TranslateOptions {
  /** Identifier quoting per dialect. PG/SQLite use double quotes; MySQL uses
   *  backticks. Default: double quotes. */
  quoteIdent?: (col: string) => string;
  /** Dialect — drives operator dispatch where the SQL differs (e.g. $regex
   *  is `col ~ 'pat'` on PG, `col REGEXP 'pat'` on MySQL, no operator on
   *  SQLite). Default: 'postgres' (most common partial-index target). */
  dialect?: 'postgres' | 'mysql' | 'sqlite';
}

export function mongoToSqlWhere(
  filter: Record<string, unknown>,
  opts: TranslateOptions = {},
): string | null {
  const q = opts.quoteIdent ?? ((c: string) => `"${c.replace(/"/g, '""')}"`);
  const dialect = opts.dialect ?? 'postgres';
  return translateNode(filter, q, dialect);
}

type Dialect = NonNullable<TranslateOptions['dialect']>;

function translateNode(
  node: Record<string, unknown>,
  q: (c: string) => string,
  dialect: Dialect,
): string | null {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === '$and' || key === '$or') {
      if (!Array.isArray(value)) return null;
      const sub: string[] = [];
      for (const child of value) {
        if (!child || typeof child !== 'object') return null;
        const t = translateNode(child as Record<string, unknown>, q, dialect);
        if (t === null) return null;
        sub.push(`(${t})`);
      }
      if (sub.length === 0) continue;
      parts.push(sub.join(key === '$and' ? ' AND ' : ' OR '));
      continue;
    }
    if (key === '$nor') {
      // NOR == NOT (a OR b OR …). Translate as such.
      if (!Array.isArray(value) || value.length === 0) return null;
      const sub: string[] = [];
      for (const child of value) {
        if (!child || typeof child !== 'object') return null;
        const t = translateNode(child as Record<string, unknown>, q, dialect);
        if (t === null) return null;
        sub.push(`(${t})`);
      }
      parts.push(`NOT (${sub.join(' OR ')})`);
      continue;
    }
    if (key.startsWith('$')) return null; // unsupported top-level operator
    const f = translateField(key, value, q, dialect);
    if (f === null) return null;
    parts.push(f);
  }
  if (parts.length === 0) return null;
  return parts.join(' AND ');
}

function translateField(
  col: string,
  value: unknown,
  q: (c: string) => string,
  dialect: Dialect,
): string | null {
  // Scalar shorthand: { col: 5 } → "col" = 5
  if (value === null || isScalar(value)) {
    if (value === null) return `${q(col)} IS NULL`;
    return `${q(col)} = ${literal(value)}`;
  }
  if (Array.isArray(value)) return null; // bare array isn't a Mongo query
  if (typeof value !== 'object') return null;

  const ops = Object.entries(value as Record<string, unknown>);
  const subParts: string[] = [];
  for (const [opName, opValue] of ops) {
    const piece = translateOperator(col, opName, opValue, q, dialect);
    if (piece === null) return null;
    subParts.push(piece);
  }
  if (subParts.length === 0) return null;
  return subParts.join(' AND ');
}

function translateOperator(
  col: string,
  opName: string,
  opValue: unknown,
  q: (c: string) => string,
  dialect: Dialect,
): string | null {
  if (opName in COMPARATORS) {
    const sym = COMPARATORS[opName];
    if (opValue === null) {
      // $ne null → IS NOT NULL; $eq null → IS NULL.
      if (opName === '$eq') return `${q(col)} IS NULL`;
      if (opName === '$ne') return `${q(col)} IS NOT NULL`;
      return null; // gt/lt against null don't translate sensibly
    }
    if (!isScalar(opValue)) return null;
    return `${q(col)} ${sym} ${literal(opValue)}`;
  }
  if (opName === '$in' || opName === '$nin') {
    if (!Array.isArray(opValue) || opValue.length === 0) return null;
    if (!opValue.every(isScalar)) return null;
    const list = opValue.map(literal).join(', ');
    return `${q(col)} ${opName === '$in' ? 'IN' : 'NOT IN'} (${list})`;
  }
  if (opName === '$exists') {
    if (opValue === true) return `${q(col)} IS NOT NULL`;
    if (opValue === false) return `${q(col)} IS NULL`;
    return null;
  }
  if (opName === '$type') {
    // Mongo's $type is BSON-type aware; the closest SQL approximation for the
    // common pattern (`$type: 'string'` as a "field present + correct type"
    // guard on an optional column) is IS NOT NULL.
    return `${q(col)} IS NOT NULL`;
  }
  if (opName === '$regex') {
    // Mongo regex uses PCRE-ish syntax. SQL flavors differ:
    //   - Postgres: `col ~ 'pattern'` (POSIX ERE, close enough for partial
    //     filters that don't lean on PCRE-specific syntax)
    //   - MySQL: `col REGEXP 'pattern'` (also POSIX-flavoured)
    //   - SQLite: needs a user-defined REGEXP function and is rarely loaded —
    //     fall back to null so the caller warns and either drops the filter
    //     or writes a raw SQL string.
    if (typeof opValue !== 'string') return null;
    if (dialect === 'postgres') return `${q(col)} ~ ${literal(opValue)}`;
    if (dialect === 'mysql') return `${q(col)} REGEXP ${literal(opValue)}`;
    return null; // sqlite — caller falls back to raw SQL
  }
  if (opName === '$size') {
    // Mongo $size matches an array's exact length. Only translates on
    // Postgres (array column types).
    if (typeof opValue !== 'number' || !Number.isFinite(opValue)) return null;
    if (dialect === 'postgres') {
      return `coalesce(array_length(${q(col)}, 1), 0) = ${opValue}`;
    }
    return null;
  }
  if (opName === '$not') {
    // $not wraps a sub-expression scoped to this field. Recurse via
    // translateField with the inner spec, then NOT the result.
    if (!opValue || typeof opValue !== 'object' || Array.isArray(opValue)) return null;
    const inner = translateField(col, opValue, q, dialect);
    if (inner === null) return null;
    return `NOT (${inner})`;
  }
  return null;
}

function isScalar(v: unknown): v is string | number | boolean | Date {
  if (v === null) return false;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return true;
  if (v instanceof Date) return true;
  return false;
}

function literal(v: string | number | boolean | Date): string {
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return `'${v.toISOString()}'`;
  return 'NULL';
}
