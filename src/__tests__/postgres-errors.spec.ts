import { rethrowPgError, withPgErrors } from '../adapters/postgres/errors';
import { DbKnownError } from '../adapters/mongo/errors';

// Synthesise the error shape that `pg` returns. Keys match the actual library
// — `code` (SQLSTATE), plus optional `constraint`, `column`, `table`, `detail`.
function pgError(sqlstate: string, extras: Record<string, any> = {}): any {
  return Object.assign(new Error(extras.message ?? 'simulated pg error'), {
    code: sqlstate, ...extras,
  });
}

describe('PG errors — SQLSTATE → DbKnownError', () => {
  it('23505 (unique_violation) → P2002 with constraint name', () => {
    try {
      rethrowPgError(pgError('23505', { constraint: 'forge_users_uq_email' }));
      fail('expected throw');
    } catch (e: any) {
      expect(e).toBeInstanceOf(DbKnownError);
      expect(e.code).toBe('P2002');
      expect(e.message).toMatch(/forge_users_uq_email/);
      expect(e.meta.target).toEqual(['forge_users_uq_email']);
      expect(e.meta.sqlstate).toBe('23505');
    }
  });

  it('23503 (foreign_key_violation) → P2003', () => {
    try { rethrowPgError(pgError('23503', { constraint: 'forge_posts_fk_author_id' })); fail('expected throw'); }
    catch (e: any) { expect(e.code).toBe('P2003'); }
  });

  it('23502 (not_null_violation) → P2011 with field name', () => {
    try { rethrowPgError(pgError('23502', { column: 'email' })); fail('expected throw'); }
    catch (e: any) {
      expect(e.code).toBe('P2011');
      expect(e.meta.field_name).toBe('email');
      expect(e.message).toMatch(/email/);
    }
  });

  it('40P01 (deadlock) → P2034', () => {
    try { rethrowPgError(pgError('40P01')); fail('expected throw'); }
    catch (e: any) {
      expect(e.code).toBe('P2034');
      expect(e.message).toMatch(/deadlock/i);
    }
  });

  it('42P01 (undefined table) → P2021 with table name', () => {
    try { rethrowPgError(pgError('42P01', { table: 'users' })); fail('expected throw'); }
    catch (e: any) {
      expect(e.code).toBe('P2021');
      expect(e.message).toMatch(/users/);
    }
  });

  it('28P01 (auth failure) → P1010', () => {
    try { rethrowPgError(pgError('28P01')); fail('expected throw'); }
    catch (e: any) { expect(e.code).toBe('P1010'); }
  });

  it('unrecognised SQLSTATE is rethrown verbatim', () => {
    const e = pgError('XX999', { message: 'mystery' });
    expect(() => rethrowPgError(e)).toThrow('mystery');
  });

  it('pre-existing DbKnownError flows through unchanged', () => {
    const existing = new DbKnownError('P2025', 'not found');
    expect(() => rethrowPgError(existing)).toThrow(existing);
  });
});

describe('withPgErrors — Promise wrapper', () => {
  it('passes through success values', async () => {
    const r = await withPgErrors(async () => 42);
    expect(r).toBe(42);
  });

  it('rethrows pg errors as DbKnownError', async () => {
    await expect(
      withPgErrors(async () => { throw pgError('23505', { constraint: 'uq_x' }); }),
    ).rejects.toBeInstanceOf(DbKnownError);
  });
});
