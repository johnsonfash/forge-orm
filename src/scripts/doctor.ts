/* eslint-disable no-console */
import * as dotenv from 'dotenv';
dotenv.config();

import { detectAdapterKind, DRIVER_PACKAGE_FOR } from '../adapters/detect';
import { isDriverInstalled } from '../adapters/missing-driver';
import type { AdapterKind } from '../adapters/types';

// forge doctor — environment check.
// Prints which drivers are installed, which adapter is inferred from
// DATABASE_URL, and what action (if any) the consumer needs to take.

function main() {
  const ALL: AdapterKind[] = ['mongo', 'postgres', 'mysql', 'sqlite'];
  const url = process.env.DATABASE_URL;
  const detected = url ? detectAdapterKind(url) : null;

  console.log('');
  console.log('Forge — environment check');
  console.log('');
  console.log('  Drivers installed:');
  for (const kind of ALL) {
    const info = isDriverInstalled(kind);
    const pkg = DRIVER_PACKAGE_FOR[kind];
    if (info.installed) {
      console.log(`    \x1b[32m✓\x1b[0m ${pkg.padEnd(16)} ${info.version}`);
    } else {
      console.log(`    \x1b[2m✗\x1b[0m ${pkg.padEnd(16)} not installed`);
    }
  }

  console.log('');
  console.log('  DATABASE_URL:');
  if (!url) {
    console.log('    \x1b[33m(not set)\x1b[0m — set in .env or pass createDb({ url })');
  } else {
    const redacted = url.replace(/(:\/\/[^:@/]+):([^@/]+)@/, '$1:****@');
    if (detected) {
      const info = isDriverInstalled(detected);
      const status = info.installed ? '\x1b[32m✓ driver installed\x1b[0m' : '\x1b[31m✗ driver missing\x1b[0m';
      console.log(`    ${redacted}  →  ${detected} adapter  (${status})`);
      if (!info.installed) {
        console.log(`    \x1b[33mAction:\x1b[0m npm install ${DRIVER_PACKAGE_FOR[detected]}`);
      }
    } else {
      console.log(`    ${redacted}  →  \x1b[31munknown prefix\x1b[0m`);
      console.log(`    \x1b[33mAction:\x1b[0m pass an explicit type to createDb({ type, url })`);
    }
  }
  console.log('');
}

main();
