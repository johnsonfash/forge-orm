// One id shape on every engine.
//
// `f.id()` mints an ObjectId on Mongo and a UUID v4 on SQL — each the
// native thing on its own engine, and the right default. It is the
// wrong default for a codebase that has to run on both: old rows keep
// 24-hex ids, new rows get UUIDs, and everything that knew what an id
// looks like quietly stops being true.
//
// Measured on a real port, before a row moved: a regex gate rejected
// every background job id and skipped the whole queue; an inbound-email
// parser stopped recognising the thread id it generated itself; an
// assistant answered "I can't find that" about a row it was holding by
// its key. No error in any of them.

import { createDb, f, model } from '../index';
import { objectIdHex, OBJECT_ID_PATTERN } from '../object-id';

const schema = {
  Thing: model('things', { id: f.id({ type: 'objectId' }), name: f.string() }),
  Other: model('others', { id: f.id(), name: f.string() }),
};

describe('f.id({ type: "objectId" })', () => {
  it('⚠️ MINTS A 24-HEX ID ON A SQL DIALECT, NOT A UUID', async () => {
    const db = await createDb({ url: 'sqlite::memory:', schema });
    await db.$migrate();
    const row = await db.Thing.create({ data: { name: 'a' } as never });
    expect((row as { id: string }).id).toMatch(OBJECT_ID_PATTERN);
    await db.$disconnect();
  });

  it('leaves a plain f.id() on the native shape', async () => {
    // The default is unchanged — this is opt-in, not a behaviour change.
    const db = await createDb({ url: 'sqlite::memory:', schema });
    await db.$migrate();
    const row = await db.Other.create({ data: { name: 'b' } as never });
    expect((row as { id: string }).id).not.toMatch(OBJECT_ID_PATTERN);
    expect((row as { id: string }).id).toContain('-'); // uuid
    await db.$disconnect();
  });

  it('createDb({ defaultIdType }) covers a whole schema at once', async () => {
    /*
     * The point of the connection-level default: a schema with hundreds
     * of models should not repeat itself on every `f.id()`, and — more
     * to the point — a model added next year must not get the other
     * shape just because somebody forgot.
     */
    const db = await createDb({ url: 'sqlite::memory:', schema, defaultIdType: 'objectId' });
    await db.$migrate();
    const row = await db.Other.create({ data: { name: 'c' } as never });
    expect((row as { id: string }).id).toMatch(OBJECT_ID_PATTERN);
    await db.$disconnect();
  });

  it('a caller-supplied id still wins', async () => {
    const db = await createDb({ url: 'sqlite::memory:', schema });
    await db.$migrate();
    const row = await db.Thing.create({ data: { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: 'd' } as never });
    expect((row as { id: string }).id).toBe('aaaaaaaaaaaaaaaaaaaaaaaa');
    await db.$disconnect();
  });
});

describe('the generated id itself', () => {
  it('sorts by time, which is the whole reason to prefer it', () => {
    // A v4 UUID cannot do this at all, and `orderBy: { id: 'desc' }`
    // standing in for "newest first" is a real pattern in real schemas.
    const older = objectIdHex(Date.parse('2026-01-01T00:00:00Z'));
    const newer = objectIdHex(Date.parse('2026-06-01T00:00:00Z'));
    expect(older < newer).toBe(true);
  });

  it('orders two ids minted in the same second by when they were minted', () => {
    const now = Date.now();
    const a = objectIdHex(now);
    const b = objectIdHex(now);
    expect(a < b).toBe(true);
  });

  it('carries the timestamp in the first four bytes', () => {
    const at = Date.parse('2026-03-04T05:06:07Z');
    const seconds = parseInt(objectIdHex(at).slice(0, 8), 16);
    expect(seconds).toBe(Math.floor(at / 1000));
  });

  it('is 24 lowercase hex characters', () => {
    expect(objectIdHex()).toMatch(/^[0-9a-f]{24}$/);
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 5000 }, () => objectIdHex()));
    expect(seen.size).toBe(5000);
  });
});
