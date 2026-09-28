/**
 * Money helpers. Every amount in this system is an integer number of POISHA
 * (1 BDT = 100 poisha); floats are never used for money anywhere.
 *
 * Rounding rule: half away from zero ("round half up" for positive amounts), to
 * the nearest whole poisha. This is the rule a cashier expects from a paper
 * receipt and it is applied consistently to discounts, service charge and VAT.
 */

/** Round half away from zero to a whole poisha. */
export function roundPoisha(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Cannot round a non-finite amount: ${value}`);
  }
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * Apply a percentage to a poisha base and round to whole poisha.
 * `percent` is a human percentage, e.g. 7.5 for 7.5%.
 */
export function percentOf(basePoisha: number, percent: number): number {
  return roundPoisha((basePoisha * percent) / 100);
}

/** 12345 -> "123.45" */
export function poishaToTakaString(poisha: number): string {
  const negative = poisha < 0;
  const abs = Math.abs(Math.trunc(poisha));
  const taka = Math.floor(abs / 100);
  const remainder = abs % 100;
  return `${negative ? '-' : ''}${taka}.${remainder.toString().padStart(2, '0')}`;
}

/** 12345 -> "BDT 123.45" (used on receipts and in exports). */
export function formatPoisha(poisha: number, currency = 'BDT'): string {
  const [taka, fraction] = poishaToTakaString(poisha).split('.');
  const negative = taka.startsWith('-');
  const digits = negative ? taka.slice(1) : taka;
  // Bangladeshi digit grouping: last three digits, then pairs (1,23,456).
  let grouped = digits;
  if (digits.length > 3) {
    const head = digits.slice(0, digits.length - 3);
    const tail = digits.slice(-3);
    grouped = `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${tail}`;
  }
  return `${currency} ${negative ? '-' : ''}${grouped}.${fraction}`;
}

/** 123.45 taka -> 12345 poisha. Used when parsing human input or seed data. */
export function takaToPoisha(taka: number): number {
  return roundPoisha(taka * 100);
}

/** Poisha as a decimal number of taka, for spreadsheet cells that want a number. */
export function poishaToTakaNumber(poisha: number): number {
  return poisha / 100;
}

export function sumPoisha(values: readonly number[]): number {
  return values.reduce((total, v) => total + v, 0);
}
