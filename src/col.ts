// `col('otherField')` compares one column against another column of the same
// row inside a `where` (vs against a literal). Portable: Mongo `$expr`, SQL
// `a <op> b`. Only the comparison ops accept it — see ir/build/where.ts.

// Global-registry symbol so the brand survives duplicate module instances and
// can't be forged from a JSON request body.
export const FORGE_COL: unique symbol = Symbol.for('forge.orm.col');

export interface ColRef {
  readonly [FORGE_COL]: string;
}

// Generic defaults to `any` so the marker drops into any typed filter slot
// (`lt?: number`, …); pass it explicitly (`col<number>(...)`) to type-check.
export function col<T = any>(field: string): T {
  if (typeof field !== 'string' || field.length === 0) {
    throw new Error('[forge] col() requires a non-empty field name');
  }
  return { [FORGE_COL]: field } as unknown as T;
}

export function isColRef(v: unknown): v is ColRef {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Record<symbol, unknown>)[FORGE_COL] === 'string'
  );
}

export function colRefField(v: ColRef): string {
  return v[FORGE_COL];
}
