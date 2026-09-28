import { formatPoisha, percentOf, poishaToTakaString, roundPoisha, sumPoisha, takaToPoisha } from './money.util';

describe('money utils', () => {
  describe('roundPoisha', () => {
    it('rounds half away from zero', () => {
      expect(roundPoisha(10.5)).toBe(11);
      expect(roundPoisha(10.4999)).toBe(10);
      expect(roundPoisha(-10.5)).toBe(-11);
      expect(roundPoisha(-10.4)).toBe(-10);
    });

    it('leaves whole poisha untouched', () => {
      expect(roundPoisha(25000)).toBe(25000);
      expect(roundPoisha(0)).toBe(0);
    });

    it('rejects non-finite input rather than silently producing NaN money', () => {
      expect(() => roundPoisha(NaN)).toThrow();
      expect(() => roundPoisha(Infinity)).toThrow();
    });
  });

  describe('percentOf', () => {
    it('applies a percentage and rounds to whole poisha', () => {
      expect(percentOf(100_00, 15)).toBe(15_00);
      expect(percentOf(333_33, 7.5)).toBe(2500); // 2499.975 -> 2500
      expect(percentOf(0, 15)).toBe(0);
      expect(percentOf(100_00, 0)).toBe(0);
    });

    it('handles fractional percentages without floating point drift', () => {
      expect(percentOf(1_00, 33.33)).toBe(33);
      expect(percentOf(999_99, 5)).toBe(5000); // 4999.95 -> 5000
    });
  });

  describe('formatting', () => {
    it('renders poisha as taka with two decimals', () => {
      expect(poishaToTakaString(25000)).toBe('250.00');
      expect(poishaToTakaString(5)).toBe('0.05');
      expect(poishaToTakaString(-12345)).toBe('-123.45');
    });

    it('groups digits the Bangladeshi way', () => {
      expect(formatPoisha(25000)).toBe('BDT 250.00');
      expect(formatPoisha(123456700)).toBe('BDT 12,34,567.00');
      expect(formatPoisha(100000)).toBe('BDT 1,000.00');
      expect(formatPoisha(-25000)).toBe('BDT -250.00');
    });
  });

  it('converts taka to poisha', () => {
    expect(takaToPoisha(250)).toBe(25000);
    expect(takaToPoisha(250.55)).toBe(25055);
  });

  it('sums poisha exactly', () => {
    expect(sumPoisha([10_00, 20_50, 5])).toBe(3055);
    expect(sumPoisha([])).toBe(0);
  });
});
