/**
 * Restores a backup: `npm run db:restore -- <file> [--yes] [--url=<target>]`
 *
 * Restoring is destructive, so this script is deliberately awkward in three
 * ways: it prints the target database and makes you type its name, it refuses
 * a production-looking URL without `--yes`, and it never guesses a file.
 *
 *   npm run db:restore -- ./backups/kidzone-2026-09-22-030001.dump
 *   npm run db:restore -- ./backups/kidzone-2026-09-22-030001.dump --yes
 *   npm run db:restore -- ./backup.dump --url=postgresql://user:pass@host:5432/restore_test
 */
import 'reflect-metadata';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import * as dotenv from 'dotenv';
import { describePostgresUrl, parsePostgresUrl } from '../src/common/utils/postgres-url.util';

const execFileAsync = promisify(execFile);

interface Args {
  file: string;
  yes: boolean;
  url?: string;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let yes = false;
  let url: string | undefined;

  for (const arg of argv) {
    if (arg === '--yes' || arg === '-y') yes = true;
    else if (arg.startsWith('--url=')) url = arg.slice('--url='.length);
    else positional.push(arg);
  }

  if (positional.length === 0) {
    throw new Error(
      'Usage: npm run db:restore -- <file.dump> [--yes] [--url=postgresql://...]\n' +
        '  Backups live in the directory named by BACKUP_DIR (default ./backups).',
    );
  }

  return { file: resolve(positional[0]), yes, url };
}

function looksLikeProduction(url: string): boolean {
  return /prod|production|live/i.test(url) && !/localhost|127\.0\.0\.1/.test(url);
}

async function main(): Promise<void> {
  dotenv.config();

  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(args.file)) {
    throw new Error(`Backup file not found: ${args.file}`);
  }

  const target = args.url ?? process.env.DATABASE_URL;
  if (!target) {
    throw new Error('No target database. Set DATABASE_URL or pass --url=');
  }

  const connection = parsePostgresUrl(target);

  console.log('');
  console.log('  Restore');
  console.log(`  From:   ${args.file}`);
  console.log(`  Into:   ${describePostgresUrl(target)}`);
  console.log('');
  console.log('  This DROPS and recreates every object in the target database.');
  console.log('');

  if (looksLikeProduction(target) && !args.yes) {
    throw new Error('The target looks like production. Re-run with --yes if that is really what you want.');
  }

  if (!args.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`  Type the database name (${connection.database}) to continue: `);
    rl.close();

    if (answer.trim() !== connection.database) {
      console.log('  Cancelled.');
      return;
    }
  }

  // --clean --if-exists drops existing objects first, so restoring over a live
  // schema does not fail on every CREATE.
  // --single-transaction makes the whole restore all-or-nothing: a failure
  // half way through leaves the database as it was rather than half restored.
  // --no-owner keeps it working when the restoring role differs from the one
  // that took the dump.
  const restoreArgs = [
    '--host', connection.host,
    '--port', connection.port,
    '--username', connection.user,
    '--dbname', connection.database,
    '--clean',
    '--if-exists',
    '--no-owner',
    '--no-privileges',
    '--single-transaction',
    args.file,
  ];

  console.log('  Restoring...');

  try {
    const { stderr } = await execFileAsync(process.env.BACKUP_PG_RESTORE_PATH || 'pg_restore', restoreArgs, {
      env: { ...process.env, PGPASSWORD: connection.password ?? '' },
      maxBuffer: 64 * 1024 * 1024,
    });
    if (stderr?.trim()) console.log(stderr.trim());
  } catch (error) {
    const stderr = error instanceof Error && 'stderr' in error ? String((error as { stderr?: string }).stderr) : '';
    throw new Error(`pg_restore failed:\n${stderr || (error instanceof Error ? error.message : String(error))}`, {
      cause: error,
    });
  }

  console.log('  Done.');
  console.log('  If the dump predates the current migrations, run: npx prisma migrate deploy');
}

main().catch((error: unknown) => {
  console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
