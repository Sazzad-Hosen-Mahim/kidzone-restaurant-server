import { Role } from '@prisma/client';
import { ForbiddenDomainException, UnprocessableDomainException } from '@common/exceptions/domain.exception';

/**
 * Discount rules, shared by both sections.
 *
 * A discount is money off the business's own revenue, so it is checked in one
 * place rather than trusted to each sales endpoint: an admin may discount
 * without limit; anyone else is capped by `maxStaffDiscountPercent`; and any
 * discount at all requires a written reason that ends up in the audit trail.
 */

export interface DiscountCheck {
  /** Pre-discount amount in poisha. */
  subtotal: number;
  /** Requested discount in poisha. */
  discountAmount: number;
  discountReason?: string | null;
  role: Role;
  maxStaffDiscountPercent: number;
}

export interface DiscountVerdict {
  discountAmount: number;
  discountPercent: number;
  requiresAudit: boolean;
}

/** The effective percentage a discount represents, to one decimal place. */
export function discountPercentOf(subtotal: number, discountAmount: number): number {
  if (subtotal <= 0) return discountAmount > 0 ? 100 : 0;
  return Math.round((discountAmount / subtotal) * 1000) / 10;
}

/**
 * Validates a requested discount, throwing a typed domain error the API can
 * surface directly. Returns the accepted discount plus whether it must be
 * audited (every non-zero discount must).
 */
export function validateDiscount(check: DiscountCheck): DiscountVerdict {
  const { subtotal, discountAmount, role, maxStaffDiscountPercent } = check;

  if (!Number.isInteger(discountAmount) || discountAmount < 0) {
    throw new UnprocessableDomainException(
      'INVALID_DISCOUNT',
      'Discount must be a whole, non-negative number of poisha',
    );
  }

  if (discountAmount === 0) {
    return { discountAmount: 0, discountPercent: 0, requiresAudit: false };
  }

  if (discountAmount > subtotal) {
    throw new UnprocessableDomainException('DISCOUNT_EXCEEDS_TOTAL', 'A discount cannot exceed the amount due', {
      subtotal,
      discountAmount,
    });
  }

  const reason = check.discountReason?.trim();
  if (!reason) {
    throw new UnprocessableDomainException(
      'DISCOUNT_REASON_REQUIRED',
      'A reason is required whenever a discount is applied',
    );
  }

  const percent = discountPercentOf(subtotal, discountAmount);

  // Compare exactly rather than against the rounded display percentage:
  // 1001 poisha off 10000 is 10.01%, which must fail a 10% cap even though it
  // renders as "10%".
  const overLimit = discountAmount * 100 > subtotal * maxStaffDiscountPercent;

  if (role !== Role.ADMIN && overLimit) {
    throw new ForbiddenDomainException(
      'DISCOUNT_LIMIT_EXCEEDED',
      `Your role may discount up to ${maxStaffDiscountPercent}%. This discount is ${percent}%. An administrator must approve it.`,
      { maxStaffDiscountPercent, requestedPercent: percent },
    );
  }

  return { discountAmount, discountPercent: percent, requiresAudit: true };
}
