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
  return '$' + path.map(segment).join('');
}

/**
 * A key that is not a plain identifier has to be quoted.
 *
 * `$.a b` and `$.order-id` are not valid JSONPath, and neither is anything
 * carrying a quote — MySQL rejects the whole expression with "Invalid JSON
 * path expression", so a column whose keys have spaces or hyphens simply
 * could not be queried. (It fails safe rather than injecting, because the
 * path is a bound parameter, but failing is still failing.) Every dialect
 * that takes a path string accepts the `$."quoted"` form.
 */
function segment(s: string): string {
  if (/^\d+$/.test(s)) return `[${s}]`;
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) return `.${s}`;
  return `."${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
