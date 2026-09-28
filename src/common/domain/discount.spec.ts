import { Role } from '@prisma/client';
import { discountPercentOf, validateDiscount } from './discount';

const base = {
  subtotal: 100_00,
  maxStaffDiscountPercent: 10,
};

describe('discountPercentOf', () => {
  it('computes the effective percentage to one decimal', () => {
    expect(discountPercentOf(100_00, 10_00)).toBe(10);
    expect(discountPercentOf(333_00, 10_00)).toBe(3);
    expect(discountPercentOf(100_00, 0)).toBe(0);
  });

  it('treats any discount on a zero subtotal as 100%', () => {
    expect(discountPercentOf(0, 0)).toBe(0);
    expect(discountPercentOf(0, 500)).toBe(100);
  });
});

describe('validateDiscount', () => {
  it('accepts no discount without needing a reason', () => {
    expect(validateDiscount({ ...base, discountAmount: 0, role: Role.RESTAURANT_CASHIER })).toEqual({
      discountAmount: 0,
      discountPercent: 0,
      requiresAudit: false,
    });
  });

  it('accepts a staff discount at exactly the limit', () => {
    expect(
      validateDiscount({
        ...base,
        discountAmount: 10_00,
        discountReason: 'Regular customer',
        role: Role.KIDZONE_MANAGER,
      }),
    ).toEqual({ discountAmount: 10_00, discountPercent: 10, requiresAudit: true });
  });

  it('rejects a staff discount one poisha over the limit', () => {
    expect(() =>
      validateDiscount({
        ...base,
        discountAmount: 10_01,
        discountReason: 'Regular customer',
        role: Role.RESTAURANT_CASHIER,
      }),
    ).toThrow(/may discount up to 10%/);
  });

  it('lets an admin exceed the staff limit', () => {
    expect(
      validateDiscount({ ...base, discountAmount: 50_00, discountReason: 'Owner approval', role: Role.ADMIN }),
    ).toMatchObject({ discountAmount: 50_00, discountPercent: 50, requiresAudit: true });
  });

  it('requires a reason for any discount, from anyone', () => {
    for (const role of [Role.ADMIN, Role.KIDZONE_MANAGER, Role.RESTAURANT_CASHIER]) {
      expect(() => validateDiscount({ ...base, discountAmount: 500, role })).toThrow(/reason is required/);
      expect(() => validateDiscount({ ...base, discountAmount: 500, discountReason: '   ', role })).toThrow(
        /reason is required/,
      );
    }
  });

  it('rejects a discount larger than the bill', () => {
    expect(() =>
      validateDiscount({ ...base, discountAmount: 100_01, discountReason: 'Oops', role: Role.ADMIN }),
    ).toThrow(/cannot exceed/);
  });

  it('rejects a negative or fractional discount', () => {
    expect(() => validateDiscount({ ...base, discountAmount: -100, role: Role.ADMIN })).toThrow(/non-negative/);
    expect(() => validateDiscount({ ...base, discountAmount: 10.5, role: Role.ADMIN })).toThrow(/whole/);
  });

  it('allows a full 100% discount by an admin with a reason', () => {
    expect(
      validateDiscount({ ...base, discountAmount: 100_00, discountReason: 'Complimentary', role: Role.ADMIN }),
    ).toMatchObject({ discountPercent: 100 });
  });
});
