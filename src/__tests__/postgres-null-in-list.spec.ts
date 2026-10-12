import { compileSelect } from '../adapters/postgres/compile-from-ir';
import { buildSelect } from '../ir/build';
import { model, f } from '../index';
import type { ModelDef } from '../schema/types';

/**
 * A `null` INSIDE AN `in` LIST IS A MEMBER OF THE LIST.
 *
 * `{ loc: { in: ['L1', null] } }` means "L1, or not set at all" — which is
 * what Mongo does, where `$in` with a null member matches an explicit null
 * AND a missing key. Measured on both engines with the same three rows (one
 * 'L1', one explicit null, one with the key absent):
 *
 *   Mongo     $in: ['L1', null]   →  all three
 *   Postgres  IN ('L1', NULL)     →  only the 'L1' row
 *
 * The idiom this broke is scoping rows to a branch while keeping the
 * org-wide ones that have no branch set — 23 repos in the application that
 * found it. Every one came back missing all its org-wide rows, silently.
 */

const Row = model('rows', {
  id: f.id(),
  orgId: f.objectId(),
  locationId: f.objectId().optional(),
}) as unknown as ModelDef<any>;

const where = (w: Record<string, unknown>) =>
  compileSelect(buildSelect('row', Row, { where: w }, 'many') as any, Row).sql;

describe('null inside an `in` list', () => {
  it('becomes IS NULL alongside the IN, not a NULL inside it', () => {
    const sql = where({ locationId: { in: ['L1', null] } });
    expect(sql).toMatch(/\("rows"\."locationId" IN \(\$\d+\) OR "rows"\."locationId" IS NULL\)/);
    // The null must not be passed as a bound value — that is the form that
    // silently matched nothing.
    expect(sql).not.toMatch(/IN \(\$\d+, \$\d+\)/);
  });

  it('a list of only nulls is just IS NULL', () => {
    const sql = where({ locationId: { in: [null] } });
    expect(sql).toMatch(/"locationId" IS NULL/);
    expect(sql).not.toMatch(/ IN \(/);
  });

  it('leaves a list with no nulls exactly as it was', () => {
    const sql = where({ locationId: { in: ['L1', 'L2'] } });
    expect(sql).toMatch(/"locationId" IN \(\$1, \$2\)/);
    expect(sql).not.toMatch(/IS NULL/);
  });

  it('an empty list still matches nothing', () => {
    expect(where({ locationId: { in: [] } })).toMatch(/FALSE|1 = 0|0 = 1/i);
  });
});

describe('null inside a `notIn` list', () => {
  it('becomes IS NOT NULL alongside the NOT IN', () => {
    // Worse than `in` before this: `loc NOT IN ('L1', NULL)` is UNKNOWN for
    // every row, including the ones that plainly are not 'L1', so the filter
    // matched NOTHING rather than too little.
    const sql = where({ locationId: { notIn: ['L1', null] } });
    expect(sql).toMatch(
      /\("rows"\."locationId" NOT IN \(\$\d+\) AND "rows"\."locationId" IS NOT NULL\)/,
    );
  });

  it('a list of only nulls is just IS NOT NULL', () => {
    const sql = where({ locationId: { notIn: [null] } });
    expect(sql).toMatch(/"locationId" IS NOT NULL/);
    expect(sql).not.toMatch(/NOT IN \(/);
  });

  it('leaves a list with no nulls exactly as it was', () => {
    expect(where({ locationId: { notIn: ['L1'] } })).toMatch(/"locationId" NOT IN \(\$1\)/);
  });
});
