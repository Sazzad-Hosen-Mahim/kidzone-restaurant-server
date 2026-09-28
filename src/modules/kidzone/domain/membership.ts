import { randomBytes } from 'node:crypto';
import { BusinessDate, addDays, compareDates, diffDays } from '@common/utils/date.util';

/**
 * Membership term arithmetic, kept pure so the rules are testable without a
 * database: a 90-day membership sold on the 22nd ends on day 90, not day 91.
 */

export interface MembershipTerm {
  startDate: BusinessDate;
  endDate: BusinessDate;
}

/**
 * A membership starting on `startDate` and running for `durationDays`,
 * inclusive of both ends. 90 days from 2026-09-22 ends on 2026-12-20.
 */
export function membershipTerm(startDate: BusinessDate, durationDays: number): MembershipTerm {
  if (!Number.isInteger(durationDays) || durationDays < 1) {
    throw new Error(`A membership must run for at least one day, received ${durationDays}`);
  }
  return { startDate, endDate: addDays(startDate, durationDays - 1) };
}

/**
 * Where a renewal starts.
 *
 * Renewing early must not cost the customer the days they already paid for, so
 * a renewal of a membership that has not yet expired starts the day after the
 * old end date. A lapsed membership simply restarts today.
 */
export function renewalStartDate(previousEndDate: BusinessDate, today: BusinessDate): BusinessDate {
  return compareDates(previousEndDate, today) >= 0 ? addDays(previousEndDate, 1) : today;
}

/**
 * Days remaining on a membership, counting today as one remaining day.
 * Zero once it has expired.
 */
export function daysRemaining(endDate: BusinessDate, today: BusinessDate): number {
  return Math.max(0, diffDays(today, endDate) + 1);
}

export function hasStarted(startDate: BusinessDate, today: BusinessDate): boolean {
  return compareDates(today, startDate) >= 0;
}

export function hasExpired(endDate: BusinessDate, today: BusinessDate): boolean {
  return compareDates(today, endDate) > 0;
}

/**
 * True when the membership falls inside the reminder window, i.e. it is about
 * to expire and the guardian should be nudged. Uses the largest configured
 * reminder offset so the flag lights up as soon as the first reminder is due.
 */
export function isExpiringSoon(endDate: BusinessDate, today: BusinessDate, reminderDays: number[]): boolean {
  if (hasExpired(endDate, today)) return false;
  const window = reminderDays.length > 0 ? Math.max(...reminderDays) : 0;
  return diffDays(today, endDate) <= window;
}

/**
 * The membership QR payload. 32 random bytes in base64url: unguessable, so a
 * token cannot be enumerated to check somebody else's child in, and URL-safe so
 * it can be printed straight into a QR code or a link.
 *
 * Lives here rather than beside the sale because it is minted in two places —
 * when a membership is sold, and again when a lost card is reissued.
 */
export function generateQrToken(): string {
  return randomBytes(32).toString('base64url');
}
