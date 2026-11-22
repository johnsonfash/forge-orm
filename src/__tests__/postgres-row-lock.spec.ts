import { f, model } from '../schema/core';
import type { ModelDef } from '../schema/types';
import { buildSelect, normaliseLock } from '../ir/build';
import { compileSelect } from '../adapters/postgres/compile-from-ir';
import { compileSelect as sqliteSelect } from '../adapters/sqlite/compile-from-ir';
import { compileSelect as mysqlSelect } from '../adapters/mysql/compile-from-ir';

const Job: ModelDef<any> = model('jobs', {
  id: f.id(),
  status: f.string(),
  run_at: f.dateTime(),
});

const sel = (args: any, card: 'one' | 'many' = 'many') =>
  compileSelect(buildSelect('job', Job, args, card), Job).sql;

describe('row locks — postgres SELECT', () => {
  it.each([
    ['update', 'FOR UPDATE'],
    ['noKeyUpdate', 'FOR NO KEY UPDATE'],
    ['share', 'FOR SHARE'],
    ['keyShare', 'FOR KEY SHARE'],
  ])('lock: %s → %s, as the last clause', (mode, clause) => {
    const sql = sel({ where: { status: 'queued' }, take: 5, lock: mode });
    expect(sql.endsWith(` LIMIT 5 ${clause}`)).toBe(true);
  });

  it('SKIP LOCKED and NOWAIT', () => {
    expect(sel({ orderBy: { run_at: 'asc' }, take: 10, lock: { mode: 'update', skipLocked: true } }))
      .toMatch(/ORDER BY .* LIMIT 10 FOR UPDATE SKIP LOCKED$/);
    expect(sel({ where: { id: 'a' }, lock: { mode: 'share', nowait: true } }, 'one'))
      .toMatch(/FOR SHARE NOWAIT$/);
  });

  it('no lock, no clause', () => {
    expect(sel({ where: { status: 'queued' } })).not.toMatch(/FOR /);
  });

  it('refuses a mode it does not know, and nowait with skipLocked', () => {
    expect(() => normaliseLock('exclusive' as any)).toThrow(/not a lock mode/);
    expect(() => normaliseLock({ mode: 'update', nowait: true, skipLocked: true })).toThrow(/cannot both/);
  });

  it('dialects that borrow the compiler refuse it rather than emit postgres SQL', () => {
    const node = buildSelect('job', Job, { lock: 'update' }, 'many');
    expect(() => sqliteSelect(node, Job)).toThrow(/postgres only/);
    expect(() => mysqlSelect(node, Job)).toThrow(/postgres only/);
  });
});
