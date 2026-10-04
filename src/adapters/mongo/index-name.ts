// The Mongo auto-name rule, in its own dependency-free module.
//
// `push` needs it to name an index it is about to create; `diff` needs it to
// find that same index again when the schema declared no explicit `name`.
// diff-core cannot import push.ts (that module calls dotenv.config() and
// pulls in the Mongo client), so the rule lives here and both sides share it
// rather than each keeping a copy that can drift.

/**
 * Auto-generated index name for a Mongo collection:
 * `idx_<modelKey>_<keys joined by _>[_uq]`.
 *
 * `modelKey` is the SCHEMA KEY (the property name in the schema map), not the
 * collection name — that is what push has always passed.
 *
 * Non-alphanumeric characters in a key are collapsed to `_` so wildcard
 * (`$**`) and dotted paths produce a legal identifier.
 */
export function indexNameFor(
  modelKey: string,
  keys: Record<string, unknown>,
  unique?: boolean,
): string {
  const k = Object.keys(keys)
    .map((s) => s.replace(/[^a-zA-Z0-9]/g, '_'))
    .join('_');
  return `idx_${modelKey}_${k}${unique ? '_uq' : ''}`;
}
