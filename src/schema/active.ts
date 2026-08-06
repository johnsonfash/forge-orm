// The "active" schema registry. forge reads models through whatever schema is
// active, so a consumer can bring their own via `createDb({ schema })` instead of
// the bundled sample. `index.ts` defaults it to the sample on load.
//
// Scope: one active schema per process (last-write-wins). Since 2.6.5 this only
// governs the module-level `schema` proxy and the CLI scripts that read it — a
// db handle binds whatever map its own `createDb({ schema })` received, so
// opening a second db no longer strands the models of the first.

import type { TypedModel } from './core';

// The structural shape every schema map satisfies: model-name → model def.
export type SchemaShape = Record<string, TypedModel<any, any>>;

let _active: SchemaShape | undefined;
let _consumerSet = false;

export function setActiveSchema(s: SchemaShape): void {
  _active = s;
  _consumerSet = true;
}

// The bundled sample installs itself through this, never through
// `setActiveSchema`. Under Node's CJS the schema module always evaluates before
// `createDb` runs, so an unconditional set was harmless; under a bundler that
// defers module initialisation (esbuild wraps CJS in a lazy `__commonJS` whose
// body only runs on first property access) the sample can land AFTER the
// consumer's `createDb({ schema })` and silently replace it — every model
// accessor then resolves to `undefined`. Defaulting instead of overwriting makes
// the outcome independent of evaluation order.
export function setDefaultSchema(s: SchemaShape): void {
  if (_consumerSet) return;
  _active = s;
}

export function getActiveSchema(): SchemaShape {
  if (!_active) {
    throw new Error(
      '[forge] no active schema set. Import forge\'s schema module, or call ' +
      'createDb({ schema }) with your model map before querying.',
    );
  }
  return _active;
}
