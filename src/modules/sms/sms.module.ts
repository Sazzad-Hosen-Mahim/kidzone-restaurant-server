import { HttpModule } from '@nestjs/axios';
import { BullModule } from '@nestjs/bullmq';
import { DynamicModule, Global, Module } from '@nestjs/common';
import { AppConfigService } from '@config/app-config.service';
import { SMS_PROVIDER } from './sms-provider.interface';
import { SMS_QUEUE_NAME } from './sms.constants';
import { SmsService } from './sms.service';
import { SmsProcessor } from './sms.processor';
import { SmsTemplatesService } from './sms-templates.service';
import { ConsoleSmsProvider } from './providers/console-sms.provider';
import { HttpSmsProvider } from './providers/http-sms.provider';

/**
 * Global because both sections, the check-in flow and the scheduled jobs send
 * SMS.
 *
 * The queue is only registered when `ENABLE_QUEUE` is true, so the test suite
 * and a single-process deployment can run without Redis; `SmsService` then
 * delivers inline.
 */
@Global()
@Module({})
export class SmsModule {
  static register(): DynamicModule {
    const queueEnabled = process.env.ENABLE_QUEUE !== 'false';

    return {
      module: SmsModule,
      imports: [
        HttpModule.register({ timeout: 15_000, maxRedirects: 2 }),
        ...(queueEnabled
          ? [
              BullModule.registerQueueAsync({
                name: SMS_QUEUE_NAME,
                inject: [AppConfigService],
                useFactory: (config: AppConfigService) => ({
                  connection: config.redisConnection,
                  defaultJobOptions: {
                    attempts: 3,
                    backoff: { type: 'exponential', delay: 5_000 },
                  },
                }),
              }),
            ]
          : []),
      ],
      providers: [
        {
          provide: SMS_PROVIDER,
          inject: [AppConfigService, ConsoleSmsProvider, HttpSmsProvider],
          useFactory: (config: AppConfigService, console: ConsoleSmsProvider, http: HttpSmsProvider) =>
            config.get('SMS_PROVIDER') === 'http' ? http : console,
        },
        ConsoleSmsProvider,
        HttpSmsProvider,
        SmsService,
        SmsTemplatesService,
        ...(queueEnabled ? [SmsProcessor] : []),
      ],
      exports: [SmsService, SmsTemplatesService, SMS_PROVIDER, ...(queueEnabled ? [BullModule] : [])],
    };
  }
}
