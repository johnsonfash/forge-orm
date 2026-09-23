// Normalisation for `f.bytes()` values.
//
// One shape crosses the API boundary — `Uint8Array` — because it is the only
// binary container that exists unchanged in Node, the browser, Bun, Deno and
// a Tauri webview. A Node `Buffer` is accepted on write since Buffer IS a
// Uint8Array; an `ArrayBuffer` is accepted because that is what `File`/
// `Blob.arrayBuffer()` and `fetch().arrayBuffer()` hand back, and requiring
// the caller to wrap it is friction with no upside.
//
// Reads always hand back something that IS a `Uint8Array`, never a driver's
// own wrapper (mongodb's `Binary`), so the row a server reads has the same
// usable type as the row the browser reads. On Node that value is usually the
// driver's `Buffer`, which is a Uint8Array subclass — it is passed through
// rather than copied, because re-wrapping every blob on every read to hide a
// subclass would cost more than it buys.

/** A `bytes` value as it may arrive from application code. */
export type BytesInput = Uint8Array | ArrayBuffer | ArrayBufferView;

export function isBytesInput(v: unknown): v is BytesInput {
  return v instanceof Uint8Array || v instanceof ArrayBuffer || ArrayBuffer.isView(v);
}

/**
 * Coerce any accepted binary input to a `Uint8Array` VIEW — no copy when the
 * input is already one. A `Buffer` is returned as-is (it satisfies
 * `Uint8Array`), so this is free on the server's hot path.
 */
export function toBytes(v: BytesInput): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  // Any other view (DataView, Int16Array, …) — reinterpret its exact window
  // of the buffer rather than its elements, so byte length is preserved.
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

/**
 * The type error a caller gets for passing something that is not binary at
 * all. Kept as one message so every dialect reports the same thing.
 */
export function bytesTypeError(model: string, field: string, value: unknown): Error {
  const got =
    value === null ? 'null'
    : typeof value === 'object' ? (value.constructor?.name ?? 'object')
    : typeof value;
  return new Error(
    `[forge] ${model}.${field} is f.bytes() and takes binary — a Uint8Array, ` +
    `Buffer, ArrayBuffer or typed-array view. Got ${got}.` +
    (typeof value === 'string'
      ? '\n  A base64 or hex string is not binary: decode it first ' +
        "(Buffer.from(s, 'base64'), or Uint8Array.from(atob(s), c => c.charCodeAt(0)) in the browser)."
      : ''),
  );
}

/**
 * Enforce a `maxBytes` ceiling on write.
 *
 * This runs on every dialect, including the ones whose binary type has no
 * declared length (Postgres `bytea`, SQLite `BLOB`, Mongo BinData). Without
 * it `maxBytes` would be a MySQL-only constraint, and the same write would
 * be accepted by one database and rejected by another — the exact class of
 * difference this library exists to remove.
 */
export function assertWithinMaxBytes(
  model: string,
  field: string,
  maxBytes: number | undefined,
  bytes: Uint8Array,
): void {
  if (maxBytes == null || bytes.byteLength <= maxBytes) return;
  throw new Error(
    `[forge] ${model}.${field} is ${bytes.byteLength} bytes, over its declared ` +
    `maxBytes of ${maxBytes}.`,
  );
}

/**
 * Driver → app. Unwraps the wrappers the drivers hand back:
 *   mongodb  → `Binary` (has `.buffer`), or `Buffer` with promoteBuffers
 *   pg       → `Buffer`
 *   mysql2   → `Buffer`
 *   mssql    → `Buffer`
 *   sqlite   → `Buffer` (better-sqlite3) / `Uint8Array` (wasm)
 *   duckdb   → `Uint8Array` / `Buffer`
 * Anything already a Uint8Array passes through untouched.
 */
export function fromDriverBytes(v: unknown): unknown {
  if (v == null) return v;
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return toBytes(v);
  // mongodb's BSON Binary — `_bsontype` rather than an instanceof, so a
  // duplicate bson module instance in the tree still matches.
  const b = v as { _bsontype?: string; buffer?: unknown; value?: () => unknown };
  if (b._bsontype === 'Binary') {
    if (b.buffer instanceof Uint8Array) return b.buffer;
    const val = typeof b.value === 'function' ? b.value.call(b) : undefined;
    if (val instanceof Uint8Array) return val;
    if (val instanceof ArrayBuffer) return new Uint8Array(val);
  }
  /*
   * DuckDB's node bindings hand back a `DuckDBBlobValue` wrapper rather than
   * the bytes. Matched on the shape, like the BSON case above, so a second
   * copy of @duckdb/node-api in the tree still works.
   *
   * AFTER the BSON check and gated on `_bsontype` being absent, because
   * `Decimal128` ALSO has a `bytes` Uint8Array — its 16-byte internal
   * representation. Matching shape alone would quietly turn a decimal into
   * those raw bytes. Nothing calls this on a decimal today (it runs only for
   * `field.kind === 'bytes'`), but it is exported, so the guard belongs here
   * rather than in the callers' habits.
   */
  if (b._bsontype === undefined) {
    const d = v as { bytes?: unknown };
    if (d.bytes instanceof Uint8Array) return d.bytes;
  }
  return v;
}

/**
 * Some drivers only bind a Node `Buffer` for a binary parameter and will
 * otherwise stringify a plain `Uint8Array` — which silently stores the text
 * "[object Uint8Array]" or a comma-joined digit list instead of the bytes.
 * Zero-copy: Buffer.from(view.buffer, offset, length) wraps, it does not copy.
 */
export function toDriverBuffer(bytes: Uint8Array): Uint8Array {
  const B = (globalThis as { Buffer?: { isBuffer(v: unknown): boolean; from(...a: any[]): Uint8Array } }).Buffer;
  if (!B) return bytes;                 // browser / worker — no Buffer to make
  if (B.isBuffer(bytes)) return bytes;
  return B.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}


/**
 * Validate + prepare a `bytes` value for a SQL driver's parameter slot.
 * Throws with the field's name rather than the driver's opaque bind error.
 */
export function bytesForDriver(
  model: string,
  field: string,
  maxBytes: number | undefined,
  v: unknown,
): Uint8Array {
  if (!isBytesInput(v)) throw bytesTypeError(model, field, v);
  const bytes = toBytes(v);
  assertWithinMaxBytes(model, field, maxBytes, bytes);
  return toDriverBuffer(bytes);
}

/**
 * Same validation, but for a store that keeps the value as a JS object —
 * IndexedDB's structured clone, and Mongo's BSON serialiser. No Buffer wrap:
 * in a browser there is no Buffer, and both stores take a typed array.
 */
export function bytesForStore(
  model: string,
  field: string,
  maxBytes: number | undefined,
  v: unknown,
): Uint8Array {
  if (!isBytesInput(v)) throw bytesTypeError(model, field, v);
  const bytes = toBytes(v);
  assertWithinMaxBytes(model, field, maxBytes, bytes);
  return bytes;
}
