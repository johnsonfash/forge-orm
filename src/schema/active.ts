// The "active" schema registry. forge reads models through whatever schema is
// active, so a consumer can bring their own via `createDb({ schema })` instead of
// the bundled sample. `index.ts` defaults it to the sample on load.
//
// Scope: one active schema per process (last-write-wins). For several genuinely
// independent schemas at once, run them in separate processes/workers — a global
// registry can't represent two simultaneously.

import type { TypedModel } from './core';

// The structural shape every schema map satisfies: model-name → model def.
export type SchemaShape = Record<string, TypedModel<any, any>>;

let _active: SchemaShape | undefined;

export function setActiveSchema(s: SchemaShape): void {
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
