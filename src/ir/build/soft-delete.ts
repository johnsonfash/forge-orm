import type { ModelDef } from '../../schema/types';

// Soft-delete scoping for the IR. The wrapper applies its own copy of this to
// the TOP-level read; relation sub-selects are built here, so without this a
// `findMany({ include: { posts: true } })` handed back posts the caller had
// already soft-deleted.

/** Name of the field declared with `.softDeleteAt()`, if the model has one. */
export function softDeleteField(model: ModelDef<any>): string | undefined {
  for (const [name, def] of Object.entries(model.fields)) {
    if ((def as any).softDeleteAt) return name;
  }
  return undefined;
}

/**
 * Scope a read's args to rows that are not soft-deleted, per `model`'s own
 * soft-delete field — the TARGET model's, when this is a relation sub-select.
 *
 * `_withDeleted: true` opts out. The flag is stripped either way: it is a
 * directive, not a column, so a where that still carries it compiles to a
 * filter on a column named `_withDeleted` that no table has.
 *
 * A caller's own filter on the soft-delete field wins untouched — that is how
 * you ask for "deleted since Friday".
 */
export function withSoftDeleteFilter<A extends { where?: any }>(
  model: ModelDef<any>,
  args: A,
): A {
  const where = args.where;
  const hasFlag = !!where && typeof where === 'object'
    && Object.prototype.hasOwnProperty.call(where, '_withDeleted');
  const optOut = hasFlag && !!(where as any)._withDeleted;
  let scoped: any = where;
  if (hasFlag) {
    const { _withDeleted: _flag, ...rest } = where as Record<string, unknown>;
    scoped = rest;
  }
  const sd = softDeleteField(model);
  const addFilter = !!sd && !optOut
    && !(scoped && Object.prototype.hasOwnProperty.call(scoped, sd));
  if (addFilter) return { ...args, where: { ...(scoped ?? {}), [sd as string]: null } };
  return hasFlag ? { ...args, where: scoped } : args;
}
