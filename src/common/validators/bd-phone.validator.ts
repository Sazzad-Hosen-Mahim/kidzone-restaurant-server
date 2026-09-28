import { Transform } from 'class-transformer';
import { ValidationOptions, registerDecorator } from 'class-validator';
import { tryNormalizeBdPhone } from '@common/utils/phone.util';

/**
 * Validates that a value is a Bangladeshi mobile number in any of the commonly
 * typed forms. Pair it with `@NormalizeBdPhone()` so the value reaching the
 * service is always E.164.
 */
export function IsBdMobile(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isBdMobile',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && tryNormalizeBdPhone(value) !== null;
        },
        defaultMessage(): string {
          return `${propertyName} must be a Bangladeshi mobile number, e.g. 01712345678 or +8801712345678`;
        },
      },
    });
  };
}

/**
 * Rewrites the incoming value to E.164 before validation runs, so a phone is
 * stored in exactly one shape no matter how the cashier typed it. An
 * unparseable value is left untouched for `@IsBdMobile()` to reject.
 */
export function NormalizeBdPhone() {
  return Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    return tryNormalizeBdPhone(value) ?? value;
  });
}
