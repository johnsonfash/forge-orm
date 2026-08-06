// Regression for 2.6.5. Two `createDb({ schema })` calls in one process used to
// fight over a single global registry: the second call moved the pointer and
// every model on the first handle resolved to `undefined`. A db now binds the
// map it was created with.

import { createDb } from '../factory';
import { f, model } from '../schema/core';
import type { SqliteDriver } from '../adapters/sqlite/driver';

const Widget = model('widget', { id: f.id(), name: f.string() });
const Gadget = model('gadget', { id: f.id(), size: f.int() });

const appSchema = { widget: Widget } as any;
const syncSchema = { gadget: Gadget } as any;

// Minimal in-memory driver port — these tests only exercise model resolution on
// the proxy, so the executor never has to return real rows.
function fakeDriver(): SqliteDriver {
  return {
    kind: 'sqlite',
    all: async () => [],
    get: async () => undefined,
    run: async () => ({ changes: 0 }),
    exec: async () => {},
    close: async () => {},
  };
}

describe('two dbs with different schemas', () => {
  it('each handle keeps its own models after the other opens', async () => {
    const app = await createDb({ schema: appSchema, driver: fakeDriver() });
    const sync = await createDb({ schema: syncSchema, driver: fakeDriver() });

    expect((app as any).widget).toBeDefined();
    expect((sync as any).gadget).toBeDefined();
  });

  it('opening the second db does not strand the first', async () => {
    const app = await createDb({ schema: appSchema, driver: fakeDriver() });
    const widgetBefore = (app as any).widget;
    await createDb({ schema: syncSchema, driver: fakeDriver() });

    expect((app as any).widget).toBe(widgetBefore);
  });

  it('a model from the other schema is rejected by name', async () => {
    const app = await createDb({ schema: appSchema, driver: fakeDriver() });
    await createDb({ schema: syncSchema, driver: fakeDriver() });

    expect(() => (app as any).gadget).toThrow(/unknown model "gadget"/);
    expect(() => (app as any).gadget).toThrow(/exposes: widget/);
  });
});
