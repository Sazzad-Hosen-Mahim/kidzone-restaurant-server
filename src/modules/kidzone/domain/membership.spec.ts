import { daysRemaining, hasExpired, hasStarted, isExpiringSoon, membershipTerm, renewalStartDate } from './membership';

describe('membershipTerm', () => {
  it('counts the start day as day one', () => {
    expect(membershipTerm('2026-09-22', 90)).toEqual({ startDate: '2026-09-22', endDate: '2026-12-20' });
    expect(membershipTerm('2026-09-22', 180)).toEqual({ startDate: '2026-09-22', endDate: '2027-03-20' });
    expect(membershipTerm('2026-09-22', 1)).toEqual({ startDate: '2026-09-22', endDate: '2026-09-22' });
  });

  it('rejects a term shorter than a day', () => {
    expect(() => membershipTerm('2026-09-22', 0)).toThrow(/at least one day/);
    expect(() => membershipTerm('2026-09-22', -5)).toThrow(/at least one day/);
    expect(() => membershipTerm('2026-09-22', 1.5)).toThrow(/at least one day/);
  });
});

describe('renewalStartDate', () => {
  it('starts the day after the old end date when renewing early', () => {
    expect(renewalStartDate('2026-12-20', '2026-12-01')).toBe('2026-12-21');
  });

  it('starts the day after when renewing on the final day', () => {
    expect(renewalStartDate('2026-12-20', '2026-12-20')).toBe('2026-12-21');
  });

  it('starts today when the old membership has already lapsed', () => {
    expect(renewalStartDate('2026-12-20', '2027-01-15')).toBe('2027-01-15');
  });

  it('gives an early renewal the full term on top of the remaining days', () => {
    const start = renewalStartDate('2026-12-20', '2026-12-01');
    expect(membershipTerm(start, 90)).toEqual({ startDate: '2026-12-21', endDate: '2027-03-20' });
  });
});

describe('daysRemaining', () => {
  it('counts today as a remaining day', () => {
    expect(daysRemaining('2026-09-22', '2026-09-22')).toBe(1);
    expect(daysRemaining('2026-09-30', '2026-09-22')).toBe(9);
  });

  it('is zero once expired', () => {
    expect(daysRemaining('2026-09-21', '2026-09-22')).toBe(0);
    expect(daysRemaining('2026-01-01', '2026-09-22')).toBe(0);
  });
});

describe('hasStarted / hasExpired', () => {
  it('treats the start and end days as inside the term', () => {
    expect(hasStarted('2026-09-22', '2026-09-22')).toBe(true);
    expect(hasStarted('2026-09-23', '2026-09-22')).toBe(false);
    expect(hasExpired('2026-09-22', '2026-09-22')).toBe(false);
    expect(hasExpired('2026-09-22', '2026-09-23')).toBe(true);
  });
});

describe('isExpiringSoon', () => {
  const reminders = [7, 1];

  it('is true inside the widest reminder window', () => {
    expect(isExpiringSoon('2026-09-29', '2026-09-22', reminders)).toBe(true); // exactly 7 days out
    expect(isExpiringSoon('2026-09-23', '2026-09-22', reminders)).toBe(true);
    expect(isExpiringSoon('2026-09-22', '2026-09-22', reminders)).toBe(true); // ends today
  });

  it('is false outside the window and once expired', () => {
    expect(isExpiringSoon('2026-09-30', '2026-09-22', reminders)).toBe(false);
    expect(isExpiringSoon('2026-09-21', '2026-09-22', reminders)).toBe(false);
  });

  it('only counts the end day when no reminders are configured', () => {
    expect(isExpiringSoon('2026-09-22', '2026-09-22', [])).toBe(true);
    expect(isExpiringSoon('2026-09-23', '2026-09-22', [])).toBe(false);
  });
});
