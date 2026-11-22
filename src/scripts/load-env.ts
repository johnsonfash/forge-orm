/**
 * Load `.env` for the CLI commands without making dotenv a dependency.
 *
 * Every command used to `import * as dotenv from 'dotenv'`, but dotenv was only a
 * devDependency, so `forge` failed with "Cannot find module 'dotenv'" in any project
 * that did not happen to install it. Node 20.12+ reads `.env` itself
 * (`process.loadEnvFile`); dotenv is used when the project has it, and nothing is
 * required when neither applies. Variables already set in the environment win,
 * as they do with dotenv.
 */
import * as fs from 'node:fs';

export function loadEnv(file = '.env'): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const dotenv = require('dotenv');
    dotenv.config({ path: file, quiet: true });
    return;
  } catch {
    // dotenv not installed: fall through to Node's own loader.
  }
  const loadEnvFile = (process as any).loadEnvFile as ((p: string) => void) | undefined;
  if (typeof loadEnvFile === 'function' && fs.existsSync(file)) loadEnvFile(file);
}
