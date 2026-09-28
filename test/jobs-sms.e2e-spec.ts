import { KidZonePlan, MembershipStatus, SmsStatus, SmsType } from '@prisma/client';
import type { App } from 'supertest/types';
import { TestContext, createTestApp, resetDatabase } from './utils/test-app';
import { SeededUser, as, seedStaff } from './utils/fixtures';
import { PLAN_NAMES, seedCatalogue } from './utils/catalogue';

describe('Scheduled jobs and SMS (e2e)', () => {
  let ctx: TestContext;
  let server: App;
  let staff: Record<'admin' | 'manager' | 'cashier', SeededUser>;
  let plans: Record<string, KidZonePlan>;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as App;
  });

  beforeEach(async () => {
    await resetDatabase(ctx);
    staff = await seedStaff(ctx);
    ({ plans } = await seedCatalogue(ctx.prisma));
  });

  afterAll(async () => {
    await ctx.close();
  });

  const sellMembership = (phone = '01712345678', name = 'Shahana Akter') =>
    as(server, staff.manager)
      .post('/api/v1/kidzone/sales')
      .send({
        customer: { phone, name },
        child: {
          create: {
            name: 'Ayaan Rahman',
            dateOfBirth: '2020-05-10',
            emergencyContactName: name,
            emergencyContactPhone: phone,
          },
        },
        planId: plans[PLAN_NAMES.threeMonth].id,
        payments: [{ method: 'CASH', amount: 600_000 }],
      });

  /** Moves a membership's end date so a reminder or the expiry sweep will act on it. */
  const setEndDate = async (membershipId: string, daysFromToday: number) => {
    const endDate = new Date(Date.now() + daysFromToday * 86_400_000);
    endDate.setUTCHours(0, 0, 0, 0);
    await ctx.prisma.membership.update({
      where: { id: membershipId },
      data: { startDate: new Date(endDate.getTime() - 89 * 86_400_000), endDate },
    });
  };

  // -------------------------------------------------------------------------

  describe('SMS log', () => {
    it('records every message with its provider and delivery status', async () => {
      await sellMembership().expect(201);

      const response = await as(server, staff.admin).get('/api/v1/jobs/sms-log').expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0]).toMatchObject({
        phone: '+8801712345678',
        type: SmsType.GATEPASS,
        provider: 'console',
        // The queue is off in tests, so delivery happens inline.
        status: SmsStatus.SENT,
        attempts: 1,
      });
      expect(response.body.data[0].providerMessageId).toEqual(expect.any(String));
    });

    it('is filterable by type and status, and admin only', async () => {
      await sellMembership().expect(201);
      await as(server, staff.manager)
        .post('/api/v1/kidzone/checkin/otp/send')
        .send({ phone: '01712345678' })
        .expect(200);

      const otps = await as(server, staff.admin).get('/api/v1/jobs/sms-log?type=OTP').expect(200);
      expect(otps.body.data).toHaveLength(1);
      expect(otps.body.data[0].type).toBe(SmsType.OTP);

      await as(server, staff.manager).get('/api/v1/jobs/sms-log').expect(403);
      await as(server, staff.cashier).get('/api/v1/jobs/sms-log').expect(403);
    });

    it('never stores the OTP code itself, only its hash', async () => {
      await sellMembership().expect(201);

      const sent = await as(server, staff.manager)
        .post('/api/v1/kidzone/checkin/otp/send')
        .send({ phone: '01712345678' })
        .expect(200);

      const code = sent.body.data.devCode as string;
      const stored = await ctx.prisma.otpCode.findFirstOrThrow();

      expect(stored.codeHash).not.toBe(code);
      expect(stored.codeHash).toHaveLength(64); // sha256 hex
    });
  });

  // -------------------------------------------------------------------------

  describe('Membership expiry sweep', () => {
    it('marks memberships past their end date as EXPIRED', async () => {
      const current = await sellMembership().expect(201);
      const lapsed = await sellMembership('01798765432', 'Second Guardian').expect(201);

      await setEndDate(lapsed.body.data.membership.id, -1);

      const response = await as(server, staff.admin).post('/api/v1/jobs/run/expire-memberships').expect(200);
      expect(response.body.data.expired).toBe(1);

      expect((await ctx.prisma.membership.findUniqueOrThrow({ where: { id: lapsed.body.data.membership.id } })).status)
        .toBe(MembershipStatus.EXPIRED);
      expect((await ctx.prisma.membership.findUniqueOrThrow({ where: { id: current.body.data.membership.id } })).status)
        .toBe(MembershipStatus.ACTIVE);
    });

    it('does not expire a membership on its final day', async () => {
      const sale = await sellMembership().expect(201);
      await setEndDate(sale.body.data.membership.id, 0);

      const response = await as(server, staff.admin).post('/api/v1/jobs/run/expire-memberships').expect(200);
      expect(response.body.data.expired).toBe(0);
    });

    it('is safe to run twice', async () => {
      const sale = await sellMembership().expect(201);
      await setEndDate(sale.body.data.membership.id, -1);

      const first = await as(server, staff.admin).post('/api/v1/jobs/run/expire-memberships').expect(200);
      const second = await as(server, staff.admin).post('/api/v1/jobs/run/expire-memberships').expect(200);

      expect(first.body.data.expired).toBe(1);
      expect(second.body.data.expired).toBe(0);
    });

    it('is admin only', async () => {
      await as(server, staff.manager).post('/api/v1/jobs/run/expire-memberships').expect(403);
    });
  });

  // -------------------------------------------------------------------------

  describe('Expiry reminders', () => {
    it('queues a reminder for memberships ending on each configured offset', async () => {
      const inSeven = await sellMembership('01711110001', 'Seven Days').expect(201);
      const tomorrow = await sellMembership('01711110002', 'One Day').expect(201);
      const inThree = await sellMembership('01711110003', 'Three Days').expect(201);

      await setEndDate(inSeven.body.data.membership.id, 7);
      await setEndDate(tomorrow.body.data.membership.id, 1);
      await setEndDate(inThree.body.data.membership.id, 3); // not a configured offset

      const response = await as(server, staff.admin).post('/api/v1/jobs/run/expiry-reminders').expect(200);
      expect(response.body.data).toEqual({ queued: 2, skipped: 0 });

      const reminders = await ctx.prisma.smsLog.findMany({ where: { type: SmsType.EXPIRY_REMINDER } });
      expect(reminders).toHaveLength(2);
      expect(reminders.map((r) => r.phone).sort()).toEqual(['+8801711110001', '+8801711110002']);

      const sevenDay = reminders.find((r) => r.phone === '+8801711110001')!;
      expect(sevenDay.message).toContain('7 day');
      expect(sevenDay.message).toContain('3 Month Membership');
    });

    it('is idempotent: a second run the same day sends nothing', async () => {
      const sale = await sellMembership('01711110001').expect(201);
      await setEndDate(sale.body.data.membership.id, 7);

      const first = await as(server, staff.admin).post('/api/v1/jobs/run/expiry-reminders').expect(200);
      const second = await as(server, staff.admin).post('/api/v1/jobs/run/expiry-reminders').expect(200);

      expect(first.body.data).toEqual({ queued: 1, skipped: 0 });
      expect(second.body.data).toEqual({ queued: 0, skipped: 1 });
      expect(await ctx.prisma.smsLog.count({ where: { type: SmsType.EXPIRY_REMINDER } })).toBe(1);
    });

    it('honours a changed expiryReminderDays setting', async () => {
      const sale = await sellMembership('01711110001').expect(201);
      await setEndDate(sale.body.data.membership.id, 14);

      const before = await as(server, staff.admin).post('/api/v1/jobs/run/expiry-reminders').expect(200);
      expect(before.body.data.queued).toBe(0);

      await as(server, staff.admin).patch('/api/v1/settings').send({ expiryReminderDays: [14] }).expect(200);

      const after = await as(server, staff.admin).post('/api/v1/jobs/run/expiry-reminders').expect(200);
      expect(after.body.data.queued).toBe(1);
    });

    it('skips cancelled and already expired memberships', async () => {
      const sale = await sellMembership('01711110001').expect(201);
      await setEndDate(sale.body.data.membership.id, 7);
      await ctx.prisma.membership.update({
        where: { id: sale.body.data.membership.id },
        data: { status: MembershipStatus.CANCELLED },
      });

      const response = await as(server, staff.admin).post('/api/v1/jobs/run/expiry-reminders').expect(200);
      expect(response.body.data.queued).toBe(0);
    });
  });

  // -------------------------------------------------------------------------

  describe('Cleanup', () => {
    it('removes expired OTP codes and stale refresh tokens', async () => {
      await sellMembership().expect(201);
      await as(server, staff.manager)
        .post('/api/v1/kidzone/checkin/otp/send')
        .send({ phone: '01712345678' })
        .expect(200);

      // Age the OTP past its expiry and the refresh tokens past theirs.
      await ctx.prisma.otpCode.updateMany({ data: { expiresAt: new Date(Date.now() - 60_000) } });
      await ctx.prisma.refreshToken.updateMany({ data: { expiresAt: new Date(Date.now() - 60_000) } });

      const response = await as(server, staff.admin).post('/api/v1/jobs/run/cleanup').expect(200);

      expect(response.body.data.otpCodes).toBe(1);
      expect(response.body.data.refreshTokens).toBeGreaterThanOrEqual(3);
      expect(await ctx.prisma.otpCode.count()).toBe(0);
    });

    it('leaves live codes and tokens alone', async () => {
      await sellMembership().expect(201);
      await as(server, staff.manager)
        .post('/api/v1/kidzone/checkin/otp/send')
        .send({ phone: '01712345678' })
        .expect(200);

      const response = await as(server, staff.admin).post('/api/v1/jobs/run/cleanup').expect(200);

      expect(response.body.data).toEqual({ otpCodes: 0, refreshTokens: 0 });
      expect(await ctx.prisma.otpCode.count()).toBe(1);
    });
  });
});
