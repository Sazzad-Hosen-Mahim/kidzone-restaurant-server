import dayjs, { Dayjs } from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

export { dayjs };

/** A business date, always `YYYY-MM-DD`. */
export type BusinessDate = string;

export const BUSINESS_DATE_FORMAT = 'YYYY-MM-DD';

export type RangeKey =
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'last_week'
  | 'this_month'
  | 'last_month'
  | 'this_year'
  | 'custom';

export interface DateRange {
  from: BusinessDate;
  to: BusinessDate;
}

export interface ResolvedRange extends DateRange {
  key: RangeKey;
  /** The equivalent preceding period, used for percentage-change comparisons. */
  previous: DateRange;
}

export interface BusinessCalendarOptions {
  timezone: string;
  /** Trade before this local hour is attributed to the previous business day. */
  businessDayStartHour: number;
  /** 0 = Sunday … 6 = Saturday. Bangladesh convention is 6. */
  weekStartDay: number;
}

// ---------------------------------------------------------------------------
// Business date
// ---------------------------------------------------------------------------

/**
 * The business date an instant belongs to.
 *
 * The instant is read in the business timezone and then shifted back by
 * `businessDayStartHour`, so with a start hour of 4 a sale rung up at 02:30 on
 * the 23rd still counts toward the 22nd.
 */
export function businessDateOf(
  instant: Date | string | Dayjs,
  opts: Pick<BusinessCalendarOptions, 'timezone' | 'businessDayStartHour'>,
): BusinessDate {
  return dayjs(instant)
    .tz(opts.timezone)
    .subtract(opts.businessDayStartHour, 'hour')
    .format(BUSINESS_DATE_FORMAT);
}

/** The current business date. */
export function currentBusinessDate(
  opts: Pick<BusinessCalendarOptions, 'timezone' | 'businessDayStartHour'>,
  now: Date = new Date(),
): BusinessDate {
  return businessDateOf(now, opts);
}

/**
 * The UTC-midnight `Date` that Prisma writes into a `@db.Date` column.
 * Postgres stores only the date part, so pinning to UTC midnight keeps the
 * stored day identical to the string we computed.
 */
export function toDateColumn(date: BusinessDate): Date {
  assertBusinessDate(date);
  return new Date(`${date}T00:00:00.000Z`);
}

/** Read a `@db.Date` column back as a `YYYY-MM-DD` string. */
export function fromDateColumn(value: Date | string): BusinessDate {
  if (typeof value === 'string') return value.slice(0, 10);
  return dayjs.utc(value).format(BUSINESS_DATE_FORMAT);
}

export function isBusinessDate(value: unknown): value is BusinessDate {
  return typeof value === 'string' && dayjs(value, BUSINESS_DATE_FORMAT, true).isValid();
}

export function assertBusinessDate(value: string): asserts value is BusinessDate {
  if (!isBusinessDate(value)) {
    throw new Error(`Expected a ${BUSINESS_DATE_FORMAT} business date, received "${value}"`);
  }
}

// ---------------------------------------------------------------------------
// Business date arithmetic (pure string in, string out)
// ---------------------------------------------------------------------------

export function addDays(date: BusinessDate, days: number): BusinessDate {
  assertBusinessDate(date);
  return dayjs.utc(date).add(days, 'day').format(BUSINESS_DATE_FORMAT);
}

export function diffDays(from: BusinessDate, to: BusinessDate): number {
  assertBusinessDate(from);
  assertBusinessDate(to);
  return dayjs.utc(to).diff(dayjs.utc(from), 'day');
}

export function compareDates(a: BusinessDate, b: BusinessDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function minDate(a: BusinessDate, b: BusinessDate): BusinessDate {
  return a <= b ? a : b;
}

export function maxDate(a: BusinessDate, b: BusinessDate): BusinessDate {
  return a >= b ? a : b;
}

/** Inclusive day count between two business dates. */
export function inclusiveDayCount(range: DateRange): number {
  return diffDays(range.from, range.to) + 1;
}

/** The first day of the week containing `date`, honouring `weekStartDay`. */
export function startOfWeek(date: BusinessDate, weekStartDay: number): BusinessDate {
  assertBusinessDate(date);
  const d = dayjs.utc(date);
  const offset = (d.day() - weekStartDay + 7) % 7;
  return d.subtract(offset, 'day').format(BUSINESS_DATE_FORMAT);
}

export function endOfWeek(date: BusinessDate, weekStartDay: number): BusinessDate {
  return addDays(startOfWeek(date, weekStartDay), 6);
}

export function startOfMonth(date: BusinessDate): BusinessDate {
  assertBusinessDate(date);
  return dayjs.utc(date).startOf('month').format(BUSINESS_DATE_FORMAT);
}

export function endOfMonth(date: BusinessDate): BusinessDate {
  assertBusinessDate(date);
  return dayjs.utc(date).endOf('month').format(BUSINESS_DATE_FORMAT);
}

export function startOfYear(date: BusinessDate): BusinessDate {
  assertBusinessDate(date);
  return dayjs.utc(date).startOf('year').format(BUSINESS_DATE_FORMAT);
}

export function endOfYear(date: BusinessDate): BusinessDate {
  assertBusinessDate(date);
  return dayjs.utc(date).endOf('year').format(BUSINESS_DATE_FORMAT);
}

/** Every business date in an inclusive range. */
export function eachDate(range: DateRange): BusinessDate[] {
  const out: BusinessDate[] = [];
  for (let d = range.from; d <= range.to; d = addDays(d, 1)) out.push(d);
  return out;
}

// ---------------------------------------------------------------------------
// Report ranges
// ---------------------------------------------------------------------------

/**
 * Turn a report `range` key into concrete business dates, plus the equivalent
 * preceding period used for the percentage-change comparison.
 *
 * In-progress periods (`this_week`, `this_month`, `this_year`) are clipped at
 * today, and their comparison period covers the same number of elapsed days in
 * the previous week/month/year — so "this month" is compared against the same
 * stretch of last month, not against a full month.
 */
export function resolveRange(
  key: RangeKey,
  opts: BusinessCalendarOptions,
  custom?: Partial<DateRange>,
  now: Date = new Date(),
): ResolvedRange {
  const today = currentBusinessDate(opts, now);
  const { weekStartDay } = opts;

  let from: BusinessDate;
  let to: BusinessDate;
  let previous: DateRange;

  switch (key) {
    case 'today': {
      from = to = today;
      previous = { from: addDays(today, -1), to: addDays(today, -1) };
      break;
    }
    case 'yesterday': {
      from = to = addDays(today, -1);
      previous = { from: addDays(today, -2), to: addDays(today, -2) };
      break;
    }
    case 'this_week': {
      from = startOfWeek(today, weekStartDay);
      to = today;
      const prevStart = addDays(from, -7);
      previous = { from: prevStart, to: addDays(prevStart, diffDays(from, to)) };
      break;
    }
    case 'last_week': {
      from = addDays(startOfWeek(today, weekStartDay), -7);
      to = addDays(from, 6);
      previous = { from: addDays(from, -7), to: addDays(to, -7) };
      break;
    }
    case 'this_month': {
      from = startOfMonth(today);
      to = today;
      const prevFrom = startOfMonth(addDays(from, -1));
      const prevTo = minDate(addDays(prevFrom, diffDays(from, to)), endOfMonth(prevFrom));
      previous = { from: prevFrom, to: prevTo };
      break;
    }
    case 'last_month': {
      const anchor = addDays(startOfMonth(today), -1);
      from = startOfMonth(anchor);
      to = endOfMonth(anchor);
      const prevAnchor = addDays(from, -1);
      previous = { from: startOfMonth(prevAnchor), to: endOfMonth(prevAnchor) };
      break;
    }
    case 'this_year': {
      from = startOfYear(today);
      to = today;
      const prevFrom = dayjs.utc(from).subtract(1, 'year').format(BUSINESS_DATE_FORMAT);
      const prevTo = dayjs.utc(to).subtract(1, 'year').format(BUSINESS_DATE_FORMAT);
      previous = { from: prevFrom, to: prevTo };
      break;
    }
    case 'custom': {
      if (!custom?.from || !custom?.to) {
        throw new Error('A custom range requires both "from" and "to"');
      }
      assertBusinessDate(custom.from);
      assertBusinessDate(custom.to);
      if (custom.from > custom.to) {
        throw new Error('"from" must not be after "to"');
      }
      from = custom.from;
      to = custom.to;
      const length = inclusiveDayCount({ from, to });
      previous = { from: addDays(from, -length), to: addDays(from, -1) };
      break;
    }
    default: {
      const exhaustive: never = key;
      throw new Error(`Unsupported range "${exhaustive as string}"`);
    }
  }

  return { key, from, to, previous };
}

/** Percentage change from `previous` to `current`, rounded to one decimal. */
export function percentageChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null; // null renders as "new" in the UI
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

// ---------------------------------------------------------------------------
// Instant boundaries for a business-date range
// ---------------------------------------------------------------------------

/**
 * The UTC instant range covering a span of business dates, used where a query
 * filters on a timestamp rather than on a stored `businessDate` column.
 */
export function businessRangeToInstants(
  range: DateRange,
  opts: Pick<BusinessCalendarOptions, 'timezone' | 'businessDayStartHour'>,
): { startAt: Date; endAt: Date } {
  const startAt = dayjs
    .tz(`${range.from} 00:00:00`, opts.timezone)
    .add(opts.businessDayStartHour, 'hour')
    .toDate();
  const endAt = dayjs
    .tz(`${range.to} 00:00:00`, opts.timezone)
    .add(1, 'day')
    .add(opts.businessDayStartHour, 'hour')
    .toDate();
  return { startAt, endAt };
}

/** Render a UTC instant in the business timezone, e.g. for receipts. */
export function formatInTimezone(instant: Date, tz: string, format = 'DD MMM YYYY, hh:mm A'): string {
  return dayjs(instant).tz(tz).format(format);
}

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** Age in whole years at `on` (defaults to today), from a date of birth. */
export function ageInYears(dateOfBirth: Date | string, on: Date | string = new Date()): number {
  const dob = typeof dateOfBirth === 'string' ? dayjs.utc(dateOfBirth.slice(0, 10)) : dayjs.utc(dateOfBirth);
  const at = typeof on === 'string' ? dayjs.utc(on.slice(0, 10)) : dayjs.utc(dayjs(on).format(BUSINESS_DATE_FORMAT));
  return Math.max(0, at.diff(dob, 'year'));
}
