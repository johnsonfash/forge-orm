import { randomBytes } from 'node:crypto';

/**
 * A 24-hex id with the same layout as a MongoDB ObjectId, generated
 * without the BSON driver.
 *
 * ---- WHY FORGE MINTS THESE AT ALL ----------------------------------
 *
 * `f.id()` defaults to an ObjectId on Mongo and a UUID v4 on SQL,
 * because each is the native thing on its own engine. That is the right
 * default and the wrong one for a codebase that moves between them: the
 * old rows keep 24-hex ids, the new rows get UUIDs, and every place that
 * knew what an id looks like quietly stops being true.
 *
 * Measured on a real port, before a single row moved: a regex gate on
 * job ids rejected every job and skipped a whole background queue; an
 * inbound-email address parser stopped recognising the thread id it had
 * generated itself; an assistant answered "I can't find that" about a
 * row it was holding by its key. No error in any of them.
 *
 * `f.id({ type: 'objectId' })` is the escape: one shape on every engine,
 * so a port is a data copy rather than an id remap across every foreign
 * key in the schema.
 *
 * ---- THE LAYOUT, AND WHY IT IS WORTH KEEPING -----------------------
 *
 * 4-byte seconds, 5-byte per-process random, 3-byte counter —
 * MongoDB's own spec. Two properties fall out of it and both are the
 * reason to choose this over a UUID:
 *
 *   • It SORTS BY TIME. `orderBy: { id: 'desc' }` is "newest first" on
 *     any engine, which a v4 UUID cannot do at all.
 *   • It inserts LOCALLY. A monotonic prefix keeps btree inserts at the
 *     right-hand edge instead of scattering them across the index, which
 *     is the usual cost of random uuid primary keys on SQL.
 *
 * The counter starts at a random point and wraps at 2^24, per the spec,
 * so two ids minted in the same second by the same process still order
 * by the order they were minted.
 */

const PROCESS_RANDOM = randomBytes(5);
let counter = randomBytes(3).readUIntBE(0, 3);

export function objectIdHex(now: number = Date.now()): string {
  counter = (counter + 1) % 0x1000000;
  const buf = Buffer.allocUnsafe(12);
  buf.writeUInt32BE(Math.floor(now / 1000), 0);
  PROCESS_RANDOM.copy(buf, 4);
  buf.writeUIntBE(counter, 9, 3);
  return buf.toString('hex');
}

/** The shape, for anything that has to recognise one. */
export const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;
