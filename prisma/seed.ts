/**
 * Baseline seed: `npm run seed`
 *
 * Creates the three staff accounts, the four default Kid Zone plans, the menu
 * and the default settings. Idempotent — running it again updates what exists
 * rather than duplicating it — so it is safe on an environment that has already
 * been seeded.
 */
import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { SEED_MENU, SEED_PLANS, SEED_USERS, TOTAL_SEED_MENU_ITEMS } from './seed-data';
import { SETTINGS_SCHEMA, SETTING_KEYS } from '../src/modules/settings/settings.constants';

const prisma = new PrismaClient();

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

async function seedUsers(): Promise<void> {
  for (const user of SEED_USERS) {
    const passwordHash = await argon2.hash(user.password, ARGON2_OPTIONS);

    await prisma.user.upsert({
      where: { phone: user.phone },
      create: {
        name: user.name,
        phone: user.phone,
        email: user.email,
        passwordHash,
        role: user.role,
      },
      // The password is deliberately NOT reset on re-run: an operator who has
      // changed the admin password should not have it silently reverted by a
      // deploy that re-runs the seed.
      update: { name: user.name, email: user.email, role: user.role, isActive: true },
    });
  }
  console.log(`  users        ${SEED_USERS.length}`);
}

async function seedPlans(): Promise<void> {
  for (const plan of SEED_PLANS) {
    const existing = await prisma.kidZonePlan.findFirst({ where: { name: plan.name } });

    const data = {
      name: plan.name,
      type: plan.type,
      price: plan.price,
      durationDays: plan.durationDays ?? null,
      sessionMinutes: plan.sessionMinutes ?? null,
      includesSnackBox: plan.includesSnackBox,
      requiresVerification: plan.requiresVerification,
      overtimeBlockMinutes: plan.overtimeBlockMinutes ?? null,
      overtimeRatePerBlock: plan.overtimeRatePerBlock ?? null,
      gracePeriodMinutes: plan.gracePeriodMinutes,
      sortOrder: plan.sortOrder,
    };

    if (existing) {
      // Price is left alone on re-run: changing it here would bypass the price
      // history that the application maintains for every real price change.
      const { price: _price, ...withoutPrice } = data;
      await prisma.kidZonePlan.update({ where: { id: existing.id }, data: withoutPrice });
    } else {
      await prisma.kidZonePlan.create({ data });
    }
  }
  console.log(`  plans        ${SEED_PLANS.length}`);
}

async function seedMenu(): Promise<void> {
  for (const category of SEED_MENU) {
    const savedCategory = await prisma.menuCategory.upsert({
      where: { name: category.name },
      create: { name: category.name, sortOrder: category.sortOrder },
      update: { sortOrder: category.sortOrder, isActive: true, deletedAt: null },
    });

    for (const [index, item] of category.items.entries()) {
      const existing = await prisma.menuItem.findFirst({
        where: { name: item.name, categoryId: savedCategory.id },
      });

      if (existing) {
        await prisma.menuItem.update({
          where: { id: existing.id },
          data: { description: item.description ?? null, sku: item.sku ?? null, sortOrder: index },
        });
      } else {
        await prisma.menuItem.create({
          data: {
            categoryId: savedCategory.id,
            name: item.name,
            description: item.description ?? null,
            price: item.price,
            sku: item.sku ?? null,
            sortOrder: index,
          },
        });
      }
    }
  }
  console.log(`  menu         ${SEED_MENU.length} categories, ${TOTAL_SEED_MENU_ITEMS} items`);
}

async function seedSettings(): Promise<void> {
  let created = 0;

  for (const key of SETTING_KEYS) {
    const existing = await prisma.setting.findUnique({ where: { key } });
    if (existing) continue;

    await prisma.setting.create({
      data: {
        key,
        value: SETTINGS_SCHEMA[key].default as never,
        description: SETTINGS_SCHEMA[key].description,
      },
    });
    created++;
  }

  console.log(`  settings     ${created} created, ${SETTING_KEYS.length - created} already present`);
}

async function main(): Promise<void> {
  console.log('\nSeeding the Kid Zone + Restaurant database\n');

  await seedSettings();
  await seedUsers();
  await seedPlans();
  await seedMenu();

  console.log('\n  Sign in with any of these accounts:\n');
  for (const user of SEED_USERS) {
    console.log(`    ${user.role.padEnd(19)} ${user.phone}  password: ${user.password}`);
  }
  console.log('\n  These are development defaults. Change them before going live.\n');
}

main()
  .catch((error: unknown) => {
    console.error('\nSeed failed:', error instanceof Error ? error.message : error, '\n');
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
