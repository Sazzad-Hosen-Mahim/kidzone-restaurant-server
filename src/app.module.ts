import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppThrottlerGuard } from '@common/guards/app-throttler.guard';
import { AppConfigModule } from '@config/config.module';
import { AppConfigService } from '@config/app-config.service';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { RolesGuard } from '@common/guards/roles.guard';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from '@modules/redis/redis.module';
import { HealthModule } from '@modules/health/health.module';
import { AuditModule } from '@modules/audit/audit.module';
import { SettingsModule } from '@modules/settings/settings.module';
import { AuthModule } from '@modules/auth/auth.module';
import { UsersModule } from '@modules/users/users.module';
import { SmsModule } from '@modules/sms/sms.module';
import { PaymentsModule } from '@modules/payments/payments.module';
import { ClosingModule } from '@modules/closing/closing.module';
import { CustomersModule } from '@modules/customers/customers.module';
import { KidZoneModule } from '@modules/kidzone/kidzone.module';
import { RestaurantModule } from '@modules/restaurant/restaurant.module';
import { ExportsModule } from '@modules/exports/exports.module';
import { ReceiptsModule } from '@modules/receipts/receipts.module';
import { JobsModule } from '@modules/jobs/jobs.module';
import { ReportsModule } from '@modules/reports/reports.module';
import { DashboardModule } from '@modules/dashboard/dashboard.module';

@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    RedisModule,
    ThrottlerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        throttlers: [
          {
            name: 'default',
            ttl: config.get('THROTTLE_TTL_SECONDS') * 1000,
            limit: config.get('THROTTLE_LIMIT'),
          },
        ],
        // Read per request rather than captured once, so the e2e harness can
        // switch rate limiting off for suites that log in dozens of times and
        // back on for the suite that asserts the limit.
        skipIf: () => process.env.THROTTLE_ENABLED === 'false',
      }),
    }),
    AuditModule,
    SettingsModule,
    AuthModule,
    UsersModule,
    SmsModule.register(),
    PaymentsModule,
    ClosingModule,
    CustomersModule,
    KidZoneModule,
    RestaurantModule,
    ExportsModule,
    ReceiptsModule,
    JobsModule,
    ReportsModule,
    DashboardModule,
    HealthModule,
  ],
  providers: [
    // Order matters: rate limiting first, then authentication, then the role
    // check. RolesGuard is fail-closed, so any authenticated route without a
    // @Roles() decorator is denied rather than left open.
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
