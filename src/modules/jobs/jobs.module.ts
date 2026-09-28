import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from '@modules/auth/auth.module';
import { KidZoneModule } from '@modules/kidzone/kidzone.module';
import { JobsService } from './jobs.service';
import { BackupService } from '@modules/backup/backup.service';
import { S3UploaderService } from '@modules/backup/s3-uploader.service';
import { JobsController } from './jobs.controller';

/**
 * Scheduled maintenance and backups.
 *
 * `ScheduleModule.forRoot()` is registered here rather than in AppModule so the
 * cron registry lives with the jobs it drives. Individual jobs still check
 * `ENABLE_CRON` at fire time, which is how the test suite and one-off CLI runs
 * avoid firing them.
 */
@Module({
  imports: [ScheduleModule.forRoot(), AuthModule, KidZoneModule],
  controllers: [JobsController],
  providers: [JobsService, BackupService, S3UploaderService],
  exports: [JobsService, BackupService],
})
export class JobsModule {}
