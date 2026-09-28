import { KidZonePlan, MenuCategory, MenuItem } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { SEED_MENU, SEED_PLANS } from '../../prisma/seed-data';

/**
 * Loads the real starting catalogue into the test database, so e2e tests run
 * against the same plans, prices and menu the business opens with rather than
 * against invented fixtures.
 */
export async function seedCatalogue(prisma: PrismaService): Promise<{
  plans: Record<string, KidZonePlan>;
  categories: MenuCategory[];
  items: MenuItem[];
}> {
  const plans: Record<string, KidZonePlan> = {};

  for (const plan of SEED_PLANS) {
    const created = await prisma.kidZonePlan.create({
      data: {
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
      },
    });
    plans[plan.name] = created;
  }

  const categories: MenuCategory[] = [];
  const items: MenuItem[] = [];

  for (const category of SEED_MENU) {
    const createdCategory = await prisma.menuCategory.create({
      data: { name: category.name, sortOrder: category.sortOrder },
    });
    categories.push(createdCategory);

    for (const [index, item] of category.items.entries()) {
      items.push(
        await prisma.menuItem.create({
          data: {
            categoryId: createdCategory.id,
            name: item.name,
            description: item.description ?? null,
            price: item.price,
            sku: item.sku ?? null,
            sortOrder: index,
          },
        }),
      );
    }
  }

  return { plans, categories, items };
}

/** Shorthand for the plans the Kid Zone tests reach for most. */
export const PLAN_NAMES = {
  threeMonth: '3 Month Membership',
  sixMonth: '6 Month Membership',
  twoHour: '2 Hour Indoor',
  twoHourSnack: '2 Hour Indoor + Snack Box',
} as const;
