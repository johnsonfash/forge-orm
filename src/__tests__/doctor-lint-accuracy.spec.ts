// Two doctor rules that were wrong in opposite directions.
//
// It warned that working indexes were "ignored at push" — including
// UNIQUE ones — because it treated a string `where` as proof the index
// was SQL-only. A PORTABLE index deliberately carries both dialects:
// `partialFilterExpression` for Mongo and a `where` string for SQL. The
// Mongo push reads the former and ignores the latter, exactly as
// intended, so the index is created correctly every time. Verified by
// dropping such an index and re-running push: it came back with
// `unique: true` and its filter intact. Anyone acting on the old warning
// would have removed a working duplicate guard.
//
// And it said nothing at all about the failure that actually costs
// money: a model whose every read is filtered by a field nothing
// indexes. See `scopeBy`.

import { f, model } from '../schema/core';
import type { ModelDef } from '../schema/types';
import { __lintForTests } from '../scripts/doctor';

const lint = (name: string, m: unknown, adapter: 'mongo' | 'postgres' = 'mongo') =>
  __lintForTests(name, m as ModelDef<any>, adapter).map((f) => f.message);

describe('doctor: portable indexes are not "ignored at push"', () => {
  it('says nothing when a Mongo filter sits beside its SQL twin', () => {
    const m = model('credit_ledger_entries', {
      id: f.id(),
      orgId: f.objectId(),
      idempotencyKey: f.string().optional(),
    }, {
      indexes: [{
        keys: { orgId: 1, idempotencyKey: 1 },
        unique: true,
        name: 'idx_creditledger_idem',
        partialFilterExpression: { idempotencyKey: { $type: 'string' } },
        where: '"idempotencyKey" IS NOT NULL',
      }],
    });
    expect(lint('CreditLedgerEntry', m).join(' ')).not.toMatch(/ignored at push/);
  });

  it('DOES warn when a SQL predicate has no Mongo equivalent', () => {
    // Here the filter genuinely will not survive: the index gets created
    // without it, which silently widens a unique constraint.
    const m = model('t', {
      id: f.id(),
      a: f.string(),
    }, {
      indexes: [{ keys: { a: 1 }, name: 'idx_t_a', where: '"a" IS NOT NULL' }],
    });
    expect(lint('T', m).join(' ')).toMatch(/no partialFilterExpression/);
  });

  it('still warns about fields Mongo really cannot use', () => {
    const m = model('t', {
      id: f.id(),
      a: f.string(),
      b: f.string(),
    }, {
      indexes: [{ keys: { a: 1 }, name: 'idx_t_a', include: ['b'] }],
    });
    expect(lint('T', m).join(' ')).toMatch(/ignored at push/);
  });
});

describe('doctor: scopeBy without an index', () => {
  const scoped = (indexes: any[] = [], uniques: string[][] = []) =>
    model('appointments', {
      id: f.id(),
      orgId: f.objectId(),
      startsAt: f.dateTime(),
      createdAt: f.dateTime().default('now'),
    }, { scopeBy: 'orgId', indexes, uniques });

  it('warns when nothing indexes the scope field', () => {
    expect(lint('Appointment', scoped()).join(' ')).toMatch(
      /every read is filtered by 'orgId'/,
    );
  });

  it('is satisfied by an index that STARTS with the scope field', () => {
    const m = scoped([{ keys: { orgId: 1, createdAt: -1 }, name: 'idx_appt_org' }]);
    expect(lint('Appointment', m).join(' ')).not.toMatch(/every read is filtered/);
  });

  it('is NOT satisfied by the scope field buried in second place', () => {
    // Mongo reads a compound index from the left, so { startsAt, orgId }
    // does nothing for a filter on orgId alone.
    const m = scoped([{ keys: { startsAt: 1, orgId: 1 }, name: 'idx_appt_start' }]);
    expect(lint('Appointment', m).join(' ')).toMatch(/every read is filtered/);
  });

  it('accepts a MORE selective foreign key instead', () => {
    // A thread id already implies its tenant. Indexing the tenant instead
    // would be the worse index, so the rule is "can this seek", not
    // "is orgId literally first".
    const m = model('chat_messages', {
      id: f.id(),
      orgId: f.objectId(),
      threadId: f.objectId(),
    }, {
      scopeBy: 'orgId',
      indexes: [{ keys: { threadId: 1, id: -1 }, name: 'idx_msg_thread' }],
    });
    expect(lint('ChatMessage', m).join(' ')).not.toMatch(/every read is filtered/);
  });

  it('is satisfied by a composite unique that starts with the scope field', () => {
    const m = scoped([], [['orgId', 'startsAt']]);
    expect(lint('Appointment', m).join(' ')).not.toMatch(/every read is filtered/);
  });

  it('catches a scopeBy naming a field the model does not have', () => {
    const m = model('t', { id: f.id(), a: f.string() }, { scopeBy: 'orgId' });
    expect(lint('T', m).join(' ')).toMatch(/names a field this model does not have/);
  });

  it('says nothing at all when the model declares no scope', () => {
    const m = model('t', { id: f.id(), a: f.string() });
    expect(lint('T', m)).toEqual([]);
  });
});
