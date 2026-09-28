import { MenuItem, OrderStatus } from '@prisma/client';
import type { App } from 'supertest/types';
import { TestContext, createTestApp, resetDatabase } from './utils/test-app';
import { SeededUser, as, seedStaff } from './utils/fixtures';
import { seedCatalogue } from './utils/catalogue';
import { TOTAL_SEED_MENU_ITEMS } from '../prisma/seed-data';

describe('Restaurant (e2e)', () => {
  let ctx: TestContext;
  let server: App;
  let staff: Record<'admin' | 'manager' | 'cashier', SeededUser>;
  let items: MenuItem[];

  const itemNamed = (name: string): MenuItem => {
    const found = items.find((i) => i.name === name);
    if (!found) throw new Error(`Test fixture is missing the menu item "${name}"`);
    return found;
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as App;
  });

  beforeEach(async () => {
    await resetDatabase(ctx);
    staff = await seedStaff(ctx);
    ({ items } = await seedCatalogue(ctx.prisma));
  });

  afterAll(async () => {
    await ctx.close();
  });

  // -------------------------------------------------------------------------

  describe('Menu', () => {
    it('serves the POS board grouped by category, active and available only', async () => {
      const response = await as(server, staff.cashier).get('/api/v1/restaurant/menu').expect(200);

      expect(response.body.data.categories).toHaveLength(5);
      expect(response.body.data.itemCount).toBe(TOTAL_SEED_MENU_ITEMS);
      expect(response.body.data.categories[0]).toMatchObject({ name: 'Kids Meals', sortOrder: 1 });
      expect(response.body.data.categories[0].items[0]).toMatchObject({
        name: 'Mini Chicken Burger',
        price: 22_000,
      });
    });

    it('drops an item from the board once a cashier marks it out of stock', async () => {
      const biryani = itemNamed('Chicken Biryani');

      await as(server, staff.cashier)
        .patch(`/api/v1/restaurant/menu-items/${biryani.id}/availability`)
        .send({ isAvailable: false })
        .expect(200);

      const board = await as(server, staff.cashier).get('/api/v1/restaurant/menu').expect(200);
      const names = board.body.data.categories.flatMap((c: { items: Array<{ name: string }> }) =>
        c.items.map((i) => i.name),
      );
      expect(names).not.toContain('Chicken Biryani');
      expect(board.body.data.itemCount).toBe(TOTAL_SEED_MENU_ITEMS - 1);

      const audit = await ctx.prisma.auditLog.findFirst({ where: { action: 'MENU_AVAILABILITY_CHANGED' } });
      expect(audit?.after).toMatchObject({ isAvailable: false });
    });

    it('lets a cashier toggle availability but not edit an item or a price', async () => {
      const item = itemNamed('Chicken Burger');

      await as(server, staff.cashier)
        .patch(`/api/v1/restaurant/menu-items/${item.id}/availability`)
        .send({ isAvailable: false })
        .expect(200);

      await as(server, staff.cashier)
        .patch(`/api/v1/restaurant/menu-items/${item.id}`)
        .send({ price: 1 })
        .expect(403);

      await as(server, staff.cashier)
        .post('/api/v1/restaurant/menu-items')
        .send({ categoryId: item.categoryId, name: 'Free Burger', price: 0 })
        .expect(403);

      await as(server, staff.cashier).delete(`/api/v1/restaurant/menu-items/${item.id}`).expect(403);
    });

    it('denies the whole restaurant module to a Kid Zone manager', async () => {
      for (const url of ['/api/v1/restaurant/menu', '/api/v1/restaurant/orders', '/api/v1/restaurant/menu-items']) {
        expect((await as(server, staff.manager).get(url)).status).toBe(403);
      }
      expect((await as(server, staff.manager).post('/api/v1/restaurant/orders').send({})).status).toBe(403);
    });

    it('records a price change in the history', async () => {
      const item = itemNamed('Chicken Biryani');

      await as(server, staff.admin)
        .patch(`/api/v1/restaurant/menu-items/${item.id}`)
        .send({ price: 36_000 })
        .expect(200);

      const history = await ctx.prisma.menuItemPriceHistory.findMany({ where: { menuItemId: item.id } });
      expect(history[0]).toMatchObject({ oldPrice: 32_000, newPrice: 36_000, changedById: staff.admin.id });
    });

    it('refuses to retire a category that still holds active items', async () => {
      const categoryId = itemNamed('Chicken Biryani').categoryId;
      const response = await as(server, staff.admin)
        .delete(`/api/v1/restaurant/categories/${categoryId}`)
        .expect(409);
      expect(response.body.error).toBe('CATEGORY_NOT_EMPTY');
    });
  });

  // -------------------------------------------------------------------------

  describe('Taking an order', () => {
    const order = (overrides: Record<string, unknown> = {}, actor?: SeededUser) =>
      as(server, actor ?? staff.cashier)
        .post('/api/v1/restaurant/orders')
        .send({
          items: [{ menuItemId: itemNamed('Chicken Biryani').id, quantity: 2 }],
          payments: [{ method: 'CASH', amount: 73_920 }],
          ...overrides,
        });

    it('prices the bill as subtotal, then service charge, then VAT', async () => {
      // 2 x ৳320 = ৳640; +10% service = ৳64; VAT 5% of ৳704 = ৳35.20; total ৳739.20
      const response = await order().expect(201);

      expect(response.body.data).toMatchObject({
        receiptNo: expect.stringMatching(/^RS-\d{8}-0001$/),
        subtotal: 64_000,
        discountAmount: 0,
        serviceChargePercent: 10,
        serviceChargeAmount: 6_400,
        vatPercent: 5,
        vatAmount: 3_520,
        totalAmount: 73_920,
        status: OrderStatus.PAID,
        cashierId: staff.cashier.id,
      });
    });

    it('snapshots the item name, price and category onto every line', async () => {
      const response = await order({
        items: [
          { menuItemId: itemNamed('Chicken Biryani').id, quantity: 2 },
          { menuItemId: itemNamed('Masala Tea').id, quantity: 3, note: 'Less sugar' },
        ],
        payments: [{ method: 'CASH', amount: 91_245 }],
      }).expect(201);

      expect(response.body.data.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            itemNameSnapshot: 'Chicken Biryani',
            unitPriceSnapshot: 32_000,
            categoryNameSnapshot: 'Rice & Curry',
            quantity: 2,
            lineTotal: 64_000,
          }),
          expect.objectContaining({
            itemNameSnapshot: 'Masala Tea',
            unitPriceSnapshot: 5_000,
            categoryNameSnapshot: 'Beverages',
            quantity: 3,
            lineTotal: 15_000,
            note: 'Less sugar',
          }),
        ]),
      );
    });

    it('keeps the old price on an existing order after the menu price changes', async () => {
      const created = await order().expect(201);
      const orderId = created.body.data.id as string;

      await as(server, staff.admin)
        .patch(`/api/v1/restaurant/menu-items/${itemNamed('Chicken Biryani').id}`)
        .send({ price: 50_000 })
        .expect(200);

      const reread = await as(server, staff.cashier).get(`/api/v1/restaurant/orders/${orderId}`).expect(200);

      expect(reread.body.data.items[0]).toMatchObject({ unitPriceSnapshot: 32_000, lineTotal: 64_000 });
      expect(reread.body.data.totalAmount).toBe(73_920);

      // A new order picks up the new price.
      const after = await as(server, staff.cashier)
        .post('/api/v1/restaurant/orders')
        .send({
          items: [{ menuItemId: itemNamed('Chicken Biryani').id, quantity: 2 }],
          payments: [{ method: 'CASH', amount: 115_500 }],
        })
        .expect(201);
      expect(after.body.data.subtotal).toBe(100_000);
    });

    it('keeps the old VAT percentage on an existing order after the rate changes', async () => {
      const created = await order().expect(201);
      const orderId = created.body.data.id as string;

      await as(server, staff.admin).patch('/api/v1/settings').send({ vatPercent: 15 }).expect(200);

      const reread = await as(server, staff.cashier).get(`/api/v1/restaurant/orders/${orderId}`).expect(200);
      expect(reread.body.data).toMatchObject({ vatPercent: 5, vatAmount: 3_520, totalAmount: 73_920 });
    });

    it('applies a discount before the service charge and the VAT', async () => {
      // Subtotal ৳640, discount ৳40 -> base ৳600; service ৳60; VAT 5% of ৳660 = ৳33; total ৳693
      const response = await order({
        discountAmount: 4_000,
        discountReason: 'Regular customer',
        payments: [{ method: 'CASH', amount: 69_300 }],
      }).expect(201);

      expect(response.body.data).toMatchObject({
        subtotal: 64_000,
        discountAmount: 4_000,
        serviceChargeAmount: 6_000,
        vatAmount: 3_300,
        totalAmount: 69_300,
      });
    });

    it('caps a cashier’s discount but not an admin’s', async () => {
      const refused = await order({
        discountAmount: 12_800, // 20%
        discountReason: 'Friend',
        payments: [{ method: 'CASH', amount: 59_136 }],
      }).expect(403);
      expect(refused.body.error).toBe('DISCOUNT_LIMIT_EXCEEDED');

      await order(
        { discountAmount: 12_800, discountReason: 'Owner approved', payments: [{ method: 'CASH', amount: 59_136 }] },
        staff.admin,
      ).expect(201);
    });

    it('rejects an unavailable item and a retired one', async () => {
      const item = itemNamed('Chicken Biryani');

      await as(server, staff.cashier)
        .patch(`/api/v1/restaurant/menu-items/${item.id}/availability`)
        .send({ isAvailable: false })
        .expect(200);

      const response = await order().expect(422);
      expect(response.body.error).toBe('MENU_ITEM_UNAVAILABLE');
      expect(response.body.message).toContain('Chicken Biryani');

      await as(server, staff.admin).delete(`/api/v1/restaurant/menu-items/${item.id}`).expect(200);
      const retired = await order().expect(422);
      expect(retired.body.message).toContain('removed from the menu');
    });

    it('rejects an unknown menu item', async () => {
      const response = await order({
        items: [{ menuItemId: '00000000-0000-4000-8000-000000000000', quantity: 1 }],
      }).expect(404);
      expect(response.body.error).toBe('MENU_ITEM_NOT_FOUND');
    });

    it('rejects payments that do not settle the bill exactly, writing nothing', async () => {
      await order({ payments: [{ method: 'CASH', amount: 70_000 }] }).expect(422);
      expect(await ctx.prisma.order.count()).toBe(0);
      expect(await ctx.prisma.orderItem.count()).toBe(0);
    });

    it('accepts a split payment', async () => {
      const response = await order({
        payments: [
          { method: 'CASH', amount: 50_000 },
          { method: 'NAGAD', amount: 23_920, reference: 'NGD98765' },
        ],
      }).expect(201);

      expect(response.body.data.payments).toHaveLength(2);
    });

    it('attaches a guardian to the bill by phone, reusing the Kid Zone customer record', async () => {
      const customer = await ctx.prisma.customer.create({
        data: { name: 'Shahana Akter', phone: '+8801712345678' },
      });

      const response = await order({ customerPhone: '01712345678' }).expect(201);

      expect(response.body.data.customerId).toBe(customer.id);
      expect(await ctx.prisma.customer.count()).toBe(1);
    });

    it('creates a new customer when the phone is unknown and a name is given', async () => {
      const response = await order({ customerPhone: '01798887777', customerName: 'Walk-in Guest' }).expect(201);

      expect(response.body.data.customer).toMatchObject({ phone: '+8801798887777', name: 'Walk-in Guest' });
    });

    it('refuses to invent a customer from a phone number alone', async () => {
      const response = await order({ customerPhone: '01798887777' }).expect(400);
      expect(response.body.error).toBe('CUSTOMER_NAME_REQUIRED');
    });

    it('numbers restaurant receipts in their own sequence', async () => {
      await order().expect(201);
      const second = await order().expect(201);
      expect(second.body.data.receiptNo).toMatch(/^RS-\d{8}-0002$/);
    });

    it('rejects a body carrying a client-supplied price', async () => {
      const response = await as(server, staff.cashier)
        .post('/api/v1/restaurant/orders')
        .send({
          items: [{ menuItemId: itemNamed('Chicken Biryani').id, quantity: 1, price: 1 }],
          payments: [{ method: 'CASH', amount: 1 }],
        })
        .expect(400);

      expect(response.body.error).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(response.body.details)).toContain('price');
    });
  });

  // -------------------------------------------------------------------------

  describe('Voiding', () => {
    const takeOrder = () =>
      as(server, staff.cashier)
        .post('/api/v1/restaurant/orders')
        .send({
          items: [{ menuItemId: itemNamed('Chicken Biryani').id, quantity: 2 }],
          payments: [{ method: 'CASH', amount: 73_920 }],
        });

    it('is admin only and requires a reason', async () => {
      const created = await takeOrder().expect(201);
      const id = created.body.data.id as string;

      await as(server, staff.cashier)
        .post(`/api/v1/restaurant/orders/${id}/void`)
        .send({ reason: 'Rung up twice' })
        .expect(403);

      await as(server, staff.admin).post(`/api/v1/restaurant/orders/${id}/void`).send({ reason: 'no' }).expect(400);
    });

    it('marks the order VOIDED, keeps the row and audits it', async () => {
      const created = await takeOrder().expect(201);
      const id = created.body.data.id as string;

      const response = await as(server, staff.admin)
        .post(`/api/v1/restaurant/orders/${id}/void`)
        .send({ reason: 'Rung up on the wrong table' })
        .expect(200);

      expect(response.body.data).toMatchObject({
        status: OrderStatus.VOIDED,
        voidedById: staff.admin.id,
        voidReason: 'Rung up on the wrong table',
      });

      expect(await ctx.prisma.order.count()).toBe(1);
      expect(await ctx.prisma.orderItem.count()).toBe(1);
      expect(await ctx.prisma.payment.count({ where: { orderId: id } })).toBe(1);

      const audit = await ctx.prisma.auditLog.findFirst({ where: { action: 'ORDER_VOIDED' } });
      expect(audit?.reason).toBe('Rung up on the wrong table');
    });

    it('refuses to void twice', async () => {
      const created = await takeOrder().expect(201);
      const id = created.body.data.id as string;

      await as(server, staff.admin).post(`/api/v1/restaurant/orders/${id}/void`).send({ reason: 'First void' }).expect(200);
      const response = await as(server, staff.admin)
        .post(`/api/v1/restaurant/orders/${id}/void`)
        .send({ reason: 'Second void' })
        .expect(409);
      expect(response.body.error).toBe('ORDER_ALREADY_VOIDED');
    });
  });
});
