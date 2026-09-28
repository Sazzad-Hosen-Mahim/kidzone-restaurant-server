import {
  addDays,
  ageInYears,
  businessDateOf,
  businessRangeToInstants,
  diffDays,
  eachDate,
  endOfWeek,
  inclusiveDayCount,
  percentageChange,
  resolveRange,
  startOfWeek,
  toDateColumn,
} from './date.util';

const DHAKA = 'Asia/Dhaka';

// 2026-09-22 is a Tuesday, which makes the Saturday week start visible.
const NOON_DHAKA = new Date('2026-09-22T06:00:00.000Z');

const saturdayWeek = { timezone: DHAKA, businessDayStartHour: 0, weekStartDay: 6 } as const;

describe('businessDateOf', () => {
  it('reads the instant in the business timezone, not UTC', () => {
    // 18:30 UTC is already 00:30 the next day in Dhaka (UTC+6).
    expect(businessDateOf('2026-09-22T18:30:00.000Z', { timezone: DHAKA, businessDayStartHour: 0 })).toBe('2026-09-23');
    expect(businessDateOf('2026-09-22T02:00:00.000Z', { timezone: DHAKA, businessDayStartHour: 0 })).toBe('2026-09-22');
  });

  it('attributes after-midnight trade to the previous day when the day starts at 04:00', () => {
    const opts = { timezone: DHAKA, businessDayStartHour: 4 };
    // 00:30 Dhaka on the 23rd, before the 04:00 cut-off -> still the 22nd.
    expect(businessDateOf('2026-09-22T18:30:00.000Z', opts)).toBe('2026-09-22');
    // 03:59 Dhaka on the 23rd -> still the 22nd.
    expect(businessDateOf('2026-09-22T21:59:00.000Z', opts)).toBe('2026-09-22');
    // 04:00 Dhaka on the 23rd -> the new business day has started.
    expect(businessDateOf('2026-09-22T22:00:00.000Z', opts)).toBe('2026-09-23');
  });

  it('is unaffected by the start hour during normal trading hours', () => {
    const noon = '2026-09-22T06:00:00.000Z';
    expect(businessDateOf(noon, { timezone: DHAKA, businessDayStartHour: 0 })).toBe('2026-09-22');
    expect(businessDateOf(noon, { timezone: DHAKA, businessDayStartHour: 4 })).toBe('2026-09-22');
  });
});

describe('business date arithmetic', () => {
  it('adds and diffs days', () => {
    expect(addDays('2026-09-22', 1)).toBe('2026-09-23');
    expect(addDays('2026-09-22', -1)).toBe('2026-09-21');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01'); // 2026 is not a leap year
    expect(diffDays('2026-09-01', '2026-09-22')).toBe(21);
  });

  it('counts an inclusive range', () => {
    expect(inclusiveDayCount({ from: '2026-09-22', to: '2026-09-22' })).toBe(1);
    expect(inclusiveDayCount({ from: '2026-09-01', to: '2026-09-30' })).toBe(30);
  });

  it('enumerates a range', () => {
    expect(eachDate({ from: '2026-09-20', to: '2026-09-22' })).toEqual(['2026-09-20', '2026-09-21', '2026-09-22']);
  });

  it('rejects a malformed business date', () => {
    expect(() => addDays('22-09-2026', 1)).toThrow(/business date/);
    expect(() => toDateColumn('2026-13-01')).toThrow(/business date/);
  });

  it('maps a business date to the UTC midnight Prisma writes into a DATE column', () => {
    expect(toDateColumn('2026-09-22').toISOString()).toBe('2026-09-22T00:00:00.000Z');
  });
});

describe('startOfWeek', () => {
  it('uses Saturday when weekStartDay is 6 (the Bangladesh default)', () => {
    expect(startOfWeek('2026-09-22', 6)).toBe('2026-09-19'); // Tuesday -> previous Saturday
    expect(startOfWeek('2026-09-19', 6)).toBe('2026-09-19'); // Saturday is its own start
    expect(endOfWeek('2026-09-22', 6)).toBe('2026-09-25');
  });

  it('uses Sunday when weekStartDay is 0', () => {
    expect(startOfWeek('2026-09-22', 0)).toBe('2026-09-20');
  });

  it('uses Monday when weekStartDay is 1', () => {
    expect(startOfWeek('2026-09-22', 1)).toBe('2026-09-21');
  });
});

describe('resolveRange', () => {
  it('resolves today and yesterday against the previous day', () => {
    expect(resolveRange('today', saturdayWeek, undefined, NOON_DHAKA)).toMatchObject({
      from: '2026-09-22',
      to: '2026-09-22',
      previous: { from: '2026-09-21', to: '2026-09-21' },
    });
    expect(resolveRange('yesterday', saturdayWeek, undefined, NOON_DHAKA)).toMatchObject({
      from: '2026-09-21',
      to: '2026-09-21',
      previous: { from: '2026-09-20', to: '2026-09-20' },
    });
  });

  it('clips this_week at today and compares the same elapsed days of last week', () => {
    expect(resolveRange('this_week', saturdayWeek, undefined, NOON_DHAKA)).toMatchObject({
      from: '2026-09-19',
      to: '2026-09-22',
      previous: { from: '2026-09-12', to: '2026-09-15' },
    });
  });

  it('resolves a full last_week using the configured week start', () => {
    expect(resolveRange('last_week', saturdayWeek, undefined, NOON_DHAKA)).toMatchObject({
      from: '2026-09-12',
      to: '2026-09-18',
      previous: { from: '2026-09-05', to: '2026-09-11' },
    });

    // Same instant, Sunday-start week.
    expect(
      resolveRange('last_week', { ...saturdayWeek, weekStartDay: 0 }, undefined, NOON_DHAKA),
    ).toMatchObject({ from: '2026-09-13', to: '2026-09-19' });
  });

  it('compares this_month against the same stretch of last month', () => {
    expect(resolveRange('this_month', saturdayWeek, undefined, NOON_DHAKA)).toMatchObject({
      from: '2026-09-01',
      to: '2026-09-22',
      previous: { from: '2026-08-01', to: '2026-08-22' },
    });
  });

  it('clamps the comparison period to a shorter previous month', () => {
    // 31 March compared against February, which has only 28 days in 2026.
    const march31 = new Date('2026-03-31T06:00:00.000Z');
    expect(resolveRange('this_month', saturdayWeek, undefined, march31)).toMatchObject({
      from: '2026-03-01',
      to: '2026-03-31',
      previous: { from: '2026-02-01', to: '2026-02-28' },
    });
  });

  it('resolves last_month and this_year', () => {
    expect(resolveRange('last_month', saturdayWeek, undefined, NOON_DHAKA)).toMatchObject({
      from: '2026-08-01',
      to: '2026-08-31',
      previous: { from: '2026-07-01', to: '2026-07-31' },
    });
    expect(resolveRange('this_year', saturdayWeek, undefined, NOON_DHAKA)).toMatchObject({
      from: '2026-01-01',
      to: '2026-09-22',
      previous: { from: '2025-01-01', to: '2025-09-22' },
    });
  });

  it('compares a custom range against the equally long period right before it', () => {
    expect(
      resolveRange('custom', saturdayWeek, { from: '2026-09-01', to: '2026-09-10' }, NOON_DHAKA),
    ).toMatchObject({
      from: '2026-09-01',
      to: '2026-09-10',
      previous: { from: '2026-08-22', to: '2026-08-31' },
    });
  });

  it('honours a business day start hour when deciding what "today" is', () => {
    // 01:00 Dhaka on the 23rd, with the day starting at 04:00 -> today is the 22nd.
    const afterMidnight = new Date('2026-09-22T19:00:00.000Z');
    expect(
      resolveRange('today', { ...saturdayWeek, businessDayStartHour: 4 }, undefined, afterMidnight),
    ).toMatchObject({ from: '2026-09-22', to: '2026-09-22' });
    expect(
      resolveRange('today', { ...saturdayWeek, businessDayStartHour: 0 }, undefined, afterMidnight),
    ).toMatchObject({ from: '2026-09-23', to: '2026-09-23' });
  });

  it('rejects a custom range without both ends, or the wrong way round', () => {
    expect(() => resolveRange('custom', saturdayWeek, { from: '2026-09-01' }, NOON_DHAKA)).toThrow(/custom range/);
    expect(() =>
      resolveRange('custom', saturdayWeek, { from: '2026-09-10', to: '2026-09-01' }, NOON_DHAKA),
    ).toThrow(/must not be after/);
  });
});

describe('businessRangeToInstants', () => {
  it('spans local midnight to local midnight in UTC', () => {
    const { startAt, endAt } = businessRangeToInstants(
      { from: '2026-09-22', to: '2026-09-22' },
      { timezone: DHAKA, businessDayStartHour: 0 },
    );
    expect(startAt.toISOString()).toBe('2026-09-21T18:00:00.000Z');
    expect(endAt.toISOString()).toBe('2026-09-22T18:00:00.000Z');
  });

  it('shifts both ends by the business day start hour', () => {
    const { startAt, endAt } = businessRangeToInstants(
      { from: '2026-09-22', to: '2026-09-22' },
      { timezone: DHAKA, businessDayStartHour: 4 },
    );
    expect(startAt.toISOString()).toBe('2026-09-21T22:00:00.000Z');
    expect(endAt.toISOString()).toBe('2026-09-22T22:00:00.000Z');
  });
});

describe('percentageChange', () => {
  it('computes growth and decline to one decimal', () => {
    expect(percentageChange(150, 100)).toBe(50);
    expect(percentageChange(75, 100)).toBe(-25);
    expect(percentageChange(1000, 333)).toBe(200.3);
  });

  it('returns null when there is no baseline to compare against', () => {
    expect(percentageChange(100, 0)).toBeNull();
    expect(percentageChange(0, 0)).toBe(0);
  });
});

describe('ageInYears', () => {
  it('counts whole years from a date of birth', () => {
    expect(ageInYears('2020-05-10', '2026-09-22')).toBe(6);
    expect(ageInYears('2020-09-23', '2026-09-22')).toBe(5); // birthday not reached
    expect(ageInYears('2020-09-22', '2026-09-22')).toBe(6); // birthday today
  });
});
