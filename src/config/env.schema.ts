import { z } from 'zod';
import { parseDurationToSeconds } from '@common/utils/duration.util';

/**
 * Every environment variable the application reads, validated once at startup.
 * A missing or malformed variable aborts the boot with a readable list of
 * problems rather than failing later at an arbitrary request.
 */

const booleanish = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? defaultValue : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const intWithin = (min: number, max: number, defaultValue: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? defaultValue : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const csv = (defaultValue: string[]) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v.trim() === ''
        ? defaultValue
        : v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
    );

/** A token lifetime such as `15m`, `7d` or a bare number of seconds. */
const duration = (defaultValue: string) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? defaultValue : v.trim()))
    .refine(
      (v) => {
        try {
          return parseDurationToSeconds(v) > 0;
        } catch {
          return false;
        }
      },
      { message: 'must be a positive duration such as 15m, 24h or 7d' },
    );

const jsonObject = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (!v || v.trim() === '') return {} as Record<string, string>;
    try {
      const parsed = JSON.parse(v);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      return parsed as Record<string, string>;
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a JSON object' });
      return z.NEVER;
    }
  });

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: intWithin(1, 65535, 3000),
    API_PREFIX: z.string().default('api/v1'),
    CORS_ORIGINS: csv(['http://localhost:5173']),

    DATABASE_URL: z.string().url(),
    TEST_DATABASE_URL: z.string().url().optional(),

    REDIS_HOST: z.string().default('localhost'),
    REDIS_PORT: intWithin(1, 65535, 6379),
    REDIS_PASSWORD: z.string().optional(),
    REDIS_DB: intWithin(0, 15, 0),

    JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
    JWT_REFRESH_SECRET: z.string().min(32, 'must be at least 32 characters'),
    JWT_ACCESS_TTL: duration('15m'),
    JWT_REFRESH_TTL: duration('7d'),
    REFRESH_COOKIE_NAME: z.string().default('kz_refresh'),
    COOKIE_SECURE: booleanish(false),
    COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),
    COOKIE_DOMAIN: z
      .string()
      .optional()
      .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined)),

    BUSINESS_TIMEZONE: z.string().default('Asia/Dhaka'),
    BUSINESS_DAY_START_HOUR: intWithin(0, 23, 0),
    WEEK_START_DAY: intWithin(0, 6, 6),
    MAX_STAFF_DISCOUNT_PERCENT: intWithin(0, 100, 10),

    THROTTLE_ENABLED: booleanish(true),
    THROTTLE_TTL_SECONDS: intWithin(1, 86400, 60),
    THROTTLE_LIMIT: intWithin(1, 100000, 120),

    SMS_PROVIDER: z.enum(['console', 'http']).default('console'),
    SMS_HTTP_URL: z.string().optional(),
    SMS_HTTP_METHOD: z.enum(['GET', 'POST']).default('POST'),
    SMS_HTTP_API_KEY: z.string().optional(),
    SMS_HTTP_SENDER_ID: z.string().optional(),
    SMS_PARAM_API_KEY: z.string().default('api_key'),
    SMS_PARAM_SENDER_ID: z.string().default('senderid'),
    SMS_PARAM_PHONE: z.string().default('msisdn'),
    SMS_PARAM_MESSAGE: z.string().default('sms'),
    SMS_EXTRA_PARAMS: jsonObject,
    SMS_TIMEOUT_MS: intWithin(100, 120000, 15000),

    ENABLE_CRON: booleanish(true),
    ENABLE_QUEUE: booleanish(true),

    BACKUP_ENABLED: booleanish(false),
    BACKUP_DIR: z.string().default('./backups'),
    BACKUP_PG_DUMP_PATH: z.string().default('pg_dump'),
    BACKUP_PG_RESTORE_PATH: z.string().default('pg_restore'),
    BACKUP_KEEP_DAILY: intWithin(1, 3650, 30),
    BACKUP_KEEP_MONTHLY: intWithin(1, 1200, 12),
    BACKUP_S3_ENABLED: booleanish(false),
    BACKUP_S3_ENDPOINT: z.string().optional(),
    BACKUP_S3_REGION: z.string().default('auto'),
    BACKUP_S3_BUCKET: z.string().optional(),
    BACKUP_S3_ACCESS_KEY_ID: z.string().optional(),
    BACKUP_S3_SECRET_ACCESS_KEY: z.string().optional(),
    BACKUP_S3_PREFIX: z.string().default('kidzone/'),
  })
  .superRefine((env, ctx) => {
    if (env.SMS_PROVIDER === 'http' && !env.SMS_HTTP_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SMS_HTTP_URL'],
        message: 'is required when SMS_PROVIDER=http',
      });
    }
    if (env.BACKUP_S3_ENABLED) {
      for (const key of ['BACKUP_S3_BUCKET', 'BACKUP_S3_ACCESS_KEY_ID', 'BACKUP_S3_SECRET_ACCESS_KEY'] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: 'is required when BACKUP_S3_ENABLED=true',
          });
        }
      }
    }
    if (env.NODE_ENV === 'production' && !env.COOKIE_SECURE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['COOKIE_SECURE'],
        message: 'must be true in production so the refresh cookie is never sent over http',
      });
    }
  });

export type AppEnv = z.infer<typeof envSchema>;

/** Used by ConfigModule.validate — throws with every problem listed at once. */
export function validateEnv(raw: Record<string, unknown>): AppEnv {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}
