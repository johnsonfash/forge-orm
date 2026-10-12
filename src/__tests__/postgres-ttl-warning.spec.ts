// A TTL index on Postgres: created, but it does NOT expire anything.
//
// `expireAfterSeconds` tells Mongo to delete a row once a date column
// is old enough. Postgres has no equivalent — expiry is a job, not an
// index — so the adapter cannot honour it and never could.
//
// What it did was build the index WITHOUT the expiry and say nothing.
// The index looks right in `\d`, the push reports success, and the rows
// simply stop being deleted. On the schema that found this, that was
// eight indexes, every one on a table that grows a row per
// authentication attempt: OTP codes, reset tokens, refresh tokens,
// portal sessions, finished jobs — the tables the TTLs were added to
// stop growing.
//
// There is nothing to emit, so the honest answer is to say so while the
// operator is looking at the push output.

import { f, model } from '../schema/core';
import type { ModelDef } from '../schema/types';
import { buildSchemaDDL } from '../adapters/postgres/ddl';

const otps = () =>
  model('otp_codes', {
    id: f.id(),
    code: f.string(),
    createdAt: f.dateTime().default('now'),
  }, {
    indexes: [
      { keys: { createdAt: 1 }, name: 'idx_otp_ttl', expireAfterSeconds: 600 },
      { keys: { code: 1 }, name: 'idx_otp_code' },
    ],
  }) as unknown as ModelDef<any>;

describe('a TTL index on Postgres', () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  afterAll(() => warn.mockRestore());

  it('⚠️ WARNS THAT NOTHING WILL EXPIRE', () => {
    warn.mockClear();
    buildSchemaDDL({ OtpCode: otps() } as never);
    const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(said).toContain('idx_otp_ttl');
    expect(said).toContain('no TTL index');
    // Names the table, because the fix is a delete job for that table.
    expect(said).toContain('otp_codes');
  });

  it('still creates the index, it just does not expire', () => {
    const ddl = buildSchemaDDL({ OtpCode: otps() } as never);
    expect(ddl.find((s) => s.name === 'idx_otp_ttl')).toBeDefined();
  });

  it('says nothing about an ordinary index', () => {
    warn.mockClear();
    buildSchemaDDL({ OtpCode: otps() } as never);
    const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(said).not.toContain('idx_otp_code');
  });
});
