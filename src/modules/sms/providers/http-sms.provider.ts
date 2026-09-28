import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { AxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import { AppConfigService } from '@config/app-config.service';
import { maskPhone } from '@common/utils/phone.util';
import { SmsProvider, SmsSendResult } from '../sms-provider.interface';

/**
 * A generic HTTP gateway client.
 *
 * Bangladeshi bulk-SMS providers (SSL Wireless, Alpha SMS, BulkSMSBD, Mimsms
 * and friends) all expose the same shape — an endpoint taking an API key, a
 * sender id, a number and a body — but each names those parameters differently.
 * Rather than a class per vendor, the parameter names come from env
 * (`SMS_PARAM_*`), so switching provider is a configuration change.
 *
 * `SMS_EXTRA_PARAMS` carries anything else a particular gateway insists on,
 * such as `{"type":"text"}`.
 */
@Injectable()
export class HttpSmsProvider implements SmsProvider {
  readonly name: string;
  private readonly logger = new Logger('SMS');

  constructor(
    private readonly http: HttpService,
    private readonly config: AppConfigService,
  ) {
    this.name = `http:${hostOf(config.get('SMS_HTTP_URL') ?? '')}`;
  }

  async send(phone: string, message: string): Promise<SmsSendResult> {
    const url = this.config.get('SMS_HTTP_URL');
    if (!url) throw new Error('SMS_HTTP_URL is not configured');

    const params: Record<string, string> = {
      [this.config.get('SMS_PARAM_API_KEY')]: this.config.get('SMS_HTTP_API_KEY') ?? '',
      [this.config.get('SMS_PARAM_SENDER_ID')]: this.config.get('SMS_HTTP_SENDER_ID') ?? '',
      [this.config.get('SMS_PARAM_PHONE')]: phone,
      [this.config.get('SMS_PARAM_MESSAGE')]: message,
      ...this.config.get('SMS_EXTRA_PARAMS'),
    };

    const method = this.config.get('SMS_HTTP_METHOD');
    const timeout = this.config.get('SMS_TIMEOUT_MS');

    try {
      const response = await firstValueFrom(
        method === 'GET'
          ? this.http.get(url, { params, timeout })
          : this.http.post(url, params, { timeout }),
      );

      const body = response.data as unknown;

      // Several gateways answer 200 with a failure in the body, so a 2xx alone
      // is not treated as success.
      if (looksLikeFailure(body)) {
        throw new Error(`Gateway rejected the message: ${JSON.stringify(body).slice(0, 300)}`);
      }

      return { providerMessageId: extractMessageId(body), raw: body };
    } catch (error) {
      const detail =
        error instanceof AxiosError
          ? `${error.code ?? error.response?.status ?? 'request failed'}: ${JSON.stringify(error.response?.data ?? error.message).slice(0, 300)}`
          : error instanceof Error
            ? error.message
            : String(error);

      this.logger.warn(`Send to ${maskPhone(phone)} failed — ${detail}`);
      // The cause is kept so a queue retry's stack still points at the real
      // transport failure rather than just this summary.
      throw new Error(detail, { cause: error });
    }
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}

function looksLikeFailure(body: unknown): boolean {
  if (typeof body === 'string') {
    return /error|fail|invalid|insufficient/i.test(body);
  }
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    const status = String(record.status ?? record.Status ?? record.response_code ?? '').toLowerCase();
    if (status && /error|fail|invalid/.test(status)) return true;
    if (record.error) return true;
  }
  return false;
}

function extractMessageId(body: unknown): string | undefined {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    for (const key of ['message_id', 'messageId', 'smsid', 'sms_id', 'id', 'reference_id']) {
      const value = record[key];
      if (typeof value === 'string' || typeof value === 'number') return String(value);
    }
  }
  return undefined;
}
