// Prisma-shape error wrappers so existing `try/catch` blocks keep working.
//
// Codes mirrored:
//   P2002 — unique constraint violation (Mongo dup key, code 11000)
//   P2025 — record not found (used by *OrThrow methods + delete on missing)
//
// We don't try to mirror every Prisma error code — only the ones the codebase
// catches by code today.

export class DbKnownError extends Error {
  code: string;
  meta?: Record<string, any>;
  constructor(code: string, message: string, meta?: Record<string, any>) {
    super(message);
    this.name = 'DbKnownError';
    this.code = code;
    this.meta = meta;
  }
}

const DUP_KEY_MONGO = 11000;
const DUP_KEY_INDEX_RE = /index:\s+([^\s]+)\s+dup key/;

export function rethrowMongoError(err: any, model: string): never {
  if (err && (err.code === DUP_KEY_MONGO || err.code === '11000')) {
    const m = String(err.message || '').match(DUP_KEY_INDEX_RE);
    throw new DbKnownError('P2002', `Unique constraint failed on ${model}`, {
      target: m ? [m[1]] : undefined,
      modelName: model,
    });
  }
  throw err;
}

export function notFoundError(model: string, where: any): DbKnownError {
  return new DbKnownError(
    'P2025',
    `No ${model} found matching the given criteria`,
    { modelName: model, cause: where },
  );
}
