import { getQueueToken } from '@nestjs/bullmq';

export const SMS_QUEUE_NAME = 'sms';

/** Injection token for the BullMQ SMS queue. */
export const SMS_QUEUE_TOKEN = getQueueToken(SMS_QUEUE_NAME);

export interface SmsJobData {
  smsLogId: string;
}
