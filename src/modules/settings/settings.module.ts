import { Global, Module } from '@nestjs/common';
import { AuditModule } from '@modules/audit/audit.module';
import { BusinessCalendarService } from '@common/services/business-calendar.service';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

/**
 * Global because almost every module needs settings or the business calendar
 * that is derived from them (timezone, business day start hour, week start).
 */
@Global()
@Module({
  imports: [AuditModule],
  controllers: [SettingsController],
  providers: [SettingsService, BusinessCalendarService],
  exports: [SettingsService, BusinessCalendarService],
})
export class SettingsModule {}
