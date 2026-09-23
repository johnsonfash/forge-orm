/* eslint-disable no-console */
//
// f.bytes() through the REAL DuckDB driver.
//
// DuckDB's copy of the bytes bug was fixed by inspection, not execution:
// `src/adapters/duckdb/driver.ts` JSON-stringified a Uint8Array because the
// param coercion fell through to its object branch, so a file was stored as
// the text "{"0":137,"1":80,...}". Postgres and MySQL got execution proof in
// regression-dialect-features.ts; DuckDB had none, because its driver was
// not installed on the machine that wrote the fix.
//
// It is installed now, so this is the missing proof. Deliberately narrow —
// the full dialect-features suite only speaks pg and mysql, and teaching it
// DuckDB is a bigger job than verifying the one fix that was never run.

import { f, model, createDb } from './src';
import { duckdbDriver } from './src/adapters/duckdb/driver';
import { DuckDBInstance } from '@duckdb/node-api';
import { buildSchemaDDL } from './src/adapters/duckdb/ddl';

const Asset = model('assets', {
  id: f.id(),
  name: f.string(),
  body: f.bytes(),
  thumb: f.bytes().optional(),
  etag: f.bytes({ maxBytes: 8 }).optional(),
});
const schema = { asset: Asset } as const;

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail?: unknown) => {
  if (cond) { console.log('  ✓', label); pass++; }
  else { console.log('  ✗', label, detail ?? ''); fail++; }
};

/** Bytes that are not valid UTF-8, so any text round-trip corrupts them. */
function awkward(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 37 + 137) % 256;
  return b;
}
const same = (a: Uint8Array, b: Uint8Array) =>
  a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);

async function main() {
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  const db = await createDb({
    schema: schema as never,
    driver: duckdbDriver(conn) as never,
  }) as never as Record<string, any>;

  for (const st of buildSchemaDDL(schema as never)) {
    await conn.run(st.sql).catch(() => undefined);
  }

  const body = awkward(4096);
  await db.asset.create({ data: { id: 'a1', name: 'file.bin', body } });
  const row = await db.asset.findFirst({ where: { id: 'a1' } });

  ok('reads back as binary, not a string', row.body instanceof Uint8Array || Buffer.isBuffer(row.body),
    `got ${row.body?.constructor?.name}`);
  const got = row.body instanceof Uint8Array ? row.body : new Uint8Array(row.body);
  ok('byte length unchanged — no JSON/base64 tax', got.byteLength === body.byteLength,
    `${got.byteLength} vs ${body.byteLength}`);
  ok('byte-for-byte identical', same(got, body));

  // The exact shape of the old bug: the stored value must not be the text
  // of a JSON object.
  const raw = await conn.runAndReadAll('SELECT typeof(body) AS t FROM assets WHERE id = \'a1\'');
  const t = String(raw.getRowObjects()[0]?.t ?? '');
  ok('stored column type is a blob, not text', /blob/i.test(t), `typeof = ${t}`);

  // Optional column stays absent rather than becoming "null" text.
  ok('an omitted optional bytes column is null', (row.thumb ?? null) === null);

  const thumb = awkward(64);
  await db.asset.create({ data: { id: 'a2', name: 'two.bin', body: awkward(16), thumb } });
  const two = await db.asset.findFirst({ where: { id: 'a2' } });
  const gotThumb = two.thumb instanceof Uint8Array ? two.thumb : new Uint8Array(two.thumb);
  ok('a second bytes column round-trips too', same(gotThumb, thumb));

  ok('a non-binary value is refused',
    await db.asset.create({ data: { id: 'a3', name: 'bad', body: 'aGk=' } }).then(() => false, () => true));

  ok('maxBytes is enforced',
    await db.asset.create({ data: { id: 'a4', name: 'big', body: awkward(4), etag: awkward(9) } })
      .then(() => false, () => true));

  ok('exactly maxBytes is accepted',
    await db.asset.create({ data: { id: 'a5', name: 'edge', body: awkward(4), etag: awkward(8) } })
      .then(() => true, () => false));

  // A blob big enough to prove nothing is being chunked through a string.
  const big = awkward(1024 * 1024);
  await db.asset.create({ data: { id: 'a6', name: 'mb.bin', body: big } });
  const back = await db.asset.findFirst({ where: { id: 'a6' } });
  const gotBig = back.body instanceof Uint8Array ? back.body : new Uint8Array(back.body);
  ok('a megabyte survives intact', gotBig.byteLength === big.byteLength
    && gotBig[0] === big[0]
    && gotBig[big.length >> 1] === big[big.length >> 1]
    && gotBig[big.length - 1] === big[big.length - 1]);

  console.log(`\n[duckdb-bytes] ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
