// The four states a migration can be in, and the two nobody reports.
//
// "Applied" and "pending" are the easy ones, and every migration tool
// shows them. The other two are where production goes wrong:
//
//   UNKNOWN — the database has applied a migration this checkout does
//   not contain. Somebody ran a branch against it. The schema in front
//   of you is not the schema that database has, and every diff you
//   generate from here is built on a state you cannot see.
//
//   OUT OF ORDER — a pending migration numbered BEHIND one already
//   applied. Alice generates 0007 on Monday, Bob generates 0008 on
//   Tuesday, Bob's ships first. When Alice's is merged, a migrator that
//   walks forward from the highest applied entry skips 0007 in silence,
//   and it is never applied at all. Drizzle has this exact failure with
//   journal timestamps; forge would too, and neither tool says a word.
//
// Both are cheap to detect and expensive to discover any other way —
// usually as "why is this column missing in staging" a fortnight later.

import fs from 'node:fs';
import path from 'node:path';
import { readJournal, type Journal } from './snapshot';

export type MigrationState = 'applied' | 'pending' | 'unknown' | 'out-of-order';

export interface MigrationStatus {
  name: string;
  state: MigrationState;
  appliedAt?: string | null;
  /** For out-of-order: the applied migration it should have preceded. */
  behind?: string;
}

export interface StatusReport {
  rows: MigrationStatus[];
  applied: number;
  pending: number;
  unknown: number;
  outOfOrder: number;
  journal: Journal | null;
  /** True when nothing needs attention. */
  clean: boolean;
}

/** The `.sql` files in the folder, in the order they should apply. */
export function listLocalMigrations(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/**
 * Compare the folder against the ledger.
 *
 * `applied` comes from `_forge_migrations`; `local` from the migrations
 * directory. Nothing here touches the database — the caller reads the
 * ledger and passes it in, so this is testable without one.
 */
export function buildStatus(
  local: string[],
  applied: { name: string; appliedAt: string | null }[],
  dir: string,
): StatusReport {
  const appliedByName = new Map(applied.map((a) => [a.name, a.appliedAt]));
  const localSet = new Set(local);
  const rows: MigrationStatus[] = [];

  // The highest applied name THIS CHECKOUT ALSO HAS. Anything pending
  // that sorts below it would be skipped by a migrator walking forward.
  //
  // Applied migrations missing from this checkout are deliberately
  // excluded. They are reported separately and loudly, and letting one
  // set the high-water mark here would flag every ordinary pending
  // migration as out-of-order — with guidance ("regenerate on top of the
  // current state") that does not address the real cause. A safety check
  // that fires on innocent files is one people learn to scroll past.
  // The unknown block carries the ordering warning instead.
  const knownApplied = applied.map((a) => a.name).filter((n) => localSet.has(n));
  const highestApplied = knownApplied.length ? knownApplied.sort().slice(-1)[0]! : null;

  for (const name of local) {
    if (appliedByName.has(name)) {
      rows.push({ name, state: 'applied', appliedAt: appliedByName.get(name) ?? null });
      continue;
    }
    if (highestApplied && name < highestApplied) {
      rows.push({ name, state: 'out-of-order', behind: highestApplied });
      continue;
    }
    rows.push({ name, state: 'pending' });
  }

  // In the ledger, not in this checkout. Listed after the local ones
  // because their position in the sequence is exactly what is unknown.
  for (const a of applied) {
    if (localSet.has(a.name)) continue;
    rows.push({ name: a.name, state: 'unknown', appliedAt: a.appliedAt });
  }

  const count = (s: MigrationState) => rows.filter((r) => r.state === s).length;
  const unknown = count('unknown');
  const outOfOrder = count('out-of-order');
  return {
    rows,
    applied: count('applied'),
    pending: count('pending'),
    unknown,
    outOfOrder,
    journal: readJournal(dir),
    clean: unknown === 0 && outOfOrder === 0,
  };
}

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';

/** Human-readable, and quiet when there is nothing wrong. */
export function formatStatus(r: StatusReport, dir: string): string {
  const out: string[] = [];
  out.push(`  ${DIM}${path.relative(process.cwd(), dir) || dir}${RESET}`);
  out.push('');

  if (r.rows.length === 0) {
    out.push('  no migrations yet — `forge generate` writes the first one');
    return out.join('\n');
  }

  for (const row of r.rows) {
    switch (row.state) {
      case 'applied':
        out.push(`  ${GREEN}✓${RESET} ${row.name}${row.appliedAt ? `  ${DIM}${row.appliedAt}${RESET}` : ''}`);
        break;
      case 'pending':
        out.push(`  ${DIM}·${RESET} ${row.name}  ${DIM}pending${RESET}`);
        break;
      case 'out-of-order':
        out.push(`  ${YELLOW}!${RESET} ${row.name}  ${YELLOW}OUT OF ORDER${RESET} — sorts before ${row.behind}, which is already applied`);
        break;
      case 'unknown':
        out.push(`  ${RED}?${RESET} ${row.name}  ${RED}NOT IN THIS CHECKOUT${RESET}${row.appliedAt ? `  ${DIM}applied ${row.appliedAt}${RESET}` : ''}`);
        break;
    }
  }

  out.push('');
  out.push(
    `  ${r.applied} applied · ${r.pending} pending` +
      (r.outOfOrder ? ` · ${YELLOW}${r.outOfOrder} out of order${RESET}` : '') +
      (r.unknown ? ` · ${RED}${r.unknown} not in this checkout${RESET}` : ''),
  );

  if (r.unknown) {
    out.push('');
    out.push(`  ${RED}This database has applied migrations this checkout does not have.${RESET}`);
    out.push(`  Somebody ran a branch against it. The schema in front of you is not`);
    out.push(`  the schema this database has, so a migration generated from here is`);
    out.push(`  built on a state you cannot see.`);
    if (r.pending) {
      out.push('');
      out.push(`  It also blocks the ${r.pending} pending migration${r.pending === 1 ? '' : 's'} above: a migrator`);
      out.push(`  walking forward from the newest ledger entry will step over anything`);
      out.push(`  numbered below it. Resolve this before applying them.`);
    }
    out.push('');
    out.push(`  ${DIM}Find the branch that produced them, or — if the database is${RESET}`);
    out.push(`  ${DIM}disposable — reset it. Do not generate against it until it${RESET}`);
    out.push(`  ${DIM}matches a branch that exists.${RESET}`);
  }

  if (r.outOfOrder) {
    out.push('');
    out.push(`  ${YELLOW}A pending migration is numbered behind one already applied.${RESET}`);
    out.push(`  Two branches generated in parallel and the later one shipped first.`);
    out.push(`  A migrator walking forward from the newest applied entry skips these`);
    out.push(`  silently, and they are never applied at all.`);
    out.push('');
    out.push(`  ${DIM}Regenerate them on top of the current state: delete the file and${RESET}`);
    out.push(`  ${DIM}its snapshot, pull, then \`forge generate\` again so it is numbered${RESET}`);
    out.push(`  ${DIM}after what is already there.${RESET}`);
  }

  return out.join('\n');
}
