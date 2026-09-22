/* eslint-disable no-console */
// IndexedDB execution proof, in-process via fake-indexeddb — no browser, so
// CI runs it unconditionally.
//
// Until now the IDB adapter had NO execution coverage at all. `driver.ts`
// even says "the wrapper exists so tests can inject fake-indexeddb", and
// nothing ever did. That is the same gap `regression-dialect-features.ts`
// closed for the SQL dialects, and it hid the same class of bug: the adapter
// looks up an IDB index BY NAME, so a name that resolves to an index with a
// different key shape returns zero rows rather than failing.
//
// What it pins:
//   • a SINGLE-column `uniques: [['tag']]` is queryable. It was not: ddl.ts
//     gave it `keyPath: ['tag']` — a compound index, whose keys are arrays —
//     while the planner looked it up with the scalar `'tag'`. Every `where`
//     on that column silently returned nothing. Found from Dallio, 2.20.3.
//   • `.unique()` and a two-column `uniques` still behave (they always did;
//     this is the fence around the fix)
//   • an index whose KEY SHAPE changed is rebuilt on open. diffAgainstLive
//     compared index names only, so the broken index above would have
//     survived the fix forever in any database that already had it.
//   • f.bytes() round-trips through structured-clone as real binary

import 'fake-indexeddb/auto';
import { createDb, setActiveSchema } from './src';
import { f, model } from './src/schema/core';

let pass = 0, fail = 0;
const check = (l: string, c: boolean, d = '') => { console.log(`  ${c ? '✓' : '✗'} ${l}${c ? '' : `  << ${d}`}`); c ? pass++ : fail++; };

const bytesOf = (n: number) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 37 + 200) % 256;
  return b;
};

async function main() {
  // ---------------------------------------------------------------
  // 1. The unique-shape bug.
  // ---------------------------------------------------------------
  const OneCol = model('one_col', { id: f.id(), tag: f.string(), n: f.int() }, { uniques: [['tag']] });
  const TwoCol = model('two_col', { id: f.id(), tag: f.string(), other: f.string(), n: f.int() }, { uniques: [['tag', 'other']] });
  const FieldU = model('field_u', { id: f.id(), tag: f.string().unique(), n: f.int() });
  const Plain = model('plain', { id: f.id(), tag: f.string(), n: f.int() });

  const schema = { oneCol: OneCol, twoCol: TwoCol, fieldU: FieldU, plain: Plain } as const;
  setActiveSchema(schema as never);
  const db = await createDb({ url: `idb://reg-${Date.now()}`, schema: schema as never }) as never as Record<string, any>;

  await db.oneCol.create({ data: { id: 'x', tag: 'hello', n: 1 } });
  await db.twoCol.create({ data: { id: 'x', tag: 'hello', other: 'o', n: 1 } });
  await db.fieldU.create({ data: { id: 'x', tag: 'hello', n: 1 } });
  await db.plain.create({ data: { id: 'x', tag: 'hello', n: 1 } });

  // The row is definitely there — read it by primary key first, so a failure
  // below is unambiguously the index and not the write.
  check('single-col uniques: the row was written', !!(await db.oneCol.findFirst({ where: { id: 'x' } })));

  check('single-col uniques: findFirst on the column finds it',
    !!(await db.oneCol.findFirst({ where: { tag: 'hello' } })),
    'returned null — index keyPath is an array while the planner used a scalar');
  check('single-col uniques: findMany on the column finds it',
    (await db.oneCol.findMany({ where: { tag: 'hello' } })).length === 1);
  check('single-col uniques: a non-matching value still finds nothing',
    (await db.oneCol.findMany({ where: { tag: 'nope' } })).length === 0);
  check('single-col uniques: the constraint still bites',
    await db.oneCol.create({ data: { id: 'y', tag: 'hello', n: 2 } }).then(() => false, () => true),
    'a duplicate was accepted — the unique index is gone, not fixed');

  check('two-col uniques: unaffected',
    (await db.twoCol.findMany({ where: { tag: 'hello' } })).length === 1);
  check('.unique(): unaffected',
    (await db.fieldU.findMany({ where: { tag: 'hello' } })).length === 1);
  check('plain column: unaffected',
    (await db.plain.findMany({ where: { tag: 'hello' } })).length === 1);

  // ---------------------------------------------------------------
  // 2. A changed key shape has to be rebuilt, not skipped by name.
  // ---------------------------------------------------------------
  // Plant the OLD broken index by hand under the name the fix now uses, then
  // open the schema over it. A by-name diff sees `_u_tag` on both sides and
  // does nothing, leaving the compound index — and the lookups above would
  // break again for every existing user.
  const dbName = `reg-migrate-${Date.now()}`;
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore('one_col', { keyPath: 'id' });
      store.createIndex('_u_tag', ['tag'], { unique: true }); // the old shape
    };
    req.onsuccess = () => { req.result.close(); resolve(); };
    req.onerror = () => reject(req.error);
  });

  const schema2 = { oneCol: OneCol } as const;
  setActiveSchema(schema2 as never);
  const db2 = await createDb({ url: `idb://${dbName}`, schema: schema2 as never }) as never as Record<string, any>;
  await db2.oneCol.create({ data: { id: 'm', tag: 'migrated', n: 1 } });
  check('a stale index key shape is rebuilt on open',
    (await db2.oneCol.findMany({ where: { tag: 'migrated' } })).length === 1,
    'the old compound index survived — diffAgainstLive is still name-only');

  // ---------------------------------------------------------------
  // 3. Binary, while we are here: it had no execution coverage either.
  // ---------------------------------------------------------------
  const Blob_ = model('blobs', { id: f.id(), body: f.bytes(), cap: f.bytes({ maxBytes: 8 }).optional() });
  const schema3 = { blob: Blob_ } as const;
  setActiveSchema(schema3 as never);
  const db3 = await createDb({ url: `idb://reg-bytes-${Date.now()}`, schema: schema3 as never }) as never as Record<string, any>;

  const body = bytesOf(4096);
  await db3.blob.create({ data: { id: 'b1', body } });
  const got = await db3.blob.findFirst({ where: { id: 'b1' } });
  check('f.bytes(): reads back a Uint8Array', got.body instanceof Uint8Array);
  check('f.bytes(): byte length is unchanged — no base64 tax', got.body.byteLength === body.byteLength);
  check('f.bytes(): byte-for-byte identical',
    Array.from(got.body as Uint8Array).every((v, i) => v === body[i]));
  check('f.bytes(): a non-binary value is refused',
    await db3.blob.create({ data: { id: 'b2', body: 'aGk=' } }).then(() => false, () => true));
  check('f.bytes({ maxBytes }): the ceiling is enforced',
    await db3.blob.create({ data: { id: 'b3', body, cap: bytesOf(9) } }).then(() => false, () => true));

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
