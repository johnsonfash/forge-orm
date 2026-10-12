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

/*
 * ---- WEB CRYPTO, NOT `node:crypto` ---------------------------------
 *
 * The first version of this file imported `randomBytes` from
 * `node:crypto` and built the id with a `Buffer`. Both are Node-only,
 * and this module is NOT Node-only: forge ships an IndexedDB adapter,
 * so a browser app importing forge loads this file too — and these two
 * calls run at MODULE SCOPE, so the failure is not "ids are broken", it
 * is the whole bundle throwing on import:
 *
 *     (0 , node_crypto_1.randomBytes) is not a function
 *
 * Measured in a real app: the operator UI never finished booting. The
 * splash sat there and then showed its chunk-load fallback, because the
 * error happens before anything of the app's own has run. Nothing in
 * this library's own tests caught it — they all run under Node, where
 * the import resolves perfectly.
 *
 * `globalThis.crypto.getRandomValues` is the one that exists in every
 * runtime forge targets: browsers, workers, Deno, Bun, and Node 18+
 * (where Web Crypto is global and no longer behind a flag). The hex is
 * built from a `Uint8Array` for the same reason — `Buffer` is Node's,
 * and a bundler that does not polyfill it fails exactly as loudly.
 */
function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const webcrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (webcrypto?.getRandomValues) {
    webcrypto.getRandomValues(out);
    return out;
  }
  // No Web Crypto at all. Not a runtime forge supports, but an id that
  // is weakly random beats throwing at import time in one that slips
  // through — the counter and the timestamp still order correctly.
  for (let i = 0; i < n; i += 1) out[i] = Math.floor(Math.random() * 256);
  return out;
}

const PROCESS_RANDOM = randomBytes(5);
const seed = randomBytes(3);
let counter = ((seed[0]! << 16) | (seed[1]! << 8) | seed[2]!) >>> 0;

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

export function objectIdHex(now: number = Date.now()): string {
  counter = (counter + 1) % 0x1000000;
  const b = new Uint8Array(12);
  const secs = Math.floor(now / 1000);
  b[0] = (secs >>> 24) & 0xff;
  b[1] = (secs >>> 16) & 0xff;
  b[2] = (secs >>> 8) & 0xff;
  b[3] = secs & 0xff;
  b.set(PROCESS_RANDOM, 4);
  b[9] = (counter >>> 16) & 0xff;
  b[10] = (counter >>> 8) & 0xff;
  b[11] = counter & 0xff;
  let out = '';
  for (let i = 0; i < 12; i += 1) out += HEX[b[i]!];
  return out;
}

/** The shape, for anything that has to recognise one. */
export const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;
