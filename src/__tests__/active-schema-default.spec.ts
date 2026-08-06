// Regression for 2.6.5. `schema/index.ts` installs the bundled sample at module
// load. Under Node's CJS that always happens before `createDb` runs, but bundlers
// that defer CJS initialisation (esbuild's lazy `__commonJS` wrapper) can run it
// AFTER the consumer's `createDb({ schema })` — the unconditional set then wiped
// their models and every `db.<model>` resolved to `undefined`.

// The registry is structural — it only ever stores and hands back the map, so
// stand-in model objects are enough to pin the ordering rules.
const consumerSchema = { widget: {} } as any;
const sampleish = { post: {} } as any;

function freshRegistry() {
  jest.resetModules();
  return require('../schema/active') as typeof import('../schema/active');
}

describe('active schema registry', () => {
  it('defaults when nothing is active', () => {
    const reg = freshRegistry();
    reg.setDefaultSchema(sampleish);
    expect(Object.keys(reg.getActiveSchema())).toEqual(['post']);
  });

  it('a consumer schema wins over a default installed afterwards', () => {
    const reg = freshRegistry();
    reg.setActiveSchema(consumerSchema);
    reg.setDefaultSchema(sampleish);
    expect(Object.keys(reg.getActiveSchema())).toEqual(['widget']);
  });

  it('a consumer schema wins over a default installed beforehand', () => {
    const reg = freshRegistry();
    reg.setDefaultSchema(sampleish);
    reg.setActiveSchema(consumerSchema);
    expect(Object.keys(reg.getActiveSchema())).toEqual(['widget']);
  });

  it('repeated defaults never displace the consumer schema', () => {
    const reg = freshRegistry();
    reg.setActiveSchema(consumerSchema);
    reg.setDefaultSchema(sampleish);
    reg.setDefaultSchema(sampleish);
    expect(reg.getActiveSchema()).toBe(consumerSchema);
  });

  it('throws with guidance when nothing has been installed', () => {
    const reg = freshRegistry();
    expect(() => reg.getActiveSchema()).toThrow(/no active schema set/);
  });
});
