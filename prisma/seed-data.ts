import { PlanType, Role } from '@prisma/client';

/**
 * The canonical starting catalogue. Shared by `npm run seed`, the demo seed and
 * the e2e fixtures, so tests exercise the same plans and prices the business
 * actually opens with.
 *
 * All prices are in poisha (1 BDT = 100 poisha).
 */

export interface SeedPlan {
  name: string;
  type: PlanType;
  price: number;
  durationDays?: number;
  sessionMinutes?: number;
  includesSnackBox: boolean;
  requiresVerification: boolean;
  overtimeBlockMinutes?: number;
  overtimeRatePerBlock?: number;
  gracePeriodMinutes: number;
  sortOrder: number;
}

export const SEED_PLANS: SeedPlan[] = [
  {
    name: '3 Month Membership',
    type: PlanType.MEMBERSHIP,
    price: 600_000, // ৳6,000
    durationDays: 90,
    includesSnackBox: false,
    requiresVerification: true,
    gracePeriodMinutes: 10,
    sortOrder: 1,
  },
  {
    name: '6 Month Membership',
    type: PlanType.MEMBERSHIP,
    price: 1_100_000, // ৳11,000 — cheaper per month than two 3-month terms
    durationDays: 180,
    includesSnackBox: true,
    requiresVerification: true,
    gracePeriodMinutes: 10,
    sortOrder: 2,
  },
  {
    name: '2 Hour Indoor',
    type: PlanType.SESSION,
    price: 40_000, // ৳400
    sessionMinutes: 120,
    includesSnackBox: false,
    requiresVerification: false,
    overtimeBlockMinutes: 30,
    overtimeRatePerBlock: 10_000, // ৳100 per started half hour
    gracePeriodMinutes: 10,
    sortOrder: 3,
  },
  {
    name: '2 Hour Indoor + Snack Box',
    type: PlanType.SESSION,
    price: 55_000, // ৳550
    sessionMinutes: 120,
    includesSnackBox: true,
    requiresVerification: false,
    overtimeBlockMinutes: 30,
    overtimeRatePerBlock: 10_000,
    gracePeriodMinutes: 10,
    sortOrder: 4,
  },
];

export interface SeedCategory {
  name: string;
  sortOrder: number;
  items: Array<{ name: string; price: number; description?: string; sku?: string }>;
}

/** Five categories, 25 items, at realistic Dhaka café prices. */
export const SEED_MENU: SeedCategory[] = [
  {
    name: 'Kids Meals',
    sortOrder: 1,
    items: [
      { name: 'Mini Chicken Burger', price: 22_000, description: 'Soft bun, grilled chicken patty, no spice', sku: 'KID-001' },
      { name: 'Chicken Nuggets (6 pcs)', price: 18_000, sku: 'KID-002' },
      { name: 'Cheese Pasta Bowl', price: 24_000, description: 'Creamy white sauce, mild', sku: 'KID-003' },
      { name: 'Mini Pizza Margherita', price: 26_000, sku: 'KID-004' },
      { name: 'Party Snack Box', price: 30_000, description: 'Nuggets, fries, juice and a cupcake', sku: 'KID-005' },
    ],
  },
  {
    name: 'Rice & Curry',
    sortOrder: 2,
    items: [
      { name: 'Chicken Biryani', price: 32_000, description: 'Kacchi style, with borhani', sku: 'RIC-001' },
      { name: 'Beef Tehari', price: 30_000, sku: 'RIC-002' },
      { name: 'Plain Rice', price: 6_000, sku: 'RIC-003' },
      { name: 'Chicken Curry', price: 22_000, sku: 'RIC-004' },
      { name: 'Mixed Vegetable', price: 14_000, sku: 'RIC-005' },
      { name: 'Dal', price: 8_000, sku: 'RIC-006' },
    ],
  },
  {
    name: 'Fast Food',
    sortOrder: 3,
    items: [
      { name: 'Chicken Burger', price: 28_000, sku: 'FF-001' },
      { name: 'Beef Cheese Burger', price: 38_000, sku: 'FF-002' },
      { name: 'Chicken Shawarma', price: 24_000, sku: 'FF-003' },
      { name: 'Club Sandwich', price: 32_000, sku: 'FF-004' },
      { name: 'French Fries', price: 14_000, sku: 'FF-005' },
      { name: 'Chicken Wings (6 pcs)', price: 30_000, description: 'Hot or BBQ', sku: 'FF-006' },
    ],
  },
  {
    name: 'Beverages',
    sortOrder: 4,
    items: [
      { name: 'Masala Tea', price: 5_000, sku: 'BEV-001' },
      { name: 'Coffee', price: 12_000, sku: 'BEV-002' },
      { name: 'Cold Coffee', price: 18_000, sku: 'BEV-003' },
      { name: 'Mango Lassi', price: 16_000, sku: 'BEV-004' },
      { name: 'Fresh Lime Soda', price: 12_000, sku: 'BEV-005' },
      { name: 'Soft Drink (250ml)', price: 3_500, sku: 'BEV-006' },
    ],
  },
  {
    name: 'Desserts',
    sortOrder: 5,
    items: [
      { name: 'Chocolate Brownie', price: 18_000, sku: 'DES-001' },
      { name: 'Vanilla Ice Cream Scoop', price: 10_000, sku: 'DES-002' },
      { name: 'Rasmalai (2 pcs)', price: 14_000, sku: 'DES-003' },
      { name: 'Birthday Cupcake', price: 8_000, sku: 'DES-004' },
    ],
  },
];

export interface SeedUser {
  name: string;
  phone: string;
  email: string;
  password: string;
  role: Role;
}

/**
 * The three starting accounts. These credentials are printed by `npm run seed`
 * and documented in the README; they are development defaults and must be
 * changed before the system goes live.
 */
export const SEED_USERS: SeedUser[] = [
  {
    name: 'System Administrator',
    phone: '+8801819355509',
    email: 'admin@kidzone.test',
    password: 'Admin#2026',
    role: Role.ADMIN,
  },
];

export const TOTAL_SEED_MENU_ITEMS = SEED_MENU.reduce((n, c) => n + c.items.length, 0);
