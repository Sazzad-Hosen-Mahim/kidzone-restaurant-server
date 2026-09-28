/**
 * Overtime for a one-time session visit.
 *
 * Pure and dependency-free so it can be reasoned about and unit-tested on its
 * own: the money it produces ends up on a customer's bill.
 *
 * Rules:
 *  - A grace period is subtracted before any overtime exists at all, so a
 *    parent who is five minutes late on a ten-minute grace pays nothing.
 *  - Overtime is then billed in whole started blocks: one minute into a 30
 *    minute block costs a full block. This is how the counter staff explain it,
 *    and it is what the plan's `overtimeBlockMinutes` means.
 *  - Memberships have no overtime unless their plan configures it.
 */

export interface OvertimePlanTerms {
  /** Length of the paid session in minutes. */
  sessionMinutes: number | null;
  /** Minutes of lateness forgiven before overtime starts. */
  gracePeriodMinutes: number;
  /** Billing block size, e.g. 30 minutes. */
  overtimeBlockMinutes: number | null;
  /** Poisha charged per started block. */
  overtimeRatePerBlock: number | null;
}

export interface OvertimeResult {
  /** Minutes actually spent inside. */
  elapsedMinutes: number;
  /** Chargeable minutes after the session length and grace period. */
  overtimeMinutes: number;
  /** Whole blocks billed. */
  blocks: number;
  /** Poisha owed for the overtime. */
  overtimeCharge: number;
}

/** Whole minutes between two instants, never negative. */
export function elapsedMinutes(checkInAt: Date, checkOutAt: Date): number {
  return Math.max(0, Math.floor((checkOutAt.getTime() - checkInAt.getTime()) / 60_000));
}

export function calculateOvertime(
  checkInAt: Date,
  checkOutAt: Date,
  terms: OvertimePlanTerms,
): OvertimeResult {
  const elapsed = elapsedMinutes(checkInAt, checkOutAt);

  // No session length means an open-ended visit, e.g. a membership: nothing to
  // run over.
  if (terms.sessionMinutes === null || terms.sessionMinutes <= 0) {
    return { elapsedMinutes: elapsed, overtimeMinutes: 0, blocks: 0, overtimeCharge: 0 };
  }

  const grace = Math.max(0, terms.gracePeriodMinutes);
  const overtime = Math.max(0, elapsed - terms.sessionMinutes - grace);

  if (overtime === 0) {
    return { elapsedMinutes: elapsed, overtimeMinutes: 0, blocks: 0, overtimeCharge: 0 };
  }

  const blockMinutes = terms.overtimeBlockMinutes ?? 0;
  const ratePerBlock = terms.overtimeRatePerBlock ?? 0;

  // A plan that ran over but has no overtime pricing records the minutes and
  // charges nothing, rather than guessing a price.
  if (blockMinutes <= 0 || ratePerBlock <= 0) {
    return { elapsedMinutes: elapsed, overtimeMinutes: overtime, blocks: 0, overtimeCharge: 0 };
  }

  const blocks = Math.ceil(overtime / blockMinutes);

  return {
    elapsedMinutes: elapsed,
    overtimeMinutes: overtime,
    blocks,
    overtimeCharge: blocks * ratePerBlock,
  };
}

/** Live view of a session in progress, for the active-visits board. */
export interface SessionProgress {
  elapsedMinutes: number;
  /** Minutes left before the session ends. Negative once it has run over. */
  remainingMinutes: number | null;
  isOvertime: boolean;
  /** Minutes past the session length, before the grace period is applied. */
  overtimeMinutes: number;
  /** True while the visit is late but still inside the grace period. */
  withinGrace: boolean;
}

export function sessionProgress(
  checkInAt: Date,
  now: Date,
  terms: Pick<OvertimePlanTerms, 'sessionMinutes' | 'gracePeriodMinutes'>,
): SessionProgress {
  const elapsed = elapsedMinutes(checkInAt, now);

  if (terms.sessionMinutes === null || terms.sessionMinutes <= 0) {
    return {
      elapsedMinutes: elapsed,
      remainingMinutes: null,
      isOvertime: false,
      overtimeMinutes: 0,
      withinGrace: false,
    };
  }

  const remaining = terms.sessionMinutes - elapsed;
  const past = Math.max(0, -remaining);
  const grace = Math.max(0, terms.gracePeriodMinutes);

  return {
    elapsedMinutes: elapsed,
    remainingMinutes: remaining,
    isOvertime: past > grace,
    overtimeMinutes: past,
    withinGrace: past > 0 && past <= grace,
  };
}
