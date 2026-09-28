import { Role } from '@prisma/client';
import type { App } from 'supertest/types';
import { TestContext, createTestApp, resetDatabase } from './utils/test-app';
import { SeededUser, TEST_PASSWORD, as, login, seedStaff } from './utils/fixtures';

describe('Users, settings and audit (e2e)', () => {
  let ctx: TestContext;
  let server: App;
  let staff: Record<'admin' | 'manager' | 'cashier', SeededUser>;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as App;
  });

  beforeEach(async () => {
    await resetDatabase(ctx);
    staff = await seedStaff(ctx);
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe('RBAC', () => {
    it.each([
      ['GET', '/api/v1/users'],
      ['GET', '/api/v1/settings'],
      ['GET', '/api/v1/audit-logs'],
    ])('denies %s %s to a Kid Zone manager and a cashier', async (method, url) => {
      for (const user of [staff.manager, staff.cashier]) {
        const response = await as(server, user)[method.toLowerCase() as 'get'](url);
        expect(response.status).toBe(403);
        expect(response.body).toMatchObject({ statusCode: 403, message: expect.stringContaining(user.role) });
      }
    });

    it('allows an admin through the same endpoints', async () => {
      for (const url of ['/api/v1/users', '/api/v1/settings', '/api/v1/audit-logs']) {
        await as(server, staff.admin).get(url).expect(200);
      }
    });
  });

  describe('Users', () => {
    it('creates a user, normalising the phone number to E.164', async () => {
      const response = await as(server, staff.admin)
        .post('/api/v1/users')
        .send({
          name: 'New Cashier',
          phone: '01799 887766',
          email: 'New.Cashier@Kidzone.test',
          password: 'Cashier#2026',
          role: Role.RESTAURANT_CASHIER,
        })
        .expect(201);

      expect(response.body.data).toMatchObject({
        phone: '+8801799887766',
        email: 'new.cashier@kidzone.test',
        role: Role.RESTAURANT_CASHIER,
        isActive: true,
      });
      expect(response.body.data).not.toHaveProperty('passwordHash');

      await login(server, '01799887766', 'Cashier#2026');
    });

    it('rejects a duplicate phone number however it was typed', async () => {
      const response = await as(server, staff.admin)
        .post('/api/v1/users')
        .send({ name: 'Clash', phone: '8801711111111', password: 'Clash#2026a', role: Role.ADMIN })
        .expect(409);

      expect(response.body.error).toBe('PHONE_ALREADY_IN_USE');
    });

    it('rejects a password that does not meet the policy', async () => {
      await as(server, staff.admin)
        .post('/api/v1/users')
        .send({ name: 'Weak', phone: '01788776655', password: 'alllowercase', role: Role.ADMIN })
        .expect(400);
    });

    it('refuses to let an admin deactivate themselves', async () => {
      const patched = await as(server, staff.admin)
        .patch(`/api/v1/users/${staff.admin.id}`)
        .send({ isActive: false })
        .expect(400);
      expect(patched.body.error).toBe('CANNOT_DEACTIVATE_SELF');

      const deleted = await as(server, staff.admin).delete(`/api/v1/users/${staff.admin.id}`).expect(400);
      expect(deleted.body.error).toBe('CANNOT_DEACTIVATE_SELF');
    });

    it('keeps at least one active admin', async () => {
      const second = await as(server, staff.admin)
        .post('/api/v1/users')
        .send({ name: 'Second Admin', phone: '01766554433', password: 'Second#2026', role: Role.ADMIN })
        .expect(201);

      // Two admins now, so removing one is allowed.
      await as(server, staff.admin).delete(`/api/v1/users/${second.body.data.id}`).expect(200);

      // Back to one admin: the remaining one cannot be demoted away either.
      const secondSession = await login(server, staff.admin.phone);
      const response = await as(server, { ...staff.admin, accessToken: secondSession.accessToken })
        .patch(`/api/v1/users/${staff.admin.id}`)
        .send({ role: Role.RESTAURANT_CASHIER })
        .expect(400);
      expect(response.body.error).toBe('CANNOT_DEMOTE_SELF');
    });

    it('deactivating a user revokes their sessions immediately', async () => {
      await as(server, staff.cashier).get('/api/v1/auth/me').expect(200);

      await as(server, staff.admin).delete(`/api/v1/users/${staff.cashier.id}`).expect(200);

      await as(server, staff.cashier).get('/api/v1/auth/me').expect(401);
    });

    it('resets a password and returns a generated one exactly once', async () => {
      const response = await as(server, staff.admin)
        .post(`/api/v1/users/${staff.cashier.id}/reset-password`)
        .send({})
        .expect(201);

      const generated = response.body.data.generatedPassword as string;
      expect(generated).toEqual(expect.any(String));

      await login(server, staff.cashier.phone, generated);

      const audit = await ctx.prisma.auditLog.findFirst({ where: { action: 'PASSWORD_RESET' } });
      expect(audit).not.toBeNull();
      expect(JSON.stringify(audit)).not.toContain(generated);
    });
  });

  describe('Settings', () => {
    it('returns the seeded defaults', async () => {
      const response = await as(server, staff.admin).get('/api/v1/settings').expect(200);

      expect(response.body.data).toMatchObject({
        businessTimezone: 'Asia/Dhaka',
        weekStartDay: 6,
        businessDayStartHour: 0,
        checkInMethod: 'BOTH',
        expiryReminderDays: [7, 1],
      });
    });

    it('updates only the supplied keys and audits before/after', async () => {
      const response = await as(server, staff.admin)
        .patch('/api/v1/settings')
        .send({ vatPercent: 7.5, receiptFooter: 'See you soon!' })
        .expect(200);

      expect(response.body.data).toMatchObject({
        vatPercent: 7.5,
        receiptFooter: 'See you soon!',
        serviceChargePercent: 10, // untouched
      });

      const audit = await ctx.prisma.auditLog.findFirst({ where: { action: 'SETTINGS_CHANGED' } });
      expect(audit?.before).toMatchObject({ vatPercent: 5 });
      expect(audit?.after).toMatchObject({ vatPercent: 7.5 });
    });

    it('rejects an out-of-range value and an unknown key', async () => {
      await as(server, staff.admin).patch('/api/v1/settings').send({ vatPercent: 150 }).expect(400);
      await as(server, staff.admin).patch('/api/v1/settings').send({ notASetting: 1 }).expect(400);
    });

    it('describes the settings schema for a generic admin form', async () => {
      const response = await as(server, staff.admin).get('/api/v1/settings/schema').expect(200);

      expect(response.body.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: 'vatPercent', default: 5, description: expect.any(String) }),
        ]),
      );
    });
  });

  describe('Audit log', () => {
    it('is filterable and paginated', async () => {
      await as(server, staff.admin).patch('/api/v1/settings').send({ vatPercent: 6 }).expect(200);

      const response = await as(server, staff.admin)
        .get('/api/v1/audit-logs?action=SETTINGS_CHANGED&limit=10')
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0]).toMatchObject({
        action: 'SETTINGS_CHANGED',
        actor: { id: staff.admin.id, role: Role.ADMIN },
      });
      expect(response.body.meta).toMatchObject({ page: 1, limit: 10, total: 1, totalPages: 1 });
    });

    it('caps the page size at 100', async () => {
      await as(server, staff.admin).get('/api/v1/audit-logs?limit=500').expect(400);
    });

    it('has no write endpoints', async () => {
      await as(server, staff.admin).post('/api/v1/audit-logs').send({}).expect(404);
      await as(server, staff.admin).delete('/api/v1/audit-logs/anything').expect(404);
    });
  });

  it('password login still works for a user whose phone was typed nationally', async () => {
    await login(server, '01722222222', TEST_PASSWORD);
  });
});
