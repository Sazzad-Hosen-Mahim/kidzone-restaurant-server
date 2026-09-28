import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as dotenv from 'dotenv';

/**
 * Brings the e2e database up to the committed migrations before any suite runs.
 * The e2e suite never touches the development database: it reads
 * TEST_DATABASE_URL (from .env.test, falling back to .env) and refuses to run
 * if that points at the same database as DATABASE_URL.
 */
export default function globalSetup(): void {
  process.env.NODE_ENV = 'test';

  for (const file of ['.env.test', '.env']) {
    const path = resolve(process.cwd(), file);
    if (existsSync(path)) dotenv.config({ path, override: false });
  }

  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) {
    throw new Error('TEST_DATABASE_URL must be set to run the e2e suite. See .env.example.');
  }

  const devUrl = process.env.DATABASE_URL;
  if (devUrl && stripSchema(devUrl) === stripSchema(testUrl) && !devUrl.includes('_test')) {
    throw new Error('TEST_DATABASE_URL points at the development database. Refusing to run e2e tests.');
  }

  process.env.DATABASE_URL = testUrl;

  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: testUrl },
  });
}

function stripSchema(url: string): string {
  return url.split('?')[0];
}
