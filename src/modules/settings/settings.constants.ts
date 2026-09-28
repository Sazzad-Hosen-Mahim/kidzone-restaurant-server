import { z } from 'zod';

/**
 * The typed settings registry. Each key declares a Zod schema and a default, so
 * `PATCH /settings` can validate per key and the rest of the app can read a
 * setting with a real type instead of `any` out of a JSON column.
 */

export const CHECK_IN_METHODS = ['OTP', 'QR', 'BOTH'] as const;
export type CheckInMethod = (typeof CHECK_IN_METHODS)[number];

const percent = z.number().min(0).max(100);
const templateString = z.string().min(1).max(600);

export const SETTINGS_SCHEMA = {
  businessName: {
    schema: z.string().min(1).max(120),
    default: 'Kid Zone & Restaurant',
    description: 'Printed at the top of every receipt and report.',
  },
  address: {
    schema: z.string().max(300),
    default: 'House 12, Road 5, Dhanmondi, Dhaka 1205',
    description: 'Printed under the business name on receipts.',
  },
  phone: {
    schema: z.string().max(60),
    default: '+8801700000000',
    description: 'Contact number printed on receipts.',
  },
  receiptFooter: {
    schema: z.string().max(300),
    default: 'Thank you for visiting. Please come again!',
    description: 'Footer line on every printed receipt.',
  },
  vatPercent: {
    schema: percent,
    default: 5,
    description: 'VAT applied to restaurant orders, after discount and service charge.',
  },
  serviceChargePercent: {
    schema: percent,
    default: 10,
    description: 'Service charge applied to restaurant orders, after discount and before VAT.',
  },
  maxStaffDiscountPercent: {
    schema: percent,
    default: 10,
    description: 'Largest discount a non-admin may apply. Admins are not limited.',
  },
  weekStartDay: {
    schema: z.number().int().min(0).max(6),
    default: 6,
    description: '0 = Sunday … 6 = Saturday. Used for every weekly report boundary.',
  },
  businessDayStartHour: {
    schema: z.number().int().min(0).max(23),
    default: 0,
    description: 'Trade before this local hour counts toward the previous business day.',
  },
  businessTimezone: {
    schema: z.string().min(1).max(60),
    default: 'Asia/Dhaka',
    description: 'IANA timezone used for business dates, report ranges and receipts.',
  },
  expiryReminderDays: {
    schema: z.array(z.number().int().min(0).max(365)).max(10),
    default: [7, 1],
    description: 'Days before a membership ends on which a reminder SMS is queued.',
  },
  checkInMethod: {
    schema: z.enum(CHECK_IN_METHODS),
    default: 'BOTH' as CheckInMethod,
    description: 'Which gate check-in methods are accepted for memberships.',
  },
  otpExpiryMinutes: {
    schema: z.number().int().min(1).max(60),
    default: 5,
    description: 'Lifetime of a check-in OTP.',
  },
  otpMaxAttempts: {
    schema: z.number().int().min(1).max(10),
    default: 5,
    description: 'Wrong attempts before an OTP is invalidated.',
  },
  otpResendCooldownSeconds: {
    schema: z.number().int().min(0).max(600),
    default: 60,
    description: 'Minimum gap between two OTP sends to the same number.',
  },
  otpMaxSendsPerHour: {
    schema: z.number().int().min(1).max(50),
    default: 5,
    description: 'OTP sends allowed per phone number per rolling hour.',
  },
  smsTemplateMembershipSold: {
    schema: templateString,
    default:
      'Dear {name}, {plan} for {child} is active until {endDate}. Show this code at the gate: {qrCode}. - {businessName}',
    description: 'Placeholders: {name} {child} {plan} {endDate} {qrCode} {businessName}',
  },
  smsTemplateGatepass: {
    schema: templateString,
    default:
      'Gatepass {gatepassNo}: {child} checked in at {checkInTime}. Session ends {expectedCheckOut}. - {businessName}',
    description: 'Placeholders: {name} {child} {gatepassNo} {checkInTime} {expectedCheckOut} {businessName}',
  },
  smsTemplateOtp: {
    schema: templateString,
    default: 'Your {businessName} check-in code is {otp}. It expires in {minutes} minutes.',
    description: 'Placeholders: {otp} {minutes} {businessName}',
  },
  smsTemplateExpiryReminder: {
    schema: templateString,
    default:
      'Dear {name}, {child}’s {plan} expires on {endDate} ({daysLeft} day(s) left). Renew at {businessName}.',
    description: 'Placeholders: {name} {child} {plan} {endDate} {daysLeft} {businessName}',
  },
  smsTemplateReceipt: {
    schema: templateString,
    default: 'Receipt {receiptNo}: {amount} paid at {businessName} on {date}. Thank you!',
    description: 'Placeholders: {receiptNo} {amount} {date} {businessName}',
  },
} as const;

export type SettingKey = keyof typeof SETTINGS_SCHEMA;

export type SettingsMap = {
  [K in SettingKey]: z.infer<(typeof SETTINGS_SCHEMA)[K]['schema']>;
};

export const SETTING_KEYS = Object.keys(SETTINGS_SCHEMA) as SettingKey[];

export function defaultSettings(): SettingsMap {
  const out = {} as Record<string, unknown>;
  for (const key of SETTING_KEYS) out[key] = SETTINGS_SCHEMA[key].default;
  return out as SettingsMap;
}
