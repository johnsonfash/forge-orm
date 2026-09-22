import { f, model } from '../schema/core';
import { buildSchemaDDL as buildPg } from '../adapters/postgres/ddl';
import { buildSchemaDDL as buildMysql } from '../adapters/mysql/ddl';
import { buildSchemaDDL as buildSqlite } from '../adapters/sqlite/ddl';
import { toBytes, isBytesInput, fromDriverBytes, bytesForDriver, bytesForStore } from '../bytes';
import { fieldCategory, dbTypeCategory } from '../scripts/diff-core';
import { buildUpdateData } from '../ir/build';

// `f.bytes()` — binary stored as the dialect's own binary type. The point of
// the type is that a blob costs its own length; a string column would cost
// 4/3 of it plus an encode pass on every read and write.

const Asset = model('assets', {
  id: f.id(),
  body: f.bytes(),
  etag: f.bytes({ maxBytes: 32 }),
  small: f.bytes({ maxBytes: 1_000 }),
  medium: f.bytes({ maxBytes: 70_000 }),
  large: f.bytes({ maxBytes: 20_000_000 }),
});
const sample = { asset: Asset } as any;

const tableSql = (stmts: { kind: string; name: string; sql: string }[]) =>
  stmts.find((s) => s.kind === 'table' && s.name === 'assets')!.sql;

describe('f.bytes() — DDL', () => {
  test('Postgres: bytea, and maxBytes does not change the type', () => {
    const sql = tableSql(buildPg(sample));
    expect(sql).toContain('"body" bytea');
    expect(sql).toContain('"etag" bytea');
    expect(sql).toContain('"large" bytea');
  });

  test('MySQL: maxBytes picks the smallest blob class that fits', () => {
    const sql = tableSql(buildMysql(sample));
    expect(sql).toContain('`body` LONGBLOB');        // undeclared → widest
    expect(sql).toContain('`etag` TINYBLOB');        // <=255
    expect(sql).toContain('`small` BLOB');           // 256..65_535
    expect(sql).toContain('`medium` MEDIUMBLOB');    // <=16_777_215
    expect(sql).toContain('`large` LONGBLOB');
  });

  test('SQLite: BLOB', () => {
    const sql = tableSql(buildSqlite(sample));
    expect(sql).toContain('"body" BLOB');
    expect(sql).toContain('"etag" BLOB');
  });
});

describe('f.bytes() — declaration', () => {
  test('rejects a nonsense maxBytes at declaration time, not at write time', () => {
    expect(() => f.bytes({ maxBytes: 0 })).toThrow(/positive integer/);
    expect(() => f.bytes({ maxBytes: -1 })).toThrow(/positive integer/);
    expect(() => f.bytes({ maxBytes: 1.5 })).toThrow(/positive integer/);
  });

  test('no maxBytes means no ceiling', () => {
    expect(f.bytes().def.maxBytes).toBeUndefined();
    expect(f.bytes({ maxBytes: 10 }).def.maxBytes).toBe(10);
  });
});

describe('toBytes / isBytesInput', () => {
  test('a Uint8Array passes through without copying', () => {
    const u = new Uint8Array([1, 2, 3]);
    expect(toBytes(u)).toBe(u);
  });

  test('a Buffer passes through — it IS a Uint8Array', () => {
    const b = Buffer.from([1, 2, 3]);
    expect(isBytesInput(b)).toBe(true);
    expect(toBytes(b)).toBe(b);
  });

  test('an ArrayBuffer is wrapped', () => {
    const ab = new Uint8Array([7, 8]).buffer;
    expect(Array.from(toBytes(ab))).toEqual([7, 8]);
  });

  test('a view keeps its own window, not the whole buffer', () => {
    // The trap: `new Uint8Array(view.buffer)` would return 8 bytes, not 2 —
    // silently storing a neighbouring field's data alongside this one.
    const whole = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const view = new Uint8Array(whole.buffer, 2, 2);
    expect(Array.from(toBytes(view))).toEqual([2, 3]);
    const dv = new DataView(whole.buffer, 4, 3);
    expect(Array.from(toBytes(dv))).toEqual([4, 5, 6]);
  });

  test('non-binary is not binary', () => {
    for (const v of ['abc', 123, null, undefined, {}, [], new Date()]) {
      expect(isBytesInput(v)).toBe(false);
    }
  });
});

describe('write-path validation', () => {
  test('a base64 string is refused, and the error says how to decode it', () => {
    // The whole reason this field kind exists: callers reach for base64 out of
    // habit. Storing the string would work and quietly cost 33% forever.
    expect(() => bytesForDriver('assets', 'body', undefined, 'aGVsbG8='))
      .toThrow(/is not binary/);
    expect(() => bytesForDriver('assets', 'body', undefined, 'aGVsbG8='))
      .toThrow(/base64/);
  });

  test('the error names the model and the field', () => {
    expect(() => bytesForDriver('assets', 'body', undefined, 42))
      .toThrow(/assets\.body/);
  });

  test('maxBytes is enforced, and reports both sizes', () => {
    const tooBig = new Uint8Array(33);
    expect(() => bytesForStore('assets', 'etag', 32, tooBig))
      .toThrow(/33 bytes, over its declared maxBytes of 32/);
    expect(() => bytesForStore('assets', 'etag', 32, new Uint8Array(32))).not.toThrow();
  });

  test('maxBytes counts BYTES, not elements', () => {
    // A 20-element Int32Array is 80 bytes. Counting elements would let it past
    // a 32-byte ceiling.
    expect(() => bytesForStore('assets', 'etag', 32, new Int32Array(20)))
      .toThrow(/80 bytes/);
  });

  test('a driver parameter is a Buffer, so no driver stringifies the array', () => {
    const out = bytesForDriver('assets', 'body', undefined, new Uint8Array([1, 2, 3]));
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });

  test('the store path does NOT wrap in Buffer — the browser has none', () => {
    const out = bytesForStore('assets', 'body', undefined, new Uint8Array([1, 2, 3]));
    expect(Buffer.isBuffer(out)).toBe(false);
    expect(out).toBeInstanceOf(Uint8Array);
  });
});

describe('read-path normalisation', () => {
  test('a Buffer is left alone', () => {
    const b = Buffer.from([1, 2]);
    expect(fromDriverBytes(b)).toBe(b);
  });

  test("mongodb's Binary wrapper is unwrapped", () => {
    // Shape-matched on `_bsontype`, not instanceof, so a duplicate bson copy
    // in the tree still matches.
    const fake = { _bsontype: 'Binary', buffer: new Uint8Array([9, 9]) };
    const out = fromDriverBytes(fake) as Uint8Array;
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out)).toEqual([9, 9]);
  });

  test("a Binary exposing only .value() is unwrapped too", () => {
    const fake = { _bsontype: 'Binary', value: () => new Uint8Array([4]) };
    expect(Array.from(fromDriverBytes(fake) as Uint8Array)).toEqual([4]);
  });

  test('null and undefined survive', () => {
    expect(fromDriverBytes(null)).toBeNull();
    expect(fromDriverBytes(undefined)).toBeUndefined();
  });
});

describe('migration drift', () => {
  test('bytes is its own category, so it is not compared against json', () => {
    expect(fieldCategory('bytes')).toBe('bytes');
    expect(fieldCategory('json')).toBe('json');
  });

  test("every dialect's binary type maps back to the same category", () => {
    for (const t of [
      'bytea', 'blob', 'tinyblob', 'mediumblob', 'longblob',
      'varbinary(max)', 'varbinary(32)', 'binary(16)',
    ]) {
      expect(dbTypeCategory(t)).toBe('bytes');
    }
  });

  test('a bytes column is no longer uncategorised, so real drift is reported', () => {
    // Before this change fieldCategory('bytes') returned undefined, which the
    // differ reads as "can't tell" — a bytea column swapped to text would not
    // have been flagged.
    expect(fieldCategory('bytes')).not.toBeUndefined();
  });
});

describe('bytes through `update` — the .set collision', () => {
  const Doc = model('docs', { id: f.id(), body: f.bytes(), n: f.int() }) as never as
    import('../schema/types').ModelDef<never>;

  test('a bare Uint8Array is a VALUE, not an operator object', () => {
    // `Uint8Array.prototype.set` exists, so `'set' in v` was true for every
    // bytes value: the IR took the operator branch and stored the `set`
    // METHOD as the column value. The driver then refused to bind a function,
    // so `update({ data: { body: bytes } })` could not work at all.
    const frag = buildUpdateData(Doc, { body: new Uint8Array([1, 2, 3]) });
    expect(frag.set!.body).toBeInstanceOf(Uint8Array);
    expect(typeof frag.set!.body).not.toBe('function');
    expect(Array.from(frag.set!.body as Uint8Array)).toEqual([1, 2, 3]);
  });

  test('a Buffer is a value too', () => {
    const frag = buildUpdateData(Doc, { body: Buffer.from([4, 5]) });
    expect(Array.from(frag.set!.body as Uint8Array)).toEqual([4, 5]);
  });

  test('the explicit operator form still works', () => {
    const frag = buildUpdateData(Doc, { body: { set: new Uint8Array([6]) } });
    expect(Array.from(frag.set!.body as Uint8Array)).toEqual([6]);
  });

  test('a real typo on a bytes column is still caught', () => {
    // `bytes` is in SCALAR_KINDS now, so a stray object is refused rather
    // than written through as the column value.
    expect(() => buildUpdateData(Doc, { body: { nonsense: 1 } as never }))
      .toThrow(/not a valid operator form/);
  });

  test('a numeric op is still refused on a bytes column', () => {
    expect(() => buildUpdateData(Doc, { body: { increment: 1 } as never }))
      .toThrow(/only valid on numeric columns/);
  });

  test('an ArrayBuffer assignment survives as bytes', () => {
    const frag = buildUpdateData(Doc, { body: new Uint8Array([8, 9]).buffer as never });
    expect(frag.set!.body).toBeDefined();
    expect(typeof frag.set!.body).not.toBe('function');
  });
});
