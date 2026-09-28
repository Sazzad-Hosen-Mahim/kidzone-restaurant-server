import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { SMS_QUEUE_NAME, SmsJobData } from './sms.constants';
import { SmsService } from './sms.service';

/**
 * Delivers queued SMS with three attempts and exponential backoff (configured
 * where the job is added). Every attempt updates the SmsLog row, so the log
 * shows how many tries a message took and why the last one failed.
 */
@Processor(SMS_QUEUE_NAME, { concurrency: 5 })
export class SmsProcessor extends WorkerHost {
  private readonly logger = new Logger(SmsProcessor.name);

  constructor(private readonly sms: SmsService) {
    super();
  }

  async process(job: Job<SmsJobData>): Promise<void> {
    this.logger.debug(`Delivering SMS log ${job.data.smsLogId} (attempt ${job.attemptsMade + 1})`);
    await this.sms.deliver(job.data.smsLogId);
  }
}
