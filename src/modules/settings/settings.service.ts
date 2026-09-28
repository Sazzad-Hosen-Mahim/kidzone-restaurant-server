import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AppConfigService } from '@config/app-config.service';
import { DomainException } from '@common/exceptions/domain.exception';
import { SETTINGS_SCHEMA, SETTING_KEYS, SettingKey, SettingsMap, defaultSettings } from './settings.constants';

/**
 * Typed key/value settings backed by the `settings` table.
 *
 * Values are cached in memory for a few seconds: every sale reads several
 * settings, and a cashier changing VAT does not need sub-second propagation.
 * Any write clears the cache immediately, so a change is visible at once on the
 * instance that made it.
 */
@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly logger = new Logger(SettingsService.name);
  private static readonly CACHE_TTL_MS = 5_000;

  private cache: SettingsMap | null = null;
  private cachedAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureDefaults();
  }

  /**
   * Writes any missing key with its default. Runs at boot and from the seed, so
   * an upgrade that adds a setting does not need a data migration.
   */
  async ensureDefaults(): Promise<void> {
    const defaults = this.defaultsWithEnvOverrides();
    const existing = await this.prisma.setting.findMany({ select: { key: true } });
    const known = new Set(existing.map((s) => s.key));
    const missing = SETTING_KEYS.filter((key) => !known.has(key));

    if (missing.length === 0) return;

    await this.prisma.setting.createMany({
      data: missing.map((key) => ({
        key,
        value: defaults[key] as Prisma.InputJsonValue,
        description: SETTINGS_SCHEMA[key].description,
      })),
      skipDuplicates: true,
    });
    this.invalidate();
    this.logger.log(`Seeded ${missing.length} missing setting(s): ${missing.join(', ')}`);
  }

  /** Every setting, with defaults filling any gap. */
  async getAll(): Promise<SettingsMap> {
    if (this.cache && Date.now() - this.cachedAt < SettingsService.CACHE_TTL_MS) {
      return this.cache;
    }

    const rows = await this.prisma.setting.findMany();
    const resolved = this.defaultsWithEnvOverrides();

    for (const row of rows) {
      if (!isSettingKey(row.key)) continue;
      const parsed = SETTINGS_SCHEMA[row.key].schema.safeParse(row.value);
      if (parsed.success) {
        (resolved as Record<string, unknown>)[row.key] = parsed.data;
      } else {
        // A malformed stored value must not take the application down; fall
        // back to the default and make the problem loud.
        this.logger.error(`Setting "${row.key}" is invalid and was ignored: ${parsed.error.issues[0]?.message}`);
      }
    }

    this.cache = resolved;
    this.cachedAt = Date.now();
    return resolved;
  }

  async get<K extends SettingKey>(key: K): Promise<SettingsMap[K]> {
    const all = await this.getAll();
    return all[key];
  }

  /** Validates a patch and returns `{ before, after }` for the audit entry. */
  async update(rawPatch: Record<string, unknown>): Promise<{ before: Partial<SettingsMap>; after: SettingsMap }> {
    // class-transformer materialises every declared property, so keys the caller
    // never sent arrive as `undefined`. Those mean "leave alone", not "set to
    // undefined", and must not reach validation.
    const patch = Object.fromEntries(Object.entries(rawPatch).filter(([, value]) => value !== undefined));
    const keys = Object.keys(patch);
    if (keys.length === 0) {
      throw new BadRequestException('At least one setting must be provided');
    }

    const unknownKeys = keys.filter((k) => !isSettingKey(k));
    if (unknownKeys.length > 0) {
      throw new BadRequestException(`Unknown setting key(s): ${unknownKeys.join(', ')}`);
    }

    const validated: Array<{ key: SettingKey; value: unknown }> = [];
    const problems: Record<string, string[]> = {};

    for (const key of keys as SettingKey[]) {
      const result = SETTINGS_SCHEMA[key].schema.safeParse(patch[key]);
      if (result.success) {
        validated.push({ key, value: result.data });
      } else {
        problems[key] = result.error.issues.map((i) => i.message);
      }
    }

    if (Object.keys(problems).length > 0) {
      throw new DomainException('SETTINGS_VALIDATION_FAILED', 'One or more settings are invalid', 400, problems);
    }

    const current = await this.getAll();
    const before: Partial<SettingsMap> = {};
    for (const { key } of validated) {
      (before as Record<string, unknown>)[key] = current[key];
    }

    await this.prisma.$transaction(
      validated.map(({ key, value }) =>
        this.prisma.setting.upsert({
          where: { key },
          create: { key, value: value as Prisma.InputJsonValue, description: SETTINGS_SCHEMA[key].description },
          update: { value: value as Prisma.InputJsonValue },
        }),
      ),
    );

    this.invalidate();
    return { before, after: await this.getAll() };
  }

  /** Drops the cache. Called after any write. */
  invalidate(): void {
    this.cache = null;
    this.cachedAt = 0;
  }

  /**
   * Defaults, with the handful of values that also exist as environment
   * variables taking the env value. This makes a fresh deployment pick up
   * `BUSINESS_TIMEZONE` and friends from the container configuration; once the
   * row exists, the stored setting wins.
   */
  private defaultsWithEnvOverrides(): SettingsMap {
    const defaults = defaultSettings();
    return {
      ...defaults,
      businessTimezone: this.config.get('BUSINESS_TIMEZONE'),
      businessDayStartHour: this.config.get('BUSINESS_DAY_START_HOUR'),
      weekStartDay: this.config.get('WEEK_START_DAY'),
      maxStaffDiscountPercent: this.config.get('MAX_STAFF_DISCOUNT_PERCENT'),
    };
  }
}

function isSettingKey(key: string): key is SettingKey {
  return (SETTING_KEYS as string[]).includes(key);
}
