/**
 * Takes a database backup from the command line: `npm run db:backup`.
 *
 * Boots the Nest application context (no HTTP server) so the backup runs
 * through exactly the same service the nightly cron uses, including the
 * retention policy and the S3 upload.
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { BackupService } from '../src/modules/backup/backup.service';

async function main(): Promise<void> {
  const logger = new Logger('db:backup');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['log', 'warn', 'error'] });

  try {
    const result = await app.get(BackupService).run();
    logger.log(`Wrote ${result.file} (${(result.sizeBytes / 1024 / 1024).toFixed(1)} MB) in ${result.durationMs}ms`);
    if (result.uploaded) logger.log(`Uploaded as ${result.remoteKey}`);
    if (result.prunedLocal.length > 0) logger.log(`Pruned ${result.prunedLocal.length} old backup(s)`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  new Logger('db:backup').error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
