import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { maskPhone } from '@common/utils/phone.util';
import { SmsProvider, SmsSendResult } from '../sms-provider.interface';

/**
 * The default provider in development and tests. It logs the message instead of
 * spending money on a real SMS.
 *
 * The phone number is masked even here, so a developer's terminal scrollback
 * and CI logs never accumulate customers' numbers. The message body is printed
 * in full in development only, because a check-in OTP is in it.
 */
@Injectable()
export class ConsoleSmsProvider implements SmsProvider {
  readonly name = 'console';
  private readonly logger = new Logger('SMS');

  async send(phone: string, message: string): Promise<SmsSendResult> {
    const body = process.env.NODE_ENV === 'development' ? message : `[${message.length} chars]`;
    this.logger.log(`-> ${maskPhone(phone)}: ${body}`);
    return { providerMessageId: `console-${randomUUID()}` };
  }
}
