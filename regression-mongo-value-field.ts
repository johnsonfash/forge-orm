/* eslint-disable no-console */
//
// Regression — findOneAndUpdate result unwrap (fixed in 1.5.1).
//
// The mongo driver v6/v7 returns the bare document from findOneAndUpdate (v5
// returned a `{ value, ok }` envelope). forge's old unwrap guessed the shape
// via `raw.value`, which collided with any document field literally named
// `value` — turning a successful update into a false not-found (P2025) when
// that field was falsy, or returning the field instead of the document when it
// was truthy. No model in the sample schema has a `value` field, so the unit
// + integration suites never exercised it; promo-style models do. The fix
// forces `includeResultMetadata: true` for a deterministic envelope.
//
// Run: SMOKE_MONGO_URL=mongodb://… ts-node regression-mongo-value-field.ts

import { createDb, col } from './src';
import { f, model } from './src/schema/core';
import { setActiveSchema } from './src/schema/active';

// Model WITH a `value` field — the exact trigger for the unwrap bug.
const Promo = model('fixproof_promos', {
  id: f.id(),
  code: f.string(),
  value: f.int().default(0),          // <-- collides with old `.value` unwrap
  currentUsage: f.int().default(0),
  globalLimit: f.int().default(0),
});
const schema = { promo: Promo } as const;

let pass = 0, fail = 0;
const check = (l: string, c: boolean, d = '') => { console.log(`  ${c ? '✓' : '✗'} ${l}${c ? '' : `  << ${d}`}`); c ? pass++ : fail++; };

async function main() {
  setActiveSchema(schema as any);
  const url = process.env.SMOKE_MONGO_URL ?? 'mongodb://127.0.0.1:27017/forge_fixproof';
  const db = await createDb({ url, schema: schema as any });
  await db.promo.deleteMany({});

  // value:0 (falsy) — the worst case for the old unwrap
  await db.promo.create({ data: { id: 'p1', code: 'A', value: 0, currentUsage: 0, globalLimit: 3 } });

  const updated = await db.promo.update({
    where: { id: 'p1', currentUsage: { lt: col('globalLimit') } },
    data: { currentUsage: { increment: 1 } },
  });
  check('update returns the full document (not value:0)', !!updated && updated.id === 'p1' && updated.code === 'A', JSON.stringify(updated));
  check('returned doc has currentUsage = 1', updated?.currentUsage === 1, JSON.stringify(updated));
  check('returned doc still carries value = 0', updated?.value === 0, JSON.stringify(updated));

  // truthy value too
  await db.promo.create({ data: { id: 'p2', code: 'B', value: 500, currentUsage: 0, globalLimit: 3 } });
  const u2 = await db.promo.update({ where: { id: 'p2' }, data: { value: { increment: 100 } } });
  check('update on value field returns doc (value 500→600)', u2?.value === 600 && u2.id === 'p2', JSON.stringify(u2));

  // genuine not-found still throws P2025
  let threw = '';
  try { await db.promo.update({ where: { id: 'nope' }, data: { value: { increment: 1 } } }); }
  catch (e: any) { threw = e?.code; }
  check('genuine no-match still throws P2025', threw === 'P2025', `code=${threw}`);

  await db.promo.deleteMany({});
  await db.$disconnect?.();
  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
