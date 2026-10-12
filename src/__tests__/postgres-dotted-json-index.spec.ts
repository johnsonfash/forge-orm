// A dotted index key over a json/embed column.
//
// `{ 'customer.id': 1 }` is how Mongo indexes inside an embedded
// document, and it is the natural way to write it — the schema already
// says `customer` is an `f.embed()`. Postgres stores that embed as
// jsonb, so the same key needs `(("customer"->>'id'))`.
//
// Quoting the key as an identifier emitted the column `"customer.id"`,
// which does not exist. That single index was the last statement in a
// real 277-model schema that would not push to Postgres.
//
// `expression` was not an escape: it is wrapped as ONE expression
// (`ON t ((<expr>))`), so a MIXED index — two plain columns and a path
// — comes out as a row constructor and PG answers "syntax error at or
// near ','".
//
// So the translation happens here, from information forge already has.

import { f, model } from '../schema/core';
import type { ModelDef } from '../schema/types';
import { buildSchemaDDL } from '../adapters/postgres/ddl';

const invoices = () =>
  model('pos_invoices', {
    id: f.id(),
    orgId: f.objectId(),
    customer: f.embed({ id: f.string(), name: f.string() }).optional(),
    meta: f.json<{ a: { b: string } }>().optional(),
    createdAt: f.dateTime().default('now'),
  }, {
    indexes: [
      {
        keys: { orgId: 1, 'customer.id': 1, createdAt: -1 },
        name: 'idx_invoice_org_customer_created',
      },
      { keys: { 'meta.a.b': 1 }, name: 'idx_invoice_meta_deep' },
    ],
  }) as unknown as ModelDef<any>;

const ddlFor = (m: ModelDef<any>) =>
  buildSchemaDDL({ PosInvoice: m } as any).filter((s) => s.kind === 'index');
const sqlFor = (name: string) =>
  ddlFor(invoices()).find((s) => s.name === name)?.sql ?? '';

describe('a dotted index key over a json column', () => {
  it('⚠️ BECOMES A PATH EXPRESSION, NOT A COLUMN NAME', () => {
    const sql = sqlFor('idx_invoice_org_customer_created');
    expect(sql).toContain(`("customer"->>'id')`);
    // The thing that was emitted before, and could never work.
    expect(sql).not.toContain('"customer.id"');
  });

  it('keeps the plain columns and their directions alongside it', () => {
    // The whole point: a MIXED index. `expression` cannot express this.
    const sql = sqlFor('idx_invoice_org_customer_created');
    expect(sql).toContain('"orgId" ASC');
    expect(sql).toContain('"createdAt" DESC');
  });

  it('walks a deep path with -> and finishes with ->>', () => {
    // `->>` on the last hop so the index is over text, not jsonb.
    expect(sqlFor('idx_invoice_meta_deep')).toContain(`("meta"->'a'->>'b')`);
  });

  it('leaves a dotted key with a non-json root alone', () => {
    /*
     * That is a typo, not a path. Inventing a translation would build
     * an index on a key nobody meant and hide the mistake; letting it
     * fail at the database is the loud answer.
     */
    const m = model('things', { id: f.id(), name: f.string() }, {
      indexes: [{ keys: { 'name.oops': 1 }, name: 'idx_typo' }],
    }) as unknown as ModelDef<any>;
    const sql = ddlFor(m).find((s) => s.name === 'idx_typo')?.sql ?? '';
    expect(sql).toContain('"name.oops"');
  });
});
