// Inbound / outbound coercion for the IDB adapter.
//
// Inbound: rows going INTO IndexedDB. IDB serializes via structured-clone,
// which handles Date/RegExp/Map/Set/typed arrays natively. We stamp
// create-side defaults (`autoId` via WebCrypto — matches forge 2.5.6's
// browser-safe path — and `now` for date defaults), and preserve `dateTime`
// as a real Date so IDB range queries work (Dates have a stable order in
// the structured-clone key algorithm).
//
// Outbound: identity — structured-clone already handed us the app shape.

import type { ModelDef, FieldDef } from '../../schema/types';

export function coerceInbound(model: ModelDef<any>, row: Record<string, any>, opts: { forCreate?: boolean } = {}): Record<string, any> {
  const out: Record<string, any> = { ...row };
  const fields = model.fields as Record<string, FieldDef>;
  for (const [name, def] of Object.entries(fields)) {
    const cur = out[name];
    if (cur === undefined || cur === null) {
      if (opts.forCreate && def.default) {
        out[name] = materializeDefault(def);
      }
      continue;
    }
    if (def.kind === 'dateTime' && typeof cur === 'string') {
      out[name] = new Date(cur);
    }
    if (def.updatedAt && opts.forCreate && !(name in row)) {
      out[name] = new Date();
    }
  }
  return out;
}

export function decodeOutbound<T>(_model: ModelDef<any>, row: T): T {
  return row;
}

export function stampUpdatedAt(model: ModelDef<any>, patch: Record<string, any>): Record<string, any> {
  const out = { ...patch };
  const fields = model.fields as Record<string, FieldDef>;
  for (const [name, def] of Object.entries(fields)) {
    if (def.updatedAt && !(name in patch)) out[name] = new Date();
  }
  return out;
}

function materializeDefault(def: FieldDef): any {
  if (!def.default) return undefined;
  if (def.default.kind === 'now') return new Date();
  if (def.default.kind === 'autoId') return crypto.randomUUID();
  if (def.default.kind === 'literal') return def.default.value;
  return undefined;
}
