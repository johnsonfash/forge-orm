// JSON-null markers — same role as Prisma's `Prisma.DbNull` / `JsonNull` / `AnyNull`.
//
// Background: SQL JSON columns distinguish between "the column itself is SQL
// NULL" and "the JSON value stored in the column is the JSON `null` literal."
// These markers let callers be explicit about which one they mean.
//
//   db.user.update({ where, data: { settings: ForgeDbNull   } })  → settings = NULL
//   db.user.update({ where, data: { settings: ForgeJsonNull } })  → settings = 'null'::jsonb
//
// For Mongo, `JsonNull` and `DbNull` collapse to `null` (no distinction). The
// markers still serialise correctly, so call sites stay portable across
// adapters.

export const ForgeDbNull   = Object.freeze({ __forge: 'DbNull'   as const });
export const ForgeJsonNull = Object.freeze({ __forge: 'JsonNull' as const });
export const ForgeAnyNull  = Object.freeze({ __forge: 'AnyNull'  as const });

export type ForgeDbNull   = typeof ForgeDbNull;
export type ForgeJsonNull = typeof ForgeJsonNull;
export type ForgeAnyNull  = typeof ForgeAnyNull;

export function isForgeNullMarker(v: unknown): v is ForgeDbNull | ForgeJsonNull | ForgeAnyNull {
  return !!v && typeof v === 'object'
    && '__forge' in (v as any)
    && ['DbNull', 'JsonNull', 'AnyNull'].includes((v as any).__forge);
}
