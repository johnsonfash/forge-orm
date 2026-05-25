import type { CursorSpec } from '../types';

// Build a CursorSpec from a Prisma-shape cursor arg.
//
// Single-field:   { id: 'x' }                           → { fields: { id: 'x' } }
// Composite:      { user_id_video_id: { user_id, video_id } }
//                                                       → { fields: { user_id, video_id } }
//
// Composite cursors use a synthetic key (same convention as @@unique). The IR
// flattens it so adapters compile cleanly to (id > ?) ((a, b) > (?, ?)) or
// the equivalent.

export function buildCursor(cursor: any): CursorSpec | undefined {
  if (!cursor || typeof cursor !== 'object') return undefined;
  const fields: Record<string, any> = {};
  for (const key of Object.keys(cursor)) {
    const v = (cursor as any)[key];
    if (v == null) continue;
    // Composite form: key is a synthetic name, value is the object map.
    if (typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
      for (const inner of Object.keys(v)) fields[inner] = v[inner];
    } else {
      fields[key] = v;
    }
  }
  return Object.keys(fields).length ? { fields } : undefined;
}
