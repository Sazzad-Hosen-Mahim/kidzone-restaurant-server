import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppConfigService } from '@config/app-config.service';

const DESCRIPTION = `
REST API for a combined **Kid Zone** (indoor play area) and **Restaurant** business in Bangladesh.

### Response envelope
Every successful response is \`{ "data": …, "meta": { … } }\`. \`meta\` always carries a
\`timestamp\`, and on list endpoints it also carries \`page\`, \`limit\`, \`total\`,
\`totalPages\`, \`hasNextPage\` and \`hasPreviousPage\`.

Errors are \`{ "statusCode", "error", "message", "details?" }\`, where \`error\` is a stable
machine-readable code such as \`MEMBERSHIP_EXPIRED\` or \`DAY_ALREADY_CLOSED\`.

### Money
**Every amount in this API is an integer number of poisha (1 BDT = 100 poisha).**
A price of ৳250.00 is sent and returned as \`25000\`. There are no floating point
amounts anywhere in the API.

### Dates and the business day
Timestamps are ISO-8601 UTC. A \`businessDate\` is a \`YYYY-MM-DD\` calendar date computed
in the business timezone (\`Asia/Dhaka\` by default) honouring \`businessDayStartHour\`:
with a start hour of 4, a sale rung up at 02:30 counts toward the previous day.
Weekly report boundaries use the configurable \`weekStartDay\` (Saturday by default).

### Phone numbers
Sent as \`01XXXXXXXXX\`, \`8801XXXXXXXXX\` or \`+8801XXXXXXXXX\`; always stored and returned
as E.164 (\`+8801XXXXXXXXX\`).

### Authentication
\`POST /auth/login\` returns a 15-minute access token in the body and sets a rotating
7-day refresh token in an httpOnly cookie. Send the access token as
\`Authorization: Bearer <token>\`. Call \`POST /auth/refresh\` with the cookie to rotate.
`;

export function setupSwagger(app: INestApplication, config: AppConfigService): void {
  const builder = new DocumentBuilder()
    .setTitle('Kid Zone + Restaurant API')
    .setDescription(DESCRIPTION)
    .setVersion('1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Access token from POST /auth/login' },
      'access-token',
    )
    .addCookieAuth(config.get('REFRESH_COOKIE_NAME'), { type: 'apiKey', in: 'cookie' }, 'refresh-cookie')
    .addTag('Auth', 'Login, refresh, logout, profile and password change')
    .addTag('Users', 'Staff accounts (ADMIN)')
    .addTag('Settings', 'Business settings (ADMIN)')
    .addTag('Audit', 'Append-only audit trail (ADMIN)')
    .addTag('Customers', 'Guardians shared by both sections, and their children')
    .addTag('Kid Zone / Plans', 'Membership and session plans')
    .addTag('Kid Zone / Sales', 'Selling plans, renewals and voids')
    .addTag('Kid Zone / Memberships', 'Active memberships and expiry')
    .addTag('Kid Zone / Check-in', 'OTP, QR and manual-override gate check-in')
    .addTag('Kid Zone / Visits', 'Live session timer and check-out')
    .addTag('Restaurant / Menu', 'Categories and menu items')
    .addTag('Restaurant / Orders', 'Point-of-sale orders and voids')
    .addTag('Receipts', 'Receipt and gatepass JSON, plus 80mm thermal PDFs')
    .addTag('Closing', 'Day-end cash closing and locking')
    .addTag('Reports', 'Kid Zone, restaurant and cross-section reporting')
    .addTag('Dashboard', 'Combined at-a-glance dashboard')
    .addTag('Jobs', 'SMS delivery log and manual runs of the scheduled jobs (ADMIN)')
    .addTag('Health', 'Liveness and readiness');

  for (const origin of config.corsOrigins) builder.addServer(origin);

  const document = SwaggerModule.createDocument(app, builder.build(), {
    operationIdFactory: (controllerKey, methodKey) => `${controllerKey.replace(/Controller$/, '')}_${methodKey}`,
  });

  SwaggerModule.setup('api/docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
      docExpansion: 'none',
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
      withCredentials: true,
    },
    customSiteTitle: 'Kid Zone + Restaurant API',
    jsonDocumentUrl: 'api/docs-json',
  });
}
