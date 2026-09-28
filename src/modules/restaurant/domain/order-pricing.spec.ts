import { priceOrder } from './order-pricing';

const DEFAULTS = { serviceChargePercent: 10, vatPercent: 5 };

describe('priceOrder', () => {
  it('sums line totals into the subtotal', () => {
    const result = priceOrder({
      lines: [
        { unitPrice: 32_000, quantity: 2 }, // ৳320 x 2
        { unitPrice: 5_000, quantity: 3 }, // ৳50 x 3
      ],
      ...DEFAULTS,
    });

    expect(result.lines.map((l) => l.lineTotal)).toEqual([64_000, 15_000]);
    expect(result.subtotal).toBe(79_000);
  });

  it('applies discount, then service charge, then VAT, in that order', () => {
    // Subtotal 100.00, no discount.
    // Service charge 10% of 100.00 = 10.00
    // VAT 5% of 110.00 = 5.50   <- VAT is charged on the service charge too
    // Total = 115.50
    const result = priceOrder({ lines: [{ unitPrice: 10_000, quantity: 1 }], ...DEFAULTS });

    expect(result).toMatchObject({
      subtotal: 10_000,
      discountAmount: 0,
      taxableBase: 10_000,
      serviceChargeAmount: 1_000,
      vatAmount: 550,
      totalAmount: 11_550,
    });
  });

  it('lets a discount reduce the service charge and the VAT as well as the food', () => {
    // Subtotal 100.00, discount 20.00 -> base 80.00
    // Service charge 8.00, VAT 5% of 88.00 = 4.40, total 92.40
    const result = priceOrder({ lines: [{ unitPrice: 10_000, quantity: 1 }], discountAmount: 2_000, ...DEFAULTS });

    expect(result).toMatchObject({
      taxableBase: 8_000,
      serviceChargeAmount: 800,
      vatAmount: 440,
      totalAmount: 9_240,
    });
  });

  it('rounds each derived amount once, half away from zero', () => {
    // Base 333.33 -> service charge 10% = 33.333 -> rounds to 33.33
    // VAT 5% of 366.66 = 18.333 -> rounds to 18.33
    const result = priceOrder({ lines: [{ unitPrice: 33_333, quantity: 1 }], ...DEFAULTS });

    expect(result.serviceChargeAmount).toBe(3_333);
    expect(result.vatAmount).toBe(1_833);
    expect(result.totalAmount).toBe(38_499);
  });

  it('rounds a half poisha up', () => {
    // Base 10.10 -> service charge 5% = 0.505 -> rounds to 0.51
    const result = priceOrder({
      lines: [{ unitPrice: 1_010, quantity: 1 }],
      serviceChargePercent: 5,
      vatPercent: 0,
    });
    expect(result.serviceChargeAmount).toBe(51);
    expect(result.vatAmount).toBe(0);
    expect(result.totalAmount).toBe(1_061);
  });

  it('always returns whole poisha', () => {
    for (const unitPrice of [1, 7, 99, 12_345, 99_999]) {
      for (const quantity of [1, 3, 7]) {
        const result = priceOrder({ lines: [{ unitPrice, quantity }], serviceChargePercent: 7.5, vatPercent: 15 });
        for (const value of [result.subtotal, result.serviceChargeAmount, result.vatAmount, result.totalAmount]) {
          expect(Number.isInteger(value)).toBe(true);
        }
      }
    }
  });

  it('handles zero percentages', () => {
    const result = priceOrder({
      lines: [{ unitPrice: 25_000, quantity: 2 }],
      serviceChargePercent: 0,
      vatPercent: 0,
    });
    expect(result).toMatchObject({ subtotal: 50_000, serviceChargeAmount: 0, vatAmount: 0, totalAmount: 50_000 });
  });

  it('handles a 100% discount', () => {
    const result = priceOrder({ lines: [{ unitPrice: 10_000, quantity: 1 }], discountAmount: 10_000, ...DEFAULTS });
    expect(result).toMatchObject({ taxableBase: 0, serviceChargeAmount: 0, vatAmount: 0, totalAmount: 0 });
  });

  it('is the same whether one line of 3 or three lines of 1', () => {
    const single = priceOrder({ lines: [{ unitPrice: 12_345, quantity: 3 }], ...DEFAULTS });
    const split = priceOrder({
      lines: [
        { unitPrice: 12_345, quantity: 1 },
        { unitPrice: 12_345, quantity: 1 },
        { unitPrice: 12_345, quantity: 1 },
      ],
      ...DEFAULTS,
    });
    expect(split.totalAmount).toBe(single.totalAmount);
  });

  it('rejects a discount larger than the subtotal', () => {
    expect(() =>
      priceOrder({ lines: [{ unitPrice: 10_000, quantity: 1 }], discountAmount: 10_001, ...DEFAULTS }),
    ).toThrow(/cannot exceed the subtotal/);
  });

  it('rejects a fractional or non-positive quantity', () => {
    expect(() => priceOrder({ lines: [{ unitPrice: 100, quantity: 0 }], ...DEFAULTS })).toThrow(/Quantity/);
    expect(() => priceOrder({ lines: [{ unitPrice: 100, quantity: 1.5 }], ...DEFAULTS })).toThrow(/Quantity/);
    expect(() => priceOrder({ lines: [{ unitPrice: 100, quantity: -2 }], ...DEFAULTS })).toThrow(/Quantity/);
  });

  it('rejects a fractional or negative unit price', () => {
    expect(() => priceOrder({ lines: [{ unitPrice: 10.5, quantity: 1 }], ...DEFAULTS })).toThrow(/Unit price/);
    expect(() => priceOrder({ lines: [{ unitPrice: -100, quantity: 1 }], ...DEFAULTS })).toThrow(/Unit price/);
  });

  it('prices an empty order as zero rather than failing', () => {
    expect(priceOrder({ lines: [], ...DEFAULTS })).toMatchObject({ subtotal: 0, totalAmount: 0 });
  });

  it('reproduces an old bill exactly from its snapshotted percentages', () => {
    // The VAT rate changed from 5% to 7.5%, but the stored order keeps 5%.
    const reprint = priceOrder({
      lines: [{ unitPrice: 32_000, quantity: 2 }],
      serviceChargePercent: 10,
      vatPercent: 5,
    });
    expect(reprint.totalAmount).toBe(73_920);
  });
});
