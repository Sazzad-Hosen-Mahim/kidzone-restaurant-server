import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MembershipStatus, SmsType } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AppConfigService } from '@config/app-config.service';
import { SettingsService } from '@modules/settings/settings.service';
import { SmsService } from '@modules/sms/sms.service';
import { SmsTemplatesService } from '@modules/sms/sms-templates.service';
import { TokenService } from '@modules/auth/token.service';
import { MembershipsService } from '@modules/kidzone/memberships/memberships.service';
import { OtpService } from '@modules/kidzone/checkin/otp.service';
import { BusinessCalendarService } from '@common/services/business-calendar.service';
import { addDays, fromDateColumn, toDateColumn } from '@common/utils/date.util';
import { maskPhone } from '@common/utils/phone.util';

const DHAKA = 'Asia/Dhaka';

/**
 * Scheduled maintenance.
 *
 * Every job is written to be safe to run twice: the cron schedule is a
 * convenience, not a guarantee, and a restart at the wrong moment must not
 * double-charge, double-send or double-expire anything. Each one is also
 * exposed as a plain method so it can be triggered by hand and tested directly.
 *
 * Cron times are expressed in the business timezone, since "00:05 daily" means
 * five past midnight in Dhaka, not in UTC.
 */
@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly settings: SettingsService,
    private readonly calendar: BusinessCalendarService,
    private readonly memberships: MembershipsService,
    private readonly otp: OtpService,
    private readonly tokens: TokenService,
    private readonly sms: SmsService,
    private readonly templates: SmsTemplatesService,
  ) {}

  // -------------------------------------------------------------------------
  // 00:05 — expire memberships whose end date has passed
  // -------------------------------------------------------------------------

  @Cron('5 0 * * *', { name: 'expire-memberships', timeZone: DHAKA })
  async expireMembershipsCron(): Promise<void> {
    if (!this.enabled) return;
    await this.expireMemberships();
  }

  /** Idempotent: only ACTIVE rows genuinely past their end date are touched. */
  async expireMemberships(): Promise<number> {
    const today = await this.calendar.today();
    const count = await this.memberships.expirePastDue(today);
    if (count > 0) this.logger.log(`Marked ${count} membership(s) as EXPIRED as of ${today}`);
    return count;
  }

  // -------------------------------------------------------------------------
  // 10:00 — expiry reminders
  // -------------------------------------------------------------------------

  @Cron('0 10 * * *', { name: 'expiry-reminders', timeZone: DHAKA })
  async expiryRemindersCron(): Promise<void> {
    if (!this.enabled) return;
    await this.sendExpiryReminders();
  }

  /**
   * Queues a reminder for every active membership ending in exactly one of the
   * configured `expiryReminderDays`.
   *
   * Idempotency comes from `expiry_reminder_logs`, which has a unique
   * constraint on (membership, daysBefore, sentOn): a re-run on the same day
   * hits the constraint and skips, so a restarted container cannot text the
   * same guardian twice.
   */
  async sendExpiryReminders(): Promise<{ queued: number; skipped: number }> {
    const today = await this.calendar.today();
    const reminderDays = await this.settings.get('expiryReminderDays');

    let queued = 0;
    let skipped = 0;

    for (const daysBefore of reminderDays) {
      const targetDate = addDays(today, daysBefore);

      const memberships = await this.prisma.membership.findMany({
        where: { status: MembershipStatus.ACTIVE, endDate: toDateColumn(targetDate) },
        include: {
          customer: { select: { name: true, phone: true } },
          child: { select: { name: true } },
          plan: { select: { name: true } },
        },
      });

      for (const membership of memberships) {
        const claimed = await this.claimReminder(membership.id, daysBefore, today);
        if (!claimed) {
          skipped++;
          continue;
        }

        const message = await this.templates.render('smsTemplateExpiryReminder', {
          name: membership.customer.name,
          child: membership.child.name,
          plan: membership.plan.name,
          endDate: fromDateColumn(membership.endDate),
          daysLeft: daysBefore,
        });

        await this.sms.enqueue({
          phone: membership.customer.phone,
          type: SmsType.EXPIRY_REMINDER,
          message,
        });

        this.logger.log(
          `Expiry reminder (${daysBefore} day(s)) queued for ${maskPhone(membership.customer.phone)}`,
        );
        queued++;
      }
    }

    if (queued > 0 || skipped > 0) {
      this.logger.log(`Expiry reminders: ${queued} queued, ${skipped} already sent today`);
    }

    return { queued, skipped };
  }

  /**
   * Takes the "I am sending this reminder" claim. Returns false when another
   * run already has it. The unique constraint is what makes the check atomic;
   * a read-then-write would race with a second container.
   */
  private async claimReminder(membershipId: string, daysBefore: number, sentOn: string): Promise<boolean> {
    try {
      await this.prisma.expiryReminderLog.create({
        data: { membershipId, daysBefore, sentOn: toDateColumn(sentOn) },
      });
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Hourly — clean up expired OTP codes and refresh tokens
  // -------------------------------------------------------------------------

  @Cron('0 * * * *', { name: 'cleanup', timeZone: DHAKA })
  async cleanupCron(): Promise<void> {
    if (!this.enabled) return;
    await this.cleanup();
  }

  async cleanup(): Promise<{ otpCodes: number; refreshTokens: number }> {
    const [otpCodes, refreshTokens] = await Promise.all([this.otp.purgeExpired(), this.tokens.purgeStale()]);

    if (otpCodes > 0 || refreshTokens > 0) {
      this.logger.log(`Cleanup: removed ${otpCodes} OTP code(s) and ${refreshTokens} refresh token(s)`);
    }

    return { otpCodes, refreshTokens };
  }

  private get enabled(): boolean {
    return this.config.get('ENABLE_CRON');
  }
}
