// `$ping` — "is the database answering", asked the same way everywhere.
//
// Every engine can be asked and none of them agree on how: Mongo takes
// `{ ping: 1 }` on the command channel, SQL takes `SELECT 1`. Without a
// portable form, a health endpoint has to know which engine it is
// talking to — the one place an application should not have to, because
// a healthcheck runs before anyone has worked out what is wrong.
//
// It REJECTS rather than returning false, so the caller can time it and
// log the error instead of inspecting a boolean.

import { createDb, f, model } from '../index';

const schema = { Thing: model('things', { id: f.id(), name: f.string() }) };

describe('$ping', () => {
  it('resolves against a live database', async () => {
    const db = await createDb({ url: 'sqlite::memory:', schema });
    await expect(db.$ping()).resolves.toBeUndefined();
    await db.$disconnect();
  });

  it('is reachable on the db surface', async () => {
    const db = await createDb({ url: 'sqlite::memory:', schema });
    expect(typeof db.$ping).toBe('function');
    await db.$disconnect();
  });

  it('rejects once the connection is gone', async () => {
    // What a healthcheck is actually for.
    const db = await createDb({ url: 'sqlite::memory:', schema });
    await db.$disconnect();
    await expect(db.$ping()).rejects.toBeTruthy();
  });
});
