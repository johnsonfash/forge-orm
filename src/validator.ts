// Reusable, typed query-fragment helper. Equivalent to Prisma's
// `Prisma.validator<T>()(literal)` — a no-op at runtime that captures the
// argument shape and gives you a typed handle you can share across call
// sites.
//
// Usage:
//   const isActiveAdult = forgeValidator<Forge.User.WhereInput>()({
//     active: true,
//     age: { gte: 18 },
//   });
//   db.user.findMany({ where: isActiveAdult });
//   db.user.count({ where: isActiveAdult });
//
// The double-call pattern (`forgeValidator<T>()(literal)`) lets TypeScript
// infer `literal`'s narrowest shape while still type-checking it against T.

export function forgeValidator<T>(): <V extends T>(value: V) => V {
  return (value) => value;
}
