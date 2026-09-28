import { Injectable, Logger } from '@nestjs/common';
import { OtpCode, OtpPurpose, SmsType } from '@prisma/client';
import { createHash, randomInt } from 'node:crypto';
import { PrismaService } from '@/prisma/prisma.service';
import { AppConfigService } from '@config/app-config.service';
import { SettingsService } from '@modules/settings/settings.service';
import { SmsService } from '@modules/sms/sms.service';
import { SmsTemplatesService } from '@modules/sms/sms-templates.service';
import { DomainException } from '@common/exceptions/domain.exception';
import { maskPhone } from '@common/utils/phone.util';

export interface OtpSendResult {
  expiresAt: Date;
  expiresInSeconds: number;
  resendAfterSeconds: number;
  /** Only populated outside production, so the e2e suite and a developer can check in. */
  devCode?: string;
}

/**
 * Check-in OTP.
 *
 * Only the SHA-256 of the code is stored: a six-digit code is low entropy, but
 * it is also short-lived and attempt-limited, and hashing means a database dump
 * does not hand out live codes. SHA-256 rather than argon2 because the gate
 * verifies a code on every check-in and a 100 ms hash per attempt would be felt
 * at a queue.
 *
 * Three limits keep the endpoint from being useful to anyone else: a resend
 * cooldown, a cap on sends per phone per hour, and a cap on wrong attempts
 * before the code is burned.
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly config: AppConfigService,
    private readonly sms: SmsService,
    private readonly templates: SmsTemplatesService,
  ) {}

  async send(phone: string, purpose: OtpPurpose = OtpPurpose.CHECK_IN): Promise<OtpSendResult> {
    const {
      otpExpiryMinutes,
      otpResendCooldownSeconds,
      otpMaxSendsPerHour,
    } = await this.settings.getAll();

    const now = new Date();

    const latest = await this.prisma.otpCode.findFirst({
      where: { phone, purpose },
      orderBy: { createdAt: 'desc' },
    });

    if (latest) {
      const sinceLast = (now.getTime() - latest.createdAt.getTime()) / 1000;
      if (sinceLast < otpResendCooldownSeconds) {
        const wait = Math.ceil(otpResendCooldownSeconds - sinceLast);
        throw new DomainException(
          'OTP_RESEND_TOO_SOON',
          `A code was just sent. Please wait ${wait} more second(s) before requesting another.`,
          429,
          { retryAfterSeconds: wait },
        );
      }
    }

    const sentThisHour = await this.prisma.otpCode.count({
      where: { phone, purpose, createdAt: { gte: new Date(now.getTime() - 60 * 60 * 1000) } },
    });

    if (sentThisHour >= otpMaxSendsPerHour) {
      throw new DomainException(
        'OTP_HOURLY_LIMIT_REACHED',
        `Too many codes have been requested for this number in the last hour. Try again later, or ask an administrator for a manual check-in.`,
        429,
        { limit: otpMaxSendsPerHour },
      );
    }

    // A new code supersedes any earlier one for this number.
    await this.prisma.otpCode.updateMany({
      where: { phone, purpose, consumedAt: null },
      data: { consumedAt: now },
    });

    const code = generateCode();
    const expiresAt = new Date(now.getTime() + otpExpiryMinutes * 60_000);

    await this.prisma.otpCode.create({
      data: { phone, purpose, codeHash: hashCode(code), expiresAt },
    });

    const message = await this.templates.render('smsTemplateOtp', { otp: code, minutes: otpExpiryMinutes });
    await this.sms.enqueue({ phone, type: SmsType.OTP, message });

    this.logger.log(`Check-in OTP issued for ${maskPhone(phone)}, valid ${otpExpiryMinutes} minute(s)`);

    return {
      expiresAt,
      expiresInSeconds: otpExpiryMinutes * 60,
      resendAfterSeconds: otpResendCooldownSeconds,
      // Never in production: this is what lets the e2e suite and a developer
      // complete a check-in without a real SMS gateway.
      ...(this.config.isProduction ? {} : { devCode: code }),
    };
  }

  /**
   * Verifies and consumes a code.
   *
   * A wrong attempt increments the counter; reaching the limit burns the code
   * so an attacker cannot keep guessing, and the guardian simply requests a new
   * one.
   */
  async verify(phone: string, code: string, purpose: OtpPurpose = OtpPurpose.CHECK_IN): Promise<OtpCode> {
    const maxAttempts = await this.settings.get('otpMaxAttempts');
    const now = new Date();

    const record = await this.prisma.otpCode.findFirst({
      where: { phone, purpose, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (!record) {
      throw new DomainException('OTP_NOT_FOUND', 'No active code for this number. Request a new one.', 400);
    }

    if (record.expiresAt <= now) {
      await this.prisma.otpCode.update({ where: { id: record.id }, data: { consumedAt: now } });
      throw new DomainException('OTP_EXPIRED', 'That code has expired. Request a new one.', 400);
    }

    if (record.attempts >= maxAttempts) {
      await this.prisma.otpCode.update({ where: { id: record.id }, data: { consumedAt: now } });
      throw new DomainException('OTP_TOO_MANY_ATTEMPTS', 'Too many wrong attempts. Request a new code.', 429);
    }

    if (record.codeHash !== hashCode(code)) {
      const updated = await this.prisma.otpCode.update({
        where: { id: record.id },
        data: { attempts: { increment: 1 } },
      });

      const remaining = Math.max(0, maxAttempts - updated.attempts);

      if (remaining === 0) {
        await this.prisma.otpCode.update({ where: { id: record.id }, data: { consumedAt: now } });
        throw new DomainException('OTP_TOO_MANY_ATTEMPTS', 'Too many wrong attempts. Request a new code.', 429);
      }

      throw new DomainException(
        'OTP_INCORRECT',
        `That code is not correct. ${remaining} attempt(s) remaining.`,
        400,
        { attemptsRemaining: remaining },
      );
    }

    return this.prisma.otpCode.update({ where: { id: record.id }, data: { consumedAt: now } });
  }

  /** Deletes expired and consumed codes. Run hourly. */
  async purgeExpired(): Promise<number> {
    const { count } = await this.prisma.otpCode.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: new Date() } },
          { consumedAt: { lt: new Date(Date.now() - 60 * 60 * 1000) } },
        ],
      },
    });
    return count;
  }
}

/** A uniformly distributed six-digit code, including ones with leading zeros. */
function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}
