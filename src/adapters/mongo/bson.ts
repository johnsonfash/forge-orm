// Lazy access to mongodb's runtime value exports (ObjectId, MongoClient, …).
//
// `mongodb` is an OPTIONAL peer dependency, so importing forge for a SQL
// dialect must not require it. Every Mongo module accesses driver values
// through `mongo()` instead of a top-level `import { ObjectId } from 'mongodb'`
// (which would emit a module-load `require('mongodb')` and crash SQL-only
// installs). The driver is loaded on first actual Mongo use, with a clear
// error if it isn't installed.

let _m: typeof import('mongodb') | undefined;

export function mongo(): typeof import('mongodb') {
  if (!_m) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      _m = require('mongodb');
    } catch {
      throw new Error(
        "[forge] the 'mongodb' driver is required for Mongo operations but is not installed.\n" +
        '  Install:  npm install mongodb',
      );
    }
  }
  return _m!;
}

// Convenience shims for the two values forge uses most.
export const ObjectIdCtor = () => mongo().ObjectId;
export const isObjectId = (v: unknown): boolean =>
  !!v && typeof v === 'object' && (v as any)._bsontype === 'ObjectId';
