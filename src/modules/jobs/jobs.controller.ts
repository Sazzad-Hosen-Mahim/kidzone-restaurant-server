import { Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { paginationPage, paginationSkip, paginationTake } from '@common/dto/pagination-query.dto';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Prisma, Role } from '@prisma/client';
import { Roles } from '@common/decorators/roles.decorator';
import { PageResult, paginate } from '@common/http/api-response';
import { PrismaService } from '@/prisma/prisma.service';
import { QuerySmsLogDto } from './dto/query-sms-log.dto';
import { JobsService } from './jobs.service';
import { BackupService } from '@modules/backup/backup.service';

/**
 * Operational endpoints for the scheduled work: an admin can inspect what the
 * SMS gateway did and re-run a job by hand when something needed fixing
 * outside its usual slot.
 */
@ApiTags('Jobs')
@ApiBearerAuth('access-token')
@Controller('jobs')
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly backup: BackupService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('sms-log')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'The SMS delivery log',
    description:
      'Every message the system tried to send, with its status, attempt count and the gateway’s error if it failed. Phone numbers are shown in full here — this is the admin’s own audit surface — but they are masked everywhere in the application logs.',
  })
  async smsLog(@Query() query: QuerySmsLogDto): Promise<PageResult<unknown>> {
    const where: Prisma.SmsLogWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.search ? { phone: { contains: query.search } } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.smsLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: paginationSkip(query),
        take: paginationTake(query),
      }),
      this.prisma.smsLog.count({ where }),
    ]);

    return paginate(items, total, paginationPage(query), paginationTake(query));
  }

  @Post('run/expire-memberships')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Run the membership expiry sweep now',
    description:
      'Normally runs at 00:05 Asia/Dhaka. Idempotent: only ACTIVE memberships genuinely past their end date are changed.',
  })
  async runExpireMemberships(): Promise<{ expired: number }> {
    return { expired: await this.jobs.expireMemberships() };
  }

  @Post('run/expiry-reminders')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Queue expiry reminder SMS now',
    description:
      'Normally runs at 10:00 Asia/Dhaka. Idempotent per membership per reminder offset per day, so running it again sends nothing twice — the response reports how many were skipped for that reason.',
  })
  runExpiryReminders(): Promise<{ queued: number; skipped: number }> {
    return this.jobs.sendExpiryReminders();
  }

  @Post('run/cleanup')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Purge expired OTP codes and refresh tokens now',
    description: 'Normally runs hourly.',
  })
  runCleanup(): Promise<{ otpCodes: number; refreshTokens: number }> {
    return this.jobs.cleanup();
  }

  @Post('run/backup')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Take a database backup now',
    description:
      'Normally runs at 03:00 Asia/Dhaka. Runs `pg_dump -Fc`, uploads to S3-compatible storage when configured, then applies the retention policy. The result is written to the audit log either way.',
  })
  async runBackup(): Promise<unknown> {
    const result = await this.backup.run();
    return { ...result, file: maskPath(result.file) };
  }
}

/** Only the file name is useful to the client; the server path is not. */
function maskPath(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
