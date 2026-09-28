import { isValidBdPhone, maskPhone, normalizeBdPhone, toLocalDisplay, tryNormalizeBdPhone } from './phone.util';

describe('phone utils', () => {
  describe('normalisation', () => {
    it.each([
      ['01712345678', '+8801712345678'],
      ['+8801712345678', '+8801712345678'],
      ['8801712345678', '+8801712345678'],
      ['008801712345678', '+8801712345678'],
      ['+880 1712-345678', '+8801712345678'],
      ['01712 345 678', '+8801712345678'],
      ['(017) 1234-5678', '+8801712345678'],
    ])('normalises %s to %s', (input, expected) => {
      expect(normalizeBdPhone(input)).toBe(expected);
    });

    it.each(['013', '014', '015', '016', '017', '018', '019'])('accepts operator prefix %s', (prefix) => {
      expect(isValidBdPhone(`${prefix}12345678`)).toBe(true);
    });

    it.each([
      ['01212345678', 'operator prefix 2 is not a mobile prefix'],
      ['0171234567', 'one digit too short'],
      ['017123456789', 'one digit too long'],
      ['+919812345678', 'an Indian number'],
      ['0212345678', 'a Dhaka landline'],
      ['not-a-number', 'letters'],
      ['', 'empty'],
    ])('rejects %s (%s)', (input) => {
      expect(tryNormalizeBdPhone(input)).toBeNull();
      expect(isValidBdPhone(input)).toBe(false);
    });

    it('throws with the offending input when asked to normalise or fail', () => {
      expect(() => normalizeBdPhone('01212345678')).toThrow(/01212345678/);
    });

    it('returns null for null and undefined', () => {
      expect(tryNormalizeBdPhone(null)).toBeNull();
      expect(tryNormalizeBdPhone(undefined)).toBeNull();
    });
  });

  describe('maskPhone', () => {
    it('keeps the country code and the last two digits', () => {
      expect(maskPhone('+8801712345678')).toBe('+88017******78');
      expect(maskPhone('01712345678')).toBe('+88017******78');
    });

    it('returns an empty string for a missing number', () => {
      expect(maskPhone(undefined)).toBe('');
      expect(maskPhone(null)).toBe('');
    });
  });

  it('renders a local display form for receipts', () => {
    expect(toLocalDisplay('+8801712345678')).toBe('01712-345678');
  });
});
