import {
  DatabaseClient,
  dbClient,
  getDefaultClient,
  hasDefaultClient,
  setDefaultClient,
  clearDefaultClient,
} from '../adapters/mongo/client';

// `dbClient` used to be the only Mongo client there was: one per process,
// reached for directly by every Mongo code path. `connect()` early-returns
// when it already holds a db, and it read `process.env.DATABASE_URL` rather
// than the URL it was given — so a second `createDb({ url: B })` silently kept
// writing to A, and `$disconnect()` on either closed the connection under
// both. No error, no log line.

/** Enough of a MongoClient for adopt(): connect() + db(name). */
function fakeClient(label: string) {
  const dbs: string[] = [];
  return {
    connected: false,
    dbs,
    async connect() { this.connected = true; },
    db(name?: string) { const n = name ?? `default_${label}`; dbs.push(n); return { databaseName: n } as never; },
    async close() { this.connected = false; },
  };
}

describe('one client per createDb', () => {
  test('two clients hold two different databases', async () => {
    const a = new DatabaseClient();
    const b = new DatabaseClient();
    await a.adopt(fakeClient('a'), 'db_a');
    await b.adopt(fakeClient('b'), 'db_b');
    expect(a.db.databaseName).toBe('db_a');
    expect(b.db.databaseName).toBe('db_b');
  });

  test('closing one leaves the other usable', async () => {
    const a = new DatabaseClient();
    const b = new DatabaseClient();
    await a.adopt(fakeClient('a'), 'db_a');
    await b.adopt(fakeClient('b'), 'db_b');
    await a.close();
    expect(() => a.db).toThrow(/before connect/);
    expect(b.db.databaseName).toBe('db_b');
  });

  test('a fresh client is not connected just because another one is', async () => {
    const a = new DatabaseClient();
    await a.adopt(fakeClient('a'), 'db_a');
    expect(() => new DatabaseClient().db).toThrow(/before connect/);
  });

  test('adopt is idempotent — a second adopt does not swap the database out', async () => {
    const a = new DatabaseClient();
    await a.adopt(fakeClient('a'), 'db_a');
    await a.adopt(fakeClient('other'), 'db_other');
    expect(a.db.databaseName).toBe('db_a');
  });
});

describe('close() only closes what it opened', () => {
  test('an adopted client is released, not closed', async () => {
    // The database-per-tenant shape is an LRU of createDb handles over ONE
    // shared MongoClient, disposed with `db.$disconnect()`. Closing the
    // adopted client there would take every other tenant down with the first
    // eviction.
    const shared = fakeClient('shared');
    const a = new DatabaseClient();
    await a.adopt(shared, 'tenant_a');
    await a.close();
    expect(shared.connected).toBe(true);
    expect(() => a.db).toThrow(/before connect/);
  });

  test('two handles over one shared client are independent', async () => {
    const shared = fakeClient('shared');
    const a = new DatabaseClient();
    const b = new DatabaseClient();
    await a.adopt(shared, 'tenant_a');
    await b.adopt(shared, 'tenant_b');
    await a.close();
    expect(shared.connected).toBe(true);
    expect(b.db.databaseName).toBe('tenant_b');
  });

  test('re-adopting after a close works', async () => {
    const shared = fakeClient('shared');
    const a = new DatabaseClient();
    await a.adopt(shared, 'tenant_a');
    await a.close();
    await a.adopt(shared, 'tenant_c');
    expect(a.db.databaseName).toBe('tenant_c');
  });
});

describe('the exported dbClient stays usable for a single-database app', () => {
  test('it forwards to the first client registered', async () => {
    const first = new DatabaseClient();
    setDefaultClient(first);
    await first.adopt(fakeClient('first'), 'db_first');
    expect(dbClient.db.databaseName).toBe('db_first');
    clearDefaultClient(first);
  });

  test('a second registration does not steal the default', async () => {
    const first = new DatabaseClient();
    const second = new DatabaseClient();
    setDefaultClient(first);
    setDefaultClient(second);
    await first.adopt(fakeClient('first'), 'db_first');
    await second.adopt(fakeClient('second'), 'db_second');
    // The default is whoever got there first; the second owns its own.
    expect(dbClient.db.databaseName).toBe('db_first');
    expect(second.db.databaseName).toBe('db_second');
    clearDefaultClient(first);
  });

  test('methods called through the proxy keep their receiver', async () => {
    // A naive forwarding proxy hands back an unbound function, so `this`
    // inside connect()/adopt() would be the proxy rather than the client.
    const c = getDefaultClient();
    await dbClient.adopt(fakeClient('viaproxy'), 'db_proxy');
    expect(c.db.databaseName).toBe('db_proxy');
    clearDefaultClient(c);
  });

  test('there is no default until one is registered or asked for', () => {
    // hasDefaultClient must not CREATE one — that is what lets the adapter
    // decide whether it is the first.
    const c = getDefaultClient();
    clearDefaultClient(c);
    expect(hasDefaultClient()).toBe(false);
    expect(getDefaultClient()).toBeInstanceOf(DatabaseClient);
    expect(hasDefaultClient()).toBe(true);
    clearDefaultClient(getDefaultClient());
  });
});
