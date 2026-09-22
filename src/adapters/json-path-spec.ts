/**
 * Build a JSONPath string — `$.a.b[0]` — from the segments a caller supplied.
 *
 * It is returned as a VALUE for the dialect to bind as a parameter, never
 * spliced into the SQL text. Every dialect that takes a path as a string used
 * to hand-escape it, and MySQL's escaping was wrong in a way that turned a
 * `where: { meta: { path: [...] } }` into arbitrary SQL. There is nothing to
 * escape once the path is a parameter.
 */
export function jsonPathSpec(path: string[]): string {
  return '$' + path.map((s) => (/^\d+$/.test(s) ? `[${s}]` : `.${s}`)).join('');
}
