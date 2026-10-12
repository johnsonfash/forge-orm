// An index may carry BOTH a Mongo key spec and an SQL expression.
//
// `expression` is the SQL payload; Mongo has no equivalent, so an index
// carrying only an expression is rightly skipped on Mongo. But some
// indexes need a different SPELLING per dialect and mean exactly the
// same thing in both.
//
// The case that forced this: a compound index over an embedded field.
// Mongo indexes `{ 'customer.id': 1 }` natively. Postgres stores the
// embed as jsonb, so the same index has to be written
// `(("customer"->>'id'))`. Both are "index the customer id on this
// invoice".
//
// Before this change, adding the SQL form SILENTLY DROPPED the index on
// Mongo — push printed nothing, doctor said nothing, and a collection
// that relied on it went back to a full scan with no warning anywhere.
// The only way to keep both dialects was to declare one and remember to
// swap it by hand at a cutover.
//
// Postgres already prefers `expression` over `keys` when both are given
// (adapters/postgres/ddl.ts), so once Mongo stops skipping, the two
// sides agree without either having to know about the other.

import { f, model } from '../schema/core';
import type { ModelDef } from '../schema/types';
import { collectIndexSpecs } from '../adapters/mongo/scripts/push';

const invoices = () =>
  model('pos_invoices', {
    id: f.id(),
    orgId: f.objectId(),
    customer: f.embed({ id: f.string(), name: f.string() }).optional(),
    createdAt: f.dateTime().default('now'),
  }, {
    indexes: [
      {
        // The Mongo form.
        keys: { orgId: 1, 'customer.id': 1, createdAt: -1 },
        // The Postgres form of the same index.
        expression: `"orgId", (("customer"->>'id')), "createdAt" DESC`,
        name: 'idx_invoice_org_customer_created',
      },
      {
        // SQL-only: nothing for Mongo to build from.
        expression: `lower("name")`,
        name: 'idx_invoice_lower_name',
      },
    ],
  }) as unknown as ModelDef<any>;

describe('an index that carries both dialects', () => {
  it('⚠️ IS STILL BUILT ON MONGO, FROM ITS KEYS', () => {
    const spec = collectIndexSpecs('PosInvoice', invoices())
      .find((s) => s.name === 'idx_invoice_org_customer_created');
    expect(spec).toBeDefined();
    expect(spec!.keys).toEqual({ orgId: 1, 'customer.id': 1, createdAt: -1 });
  });

  it('an expression with no keys is still skipped', () => {
    // Unchanged, and it has to stay that way: there is nothing here a
    // Mongo index could be built from.
    const spec = collectIndexSpecs('PosInvoice', invoices())
      .find((s) => s.name === 'idx_invoice_lower_name');
    expect(spec).toBeUndefined();
  });

  it('an empty key object counts as no keys', () => {
    const m = model('things', { id: f.id(), name: f.string() }, {
      indexes: [{ keys: {}, expression: `lower("name")`, name: 'idx_empty' }],
    }) as unknown as ModelDef<any>;
    expect(collectIndexSpecs('Thing', m).find((s) => s.name === 'idx_empty')).toBeUndefined();
  });
});
