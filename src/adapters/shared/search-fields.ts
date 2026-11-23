import type { WhereTree } from '../../ir/types';

/** The fields a where tree runs a full-text `search` on. */
export function searchedFields(tree: WhereTree | undefined): string[] {
  const out: string[] = [];
  const walk = (t: any) => {
    if (!t) return;
    if (t.kind === 'leaf') { if (t.op === 'search') out.push(t.field); return; }
    if (t.kind === 'and' || t.kind === 'or') for (const c of t.children) walk(c);
    else if (t.kind === 'not') walk(t.child);
  };
  walk(tree);
  return out;
}
