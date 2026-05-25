import { f, model, rel } from '../schema/core';
import { ModelDef } from '../schema/types';
import { planSelection, pruneRowToSelect } from '../adapters/mongo/translate/select-include';

const M = model('m', {
  id: f.id(),
  title: f.string(),
  view_count: f.int().default(0),
}).relate(() => ({
  creator: rel.one('user', { on: 'creator_id', refs: 'id' }),
  comments: rel.many('comment', { on: 'video_id', refs: 'id' }),
})) as unknown as ModelDef<any>;

describe('planSelection', () => {
  test('include with boolean toggles, no select → no projection, full scalars', () => {
    const plan = planSelection(M, { include: { creator: true, comments: true } });
    expect(plan.isSelect).toBe(false);
    expect(plan.projection).toBeUndefined();
    expect(Object.keys(plan.relations)).toEqual(['creator', 'comments']);
  });

  test('include with nested args carries them through', () => {
    const plan = planSelection(M, {
      include: { comments: { take: 5, where: { active: true } } },
    });
    expect(plan.relations.comments.take).toBe(5);
    expect(plan.relations.comments.where).toEqual({ active: true });
  });

  test('select only — projection includes _id and listed scalars', () => {
    const plan = planSelection(M, { select: { id: true, title: true } });
    expect(plan.isSelect).toBe(true);
    expect(plan.projection).toEqual({ _id: 1, title: 1 });
  });

  test('select with relations — relations not in projection, walked separately', () => {
    const plan = planSelection(M, {
      select: { id: true, creator: { select: { id: true } } },
    });
    expect(plan.isSelect).toBe(true);
    expect(plan.projection).toEqual({ _id: 1 });
    expect(plan.relations.creator).toBeDefined();
  });

  test('_count in include populates counts list, not relations', () => {
    const plan = planSelection(M, {
      include: { _count: { select: { comments: true } } },
    });
    expect(plan.counts).toEqual(['comments']);
  });

  test('mixing select and include throws', () => {
    expect(() => planSelection(M, { select: { id: true }, include: { creator: true } }))
      .toThrow(/cannot use `select` and `include`/);
  });

  test('false-valued select keys are ignored', () => {
    const plan = planSelection(M, { select: { id: true, title: false as any } });
    expect(plan.projection).toEqual({ _id: 1 });
  });
});

describe('pruneRowToSelect', () => {
  test('keeps only listed keys', () => {
    const out = pruneRowToSelect(
      { id: '1', title: 't', view_count: 5, creator: { id: 'c' } },
      { id: true, creator: true },
    );
    expect(out).toEqual({ id: '1', creator: { id: 'c' } });
  });

  test('drops missing keys gracefully', () => {
    const out = pruneRowToSelect({ id: '1' }, { id: true, missing: true });
    expect(out).toEqual({ id: '1' });
  });

  test('null select returns row unchanged', () => {
    const row = { id: '1', title: 't' };
    expect(pruneRowToSelect(row, undefined)).toBe(row);
  });
});
