import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { AppConfigService } from '@config/app-config.service';
import { AuditService } from '@modules/audit/audit.service';
import { AUDIT_ACTIONS } from '@modules/audit/audit.constants';
import { BusinessCalendarService } from '@common/services/business-calendar.service';
import { dayjs } from '@common/utils/date.util';
import { parsePostgresUrl } from '@common/utils/postgres-url.util';
import { S3UploaderService } from './s3-uploader.service';

const execFileAsync = promisify(execFile);
const DHAKA = 'Asia/Dhaka';

export interface BackupResult {
  file: string;
  sizeBytes: number;
  durationMs: number;
  uploaded: boolean;
  remoteKey?: string;
  prunedLocal: string[];
}

/**
 * Nightly database backup.
 *
 * `pg_dump -Fc` (compressed custom format) rather than plain SQL: it is smaller,
 * and `pg_restore` can restore it selectively and in parallel, which matters
 * when someone is restoring under pressure.
 *
 * Retention keeps the most recent N daily dumps plus the first dump of each of
 * the last M months, so a mistake noticed weeks later is still recoverable
 * without storing every night forever.
 */
@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);
  private running = false;

  constructor(
    private readonly config: AppConfigService,
    private readonly calendar: BusinessCalendarService,
    private readonly audit: AuditService,
    private readonly s3: S3UploaderService,
  ) {}

  @Cron('0 3 * * *', { name: 'database-backup', timeZone: DHAKA })
  async nightlyBackup(): Promise<void> {
    if (!this.config.get('ENABLE_CRON') || !this.config.get('BACKUP_ENABLED')) return;

    try {
      const result = await this.run();
      this.logger.log(
        `Backup complete: ${basename(result.file)} (${formatBytes(result.sizeBytes)}) in ${result.durationMs}ms` +
          (result.uploaded ? `, uploaded to ${result.remoteKey}` : ''),
      );
      await this.audit.recordSafe({
        actorId: null,
        action: AUDIT_ACTIONS.BACKUP_SUCCEEDED,
        entityType: 'Backup',
        entityId: basename(result.file),
        after: {
          sizeBytes: result.sizeBytes,
          durationMs: result.durationMs,
          uploaded: result.uploaded,
          remoteKey: result.remoteKey ?? null,
          prunedLocal: result.prunedLocal,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Backup FAILED: ${message}`);
      await this.audit.recordSafe({
        actorId: null,
        action: AUDIT_ACTIONS.BACKUP_FAILED,
        entityType: 'Backup',
        reason: message.slice(0, 500),
      });
    }
  }

  /**
   * Takes one backup: dump, upload, prune. Also the entry point for
   * `npm run db:backup`.
   */
  async run(): Promise<BackupResult> {
    if (this.running) {
      throw new Error('A backup is already running');
    }
    this.running = true;
    const startedAt = Date.now();

    try {
      const directory = resolve(this.config.get('BACKUP_DIR'));
      await mkdir(directory, { recursive: true });

      const businessDate = await this.calendar.today();
      const stamp = dayjs().tz(await this.calendar.timezone()).format('YYYYMMDD-HHmmss');
      const file = join(directory, `kidzone-${businessDate}-${stamp}.dump`);

      await this.dump(file);

      const { size } = await stat(file);
      if (size === 0) {
        await unlink(file);
        throw new Error('pg_dump produced an empty file');
      }

      let uploaded = false;
      let remoteKey: string | undefined;

      if (this.config.get('BACKUP_S3_ENABLED')) {
        remoteKey = `${this.config.get('BACKUP_S3_PREFIX')}${basename(file)}`;
        await this.s3.upload(remoteKey, createReadStream(file), size);
        uploaded = true;
      }

      const prunedLocal = await this.prune(directory);

      return { file, sizeBytes: size, durationMs: Date.now() - startedAt, uploaded, remoteKey, prunedLocal };
    } finally {
      this.running = false;
    }
  }

  /**
   * Runs pg_dump.
   *
   * The connection is passed as separate host/port/user/database flags with the
   * password in `PGPASSWORD`, rather than as a single URI argument: a URI on the
   * command line would put the database password in the process list, where any
   * other user on the host could read it.
   *
   * `--format=custom` is what makes `pg_restore` able to restore selectively
   * and in parallel, and it compresses on the way out.
   */
  private async dump(file: string): Promise<void> {
    const connection = parsePostgresUrl(this.config.get('DATABASE_URL'));

    const args = [
      '--host', connection.host,
      '--port', connection.port,
      '--username', connection.user,
      '--dbname', connection.database,
      '--format=custom',
      '--compress=6',
      '--no-owner',
      '--no-privileges',
      `--file=${file}`,
    ];

    try {
      await execFileAsync(this.config.get('BACKUP_PG_DUMP_PATH'), args, {
        env: { ...process.env, PGPASSWORD: connection.password ?? '' },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 30 * 60 * 1000,
      });
    } catch (error) {
      const detail =
        error instanceof Error && 'stderr' in error
          ? String((error as { stderr?: string }).stderr ?? error.message)
          : String(error);
      throw new Error(`pg_dump failed: ${detail.trim().slice(0, 500)}`, { cause: error });
    }
  }

  /**
   * Applies the retention policy: keep the most recent `BACKUP_KEEP_DAILY`
   * dumps, plus the earliest dump of each of the last `BACKUP_KEEP_MONTHLY`
   * months. Anything else is deleted.
   */
  async prune(directory: string): Promise<string[]> {
    const keepDaily = this.config.get('BACKUP_KEEP_DAILY');
    const keepMonthly = this.config.get('BACKUP_KEEP_MONTHLY');

    const entries = (await readdir(directory))
      .filter((name) => name.startsWith('kidzone-') && name.endsWith('.dump'))
      .sort()
      .reverse(); // newest first, since the name starts with the date

    const keep = new Set<string>(entries.slice(0, keepDaily));

    // The oldest dump in a month is the monthly archive for that month.
    const monthly = new Map<string, string>();
    for (const name of [...entries].reverse()) {
      const month = name.slice('kidzone-'.length, 'kidzone-'.length + 7); // YYYY-MM
      if (!monthly.has(month)) monthly.set(month, name);
    }

    const months = [...monthly.keys()].sort().reverse().slice(0, keepMonthly);
    for (const month of months) keep.add(monthly.get(month)!);

    const pruned: string[] = [];
    for (const name of entries) {
      if (keep.has(name)) continue;
      await unlink(join(directory, name));
      pruned.push(name);
    }

    if (pruned.length > 0) {
      this.logger.log(`Pruned ${pruned.length} old backup(s)`);
    }

    return pruned;
  }
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
