import { Injectable } from '@nestjs/common';
import { SettingsService } from '@modules/settings/settings.service';
import {
  BusinessCalendarOptions,
  BusinessDate,
  DateRange,
  RangeKey,
  ResolvedRange,
  businessDateOf,
  businessRangeToInstants,
  currentBusinessDate,
  formatInTimezone,
  resolveRange,
  toDateColumn,
} from '@common/utils/date.util';

/**
 * The application's view of "what day is it". Wraps the pure date helpers with
 * the live settings (timezone, business day start hour, week start day) so no
 * service has to plumb those through by hand.
 */
@Injectable()
export class BusinessCalendarService {
  constructor(private readonly settings: SettingsService) {}

  async options(): Promise<BusinessCalendarOptions> {
    const all = await this.settings.getAll();
    return {
      timezone: all.businessTimezone,
      businessDayStartHour: all.businessDayStartHour,
      weekStartDay: all.weekStartDay,
    };
  }

  /** The business date right now. */
  async today(now: Date = new Date()): Promise<BusinessDate> {
    return currentBusinessDate(await this.options(), now);
  }

  /** The business date an arbitrary instant belongs to. */
  async businessDateOf(instant: Date): Promise<BusinessDate> {
    return businessDateOf(instant, await this.options());
  }

  /** Today as the UTC-midnight `Date` a `@db.Date` column expects. */
  async todayColumn(now: Date = new Date()): Promise<Date> {
    return toDateColumn(await this.today(now));
  }

  async resolveRange(key: RangeKey, custom?: Partial<DateRange>, now: Date = new Date()): Promise<ResolvedRange> {
    return resolveRange(key, await this.options(), custom, now);
  }

  async rangeToInstants(range: DateRange): Promise<{ startAt: Date; endAt: Date }> {
    return businessRangeToInstants(range, await this.options());
  }

  async timezone(): Promise<string> {
    return this.settings.get('businessTimezone');
  }

  /** Render a UTC instant in the business timezone, for receipts and exports. */
  async format(instant: Date, format?: string): Promise<string> {
    return formatInTimezone(instant, await this.timezone(), format);
  }
}
