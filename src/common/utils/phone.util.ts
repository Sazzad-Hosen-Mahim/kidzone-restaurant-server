/**
 * Bangladeshi mobile number handling.
 *
 * Every phone number is stored in E.164 (`+8801XXXXXXXXX`) so that the same
 * guardian is recognised whether the cashier typed `01712345678`,
 * `8801712345678` or `+880 1712-345678`.
 *
 * Valid operator prefixes after the leading `01`: 3 (Banglalink/other),
 * 4 (Teletalk/other), 5 (Teletalk), 6 (Airtel), 7 (Grameenphone),
 * 8 (Robi), 9 (Banglalink/GP). Landlines are deliberately not accepted —
 * this system sends SMS to every number it stores.
 */

export const BD_MOBILE_E164 = /^\+8801[3-9]\d{8}$/;

export class InvalidPhoneNumberError extends Error {
  constructor(input: string) {
    super(`"${input}" is not a valid Bangladeshi mobile number`);
    this.name = 'InvalidPhoneNumberError';
  }
}

/**
 * Normalise any commonly typed form to E.164, or return null when the input is
 * not a valid Bangladeshi mobile number.
 */
export function tryNormalizeBdPhone(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;

  // Strip spaces, dashes, dots and parentheses; keep a leading plus.
  let digits = input.trim().replace(/[\s\-().]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (!/^\d+$/.test(digits)) return null;

  // 00880… international prefix
  if (digits.startsWith('00880')) digits = digits.slice(5);
  else if (digits.startsWith('880')) digits = digits.slice(3);
  else if (digits.startsWith('0')) digits = digits.slice(1);

  // At this point we expect the national significant number: 1XXXXXXXXX (10).
  const candidate = `+880${digits}`;
  return BD_MOBILE_E164.test(candidate) ? candidate : null;
}

/** Normalise or throw. Used where a valid number is a precondition. */
export function normalizeBdPhone(input: string): string {
  const normalized = tryNormalizeBdPhone(input);
  if (!normalized) throw new InvalidPhoneNumberError(input);
  return normalized;
}

export function isValidBdPhone(input: string | null | undefined): boolean {
  return tryNormalizeBdPhone(input) !== null;
}

/**
 * `+8801712345678` -> `+88017******78`.
 * Applied to every phone number written to application logs; full numbers live
 * only in the database.
 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const normalized = tryNormalizeBdPhone(phone);
  const value = normalized ?? phone;
  if (value.length <= 6) return '*'.repeat(value.length);
  const head = value.slice(0, value.length - 8);
  const tail = value.slice(-2);
  return `${head}${'*'.repeat(6)}${tail}`;
}

/** Local display form used on receipts: `01712-345678`. */
export function toLocalDisplay(phone: string): string {
  const normalized = tryNormalizeBdPhone(phone);
  if (!normalized) return phone;
  const national = `0${normalized.slice(4)}`;
  return `${national.slice(0, 5)}-${national.slice(5)}`;
}
