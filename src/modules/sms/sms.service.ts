import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { SmsLog, SmsStatus, SmsType } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '@/prisma/prisma.service';
import { AppConfigService } from '@config/app-config.service';
import { maskPhone, tryNormalizeBdPhone } from '@common/utils/phone.util';
import { SMS_PROVIDER, SmsProvider } from './sms-provider.interface';
import { SMS_QUEUE_NAME, SMS_QUEUE_TOKEN, SmsJobData } from './sms.constants';

export interface EnqueueSmsInput {
  phone: string;
  type: SmsType;
  message: string;
}

/**
 * The single way anything in this application sends an SMS.
 *
 * Every message is written to `sms_logs` before a delivery is attempted, so a
 * message that never arrives is still visible to whoever has to answer "did the
 * customer get the code?". Delivery then goes through BullMQ with retries; when
 * the queue is switched off (tests, or a deployment without Redis) the send
 * happens inline and a failure is logged rather than raised, because no
 * customer-facing request should fail just because the SMS gateway is down.
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    @Inject(SMS_PROVIDER) private readonly provider: SmsProvider,
    @Optional() @Inject(SMS_QUEUE_TOKEN) private readonly queue?: Queue<SmsJobData>,
  ) {}

  /**
   * Records the message and schedules delivery. Never throws for a delivery
   * problem; the caller's sale must still complete.
   */
  async enqueue(input: EnqueueSmsInput): Promise<SmsLog | null> {
    const phone = tryNormalizeBdPhone(input.phone);

    if (!phone) {
      this.logger.warn(`Refusing to send ${input.type}: "${maskPhone(input.phone)}" is not a valid mobile number`);
      return null;
    }

    const log = await this.prisma.smsLog.create({
      data: {
        phone,
        type: input.type,
        message: input.message,
        provider: this.provider.name,
        status: SmsStatus.QUEUED,
      },
    });

    if (this.queue) {
      await this.queue.add(
        SMS_QUEUE_NAME,
        { smsLogId: log.id },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: { count: 200 },
          removeOnFail: { count: 500 },
        },
      );
    } else {
      // No queue: deliver inline, detached from the caller's request.
      void this.deliver(log.id).catch(() => undefined);
    }

    return log;
  }

  /**
   * Performs the actual send and records the outcome. Called by the queue
   * processor, and directly when the queue is disabled. Rethrows on failure so
   * BullMQ can retry.
   */
  async deliver(smsLogId: string): Promise<void> {
    const log = await this.prisma.smsLog.findUnique({ where: { id: smsLogId } });
    if (!log) {
      this.logger.warn(`SMS log ${smsLogId} no longer exists; nothing to deliver`);
      return;
    }
    if (log.status === SmsStatus.SENT) return;

    try {
      const result = await this.provider.send(log.phone, log.message);
      await this.prisma.smsLog.update({
        where: { id: smsLogId },
        data: {
          status: SmsStatus.SENT,
          providerMessageId: result.providerMessageId ?? null,
          error: null,
          attempts: { increment: 1 },
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.smsLog.update({
        where: { id: smsLogId },
        data: { status: SmsStatus.FAILED, error: message.slice(0, 500), attempts: { increment: 1 } },
      });
      this.logger.error(`SMS ${log.type} to ${maskPhone(log.phone)} failed: ${message}`);
      throw error;
    }
  }

  get queueEnabled(): boolean {
    return this.queue !== undefined && this.config.get('ENABLE_QUEUE');
  }
}
