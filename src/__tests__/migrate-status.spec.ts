// `forge migrate status` — and the two states nobody reports.
//
// "Applied" and "pending" are the easy ones. The other two are where
// production goes wrong, and both are cheap to detect and expensive to
// discover any other way — usually as "why is this column missing in
// staging" a fortnight later.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildStatus, formatStatus, listLocalMigrations } from '../scripts/migrate-status';

const at = (n: string, appliedAt = '2026-09-04T10:00:00Z') => ({ name: n, appliedAt });

describe('the easy states', () => {
  it('applied and pending', () => {
    const r = buildStatus(
      ['0001_a.sql', '0002_b.sql'],
      [at('0001_a.sql')],
      '/nowhere',
    );
    expect(r.applied).toBe(1);
    expect(r.pending).toBe(1);
    expect(r.clean).toBe(true);          // nothing is WRONG, just unapplied
    expect(r.rows.map((x) => x.state)).toEqual(['applied', 'pending']);
  });

  it('carries the time a migration ran', () => {
    const r = buildStatus(['0001_a.sql'], [at('0001_a.sql', '2026-01-01T00:00:00Z')], '/nowhere');
    expect(r.rows[0]!.appliedAt).toBe('2026-01-01T00:00:00Z');
  });

  it('an empty folder is not an error', () => {
    const r = buildStatus([], [], '/nowhere');
    expect(r.rows).toEqual([]);
    expect(r.clean).toBe(true);
  });
});

describe('applied but NOT IN THIS CHECKOUT', () => {
  // Somebody ran a branch against this database. The schema in front of
  // you is not the schema it has, so every migration generated from here
  // is built on a state you cannot see.
  const r = () =>
    buildStatus(['0001_a.sql'], [at('0001_a.sql'), at('0002_from_a_branch.sql')], '/nowhere');

  it('is reported, not ignored', () => {
    expect(r().unknown).toBe(1);
    expect(r().rows.find((x) => x.state === 'unknown')!.name).toBe('0002_from_a_branch.sql');
  });

  it('makes the report not clean', () => {
    expect(r().clean).toBe(false);
  });

  it('the message says what it means, not just what it is', () => {
    const text = formatStatus(r(), '/nowhere');
    expect(text).toMatch(/NOT IN THIS CHECKOUT/);
    expect(text).toMatch(/Somebody ran a branch against it/);
    expect(text).toMatch(/built on a state you cannot see/);
  });
});

describe('pending but OUT OF ORDER', () => {
  // Alice generates 0007 on Monday, Bob generates 0008 on Tuesday, Bob's
  // ships first. When Alice's is merged, a migrator walking forward from
  // the highest applied entry skips 0007 in silence and it is never
  // applied at all. Drizzle has this exact failure with journal
  // timestamps; forge would too, and neither says a word.
  const r = () =>
    buildStatus(
      ['0001_a.sql', '0007_alice.sql', '0008_bob.sql'],
      [at('0001_a.sql'), at('0008_bob.sql')],
      '/nowhere',
    );

  it('flags the one that would be skipped', () => {
    expect(r().outOfOrder).toBe(1);
    const row = r().rows.find((x) => x.state === 'out-of-order')!;
    expect(row.name).toBe('0007_alice.sql');
    expect(row.behind).toBe('0008_bob.sql');
  });

  it('makes the report not clean', () => {
    expect(r().clean).toBe(false);
  });

  it('explains the fix, not just the fault', () => {
    const text = formatStatus(r(), '/nowhere');
    expect(text).toMatch(/OUT OF ORDER/);
    expect(text).toMatch(/skips these\s+silently/);
    expect(text).toMatch(/Regenerate them on top of the current state/);
  });

  it('a pending migration AHEAD of everything applied is just pending', () => {
    const ok = buildStatus(
      ['0001_a.sql', '0002_b.sql'],
      [at('0001_a.sql')],
      '/nowhere',
    );
    expect(ok.outOfOrder).toBe(0);
    expect(ok.pending).toBe(1);
  });
});

describe('an unknown migration does not make everything out of order', () => {
  // Found by running the command for real rather than by unit test.
  // 0006 was applied from a branch and is not in this checkout. It must
  // NOT set the high-water mark: doing so flags every ordinary pending
  // migration as out-of-order, and the guidance attached to that state
  // ("regenerate on top of the current state") does not address the
  // actual cause. A check that fires on innocent files gets scrolled
  // past, and then it protects nothing.
  const r = () =>
    buildStatus(
      ['0001_a.sql', '0005_pending.sql'],
      [at('0001_a.sql'), at('0006_from_a_branch.sql')],
      '/nowhere',
    );

  it('the pending one is pending, not out of order', () => {
    expect(r().outOfOrder).toBe(0);
    expect(r().pending).toBe(1);
    expect(r().rows.find((x) => x.name === '0005_pending.sql')!.state).toBe('pending');
  });

  it('but the risk is still stated — under the unknown migration, where it belongs', () => {
    const text = formatStatus(r(), '/nowhere');
    expect(text).toMatch(/NOT IN THIS CHECKOUT/);
    expect(text).toMatch(/blocks the 1 pending migration/);
    expect(text).toMatch(/step over anything\s+numbered below it/);
    expect(text).not.toMatch(/OUT OF ORDER/);
  });

  it('a genuine out-of-order is still caught alongside an unknown one', () => {
    const mixed = buildStatus(
      ['0001_a.sql', '0003_alice.sql', '0004_bob.sql'],
      [at('0001_a.sql'), at('0004_bob.sql'), at('0009_branch.sql')],
      '/nowhere',
    );
    expect(mixed.outOfOrder).toBe(1);   // 0003, behind 0004 — both are HERE
    expect(mixed.rows.find((x) => x.state === 'out-of-order')!.behind).toBe('0004_bob.sql');
    expect(mixed.unknown).toBe(1);
  });

  it('the pending count is singular/plural correct', () => {
    const two = buildStatus(
      ['0005_a.sql', '0006_b.sql'],
      [at('0009_branch.sql')],
      '/nowhere',
    );
    expect(formatStatus(two, '/nowhere')).toMatch(/blocks the 2 pending migrations/);
  });
});

describe('both at once', () => {
  it('counts each separately', () => {
    const r = buildStatus(
      ['0001_a.sql', '0007_alice.sql', '0009_someone.sql'],
      [at('0001_a.sql'), at('0008_bob.sql'), at('0009_someone.sql')],
      '/nowhere',
    );
    expect(r.applied).toBe(2);
    expect(r.outOfOrder).toBe(1);   // 0007, behind 0009 — which IS in this checkout
    expect(r.unknown).toBe(1);      // 0008 is not
    expect(r.clean).toBe(false);
  });
});

describe('reading the folder', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-status-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('lists .sql files in apply order and ignores everything else', () => {
    fs.writeFileSync(path.join(dir, '0002_b.sql'), '');
    fs.writeFileSync(path.join(dir, '0001_a.sql'), '');
    fs.writeFileSync(path.join(dir, 'README.md'), '');
    fs.mkdirSync(path.join(dir, 'meta'));
    expect(listLocalMigrations(dir)).toEqual(['0001_a.sql', '0002_b.sql']);
  });

  it('a missing folder is empty, not a crash', () => {
    expect(listLocalMigrations(path.join(dir, 'nope'))).toEqual([]);
  });
});
