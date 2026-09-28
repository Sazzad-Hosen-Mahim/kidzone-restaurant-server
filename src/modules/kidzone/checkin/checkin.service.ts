import { Injectable, Logger } from '@nestjs/common';
import {
  Child,
  Customer,
  KidZonePlan,
  Membership,
  MembershipStatus,
  OtpPurpose,
  Section,
  VerificationMethod,
  Visit,
  VisitStatus,
} from '@prisma/client';
import { PrismaService, PrismaExecutor } from '@/prisma/prisma.service';
import { AuditService } from '@modules/audit/audit.service';
import { AUDIT_ACTIONS } from '@modules/audit/audit.constants';
import { SettingsService } from '@modules/settings/settings.service';
import { DayLockService } from '@modules/closing/day-lock.service';
import { SequenceService } from '@common/services/sequence.service';
import { BusinessCalendarService } from '@common/services/business-calendar.service';
import { DomainException, NotFoundDomainException } from '@common/exceptions/domain.exception';
import { ClientInfo } from '@common/decorators/client-info.decorator';
import { AuthenticatedUser } from '@common/types/authenticated-user';
import { BusinessDate, ageInYears, fromDateColumn, toDateColumn } from '@common/utils/date.util';
import { maskPhone } from '@common/utils/phone.util';
import { daysRemaining, hasExpired, hasStarted, isExpiringSoon } from '../domain/membership';
import { OtpService } from './otp.service';
import { CheckInLookupDto, ManualCheckInDto, QrCheckInDto, VerifyOtpDto } from './dto/checkin.dto';

export interface MembershipSummary {
  id: string;
  planId: string;
  planName: string;
  startDate: BusinessDate;
  endDate: BusinessDate;
  status: MembershipStatus;
  daysRemaining: number;
  expiringSoon: boolean;
  usable: boolean;
  /** Why it cannot be used right now, when `usable` is false. */
  blockedReason: string | null;
}

export interface LookupResult {
  customer: { id: string; name: string; phone: string };
  children: Array<{
    id: string;
    name: string;
    ageYears: number;
    medicalNotes: string | null;
    hasActiveVisit: boolean;
    activeGatepassNo: string | null;
    memberships: MembershipSummary[];
  }>;
  checkInMethod: string;
}

export interface CheckInResult {
  visit: Visit;
  child: { id: string; name: string };
  membership: MembershipSummary;
  daysRemaining: number;
  expiringSoon: boolean;
}

@Injectable()
export class CheckInService {
  private readonly logger = new Logger(CheckInService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly settings: SettingsService,
    private readonly calendar: BusinessCalendarService,
    private readonly sequences: SequenceService,
    private readonly dayLock: DayLockService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // Lookup
  // -------------------------------------------------------------------------

  /**
   * What the gate sees when a guardian gives their number: their children, each
   * child's memberships with days remaining, and a clear flag on anything that
   * cannot be used and why.
   */
  async lookup(dto: CheckInLookupDto): Promise<LookupResult> {
    const customer = await this.prisma.customer.findUnique({
      where: { phone: dto.phone },
      include: {
        children: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
          include: {
            memberships: { orderBy: { endDate: 'desc' }, include: { plan: { select: { id: true, name: true } } } },
            visits: { where: { status: VisitStatus.ACTIVE }, select: { id: true, gatepassNo: true } },
          },
        },
      },
    });

    if (!customer) {
      throw new DomainException(
        'CUSTOMER_NOT_FOUND',
        'No customer is registered with that phone number',
        404,
        { phone: dto.phone },
      );
    }

    const today = await this.calendar.today();
    const { expiryReminderDays, checkInMethod } = await this.settings.getAll();

    return {
      customer: { id: customer.id, name: customer.name, phone: customer.phone },
      children: customer.children.map((child) => ({
        id: child.id,
        name: child.name,
        ageYears: ageInYears(fromDateColumn(child.dateOfBirth), today),
        medicalNotes: child.medicalNotes,
        hasActiveVisit: child.visits.length > 0,
        activeGatepassNo: child.visits[0]?.gatepassNo ?? null,
        memberships: child.memberships.map((m) =>
          this.summarize({ ...m, planName: m.plan.name }, today, expiryReminderDays),
        ),
      })),
      checkInMethod,
    };
  }

  // -------------------------------------------------------------------------
  // The three check-in methods
  // -------------------------------------------------------------------------

  async sendOtp(phone: string): Promise<unknown> {
    await this.assertMethodAllowed('OTP');

    // Sending a code to a number with nothing to check in would be a free SMS
    // for anyone who asks, so the customer must exist first.
    const customer = await this.prisma.customer.findUnique({ where: { phone }, select: { id: true } });
    if (!customer) {
      throw new DomainException('CUSTOMER_NOT_FOUND', 'No customer is registered with that phone number', 404);
    }

    return this.otp.send(phone, OtpPurpose.CHECK_IN);
  }

  async checkInWithOtp(dto: VerifyOtpDto, actor: AuthenticatedUser, client: ClientInfo): Promise<CheckInResult> {
    await this.assertMethodAllowed('OTP');

    const membership = await this.loadMembership(this.prisma, { id: dto.membershipId });
    if (membership.customer.phone !== dto.phone) {
      throw new DomainException(
        'MEMBERSHIP_PHONE_MISMATCH',
        'That membership belongs to a different phone number',
        403,
      );
    }
    if (membership.childId !== dto.childId) {
      throw new DomainException('CHILD_MEMBERSHIP_MISMATCH', 'That membership is not for the selected child', 400);
    }

    // Verified only after the membership checks pass, so a valid code is not
    // burned on a request that was going to fail anyway.
    await this.otp.verify(dto.phone, dto.code, OtpPurpose.CHECK_IN);

    this.logger.log(`OTP check-in for ${maskPhone(dto.phone)}`);

    return this.openVisit(membership, VerificationMethod.OTP, null, actor, client);
  }

  async checkInWithQr(dto: QrCheckInDto, actor: AuthenticatedUser, client: ClientInfo): Promise<CheckInResult> {
    await this.assertMethodAllowed('QR');

    const membership = await this.loadMembership(this.prisma, { qrToken: dto.qrToken }).catch(() => {
      // Never confirm whether a token merely does not exist: that would let
      // someone probe for valid tokens.
      throw new DomainException('QR_INVALID', 'That QR code is not valid', 404);
    });

    if (dto.childId && dto.childId !== membership.childId) {
      throw new DomainException('CHILD_MEMBERSHIP_MISMATCH', 'That membership is not for the selected child', 400);
    }

    return this.openVisit(membership, VerificationMethod.QR, null, actor, client);
  }

  /**
   * Admin-only escape hatch for a dead phone or an SMS outage. It skips
   * verification entirely, so it demands a reason and writes its own audit
   * entry distinct from a normal check-in.
   */
  async checkInManually(dto: ManualCheckInDto, actor: AuthenticatedUser, client: ClientInfo): Promise<CheckInResult> {
    const membership = await this.loadMembership(this.prisma, { id: dto.membershipId });

    if (dto.childId && dto.childId !== membership.childId) {
      throw new DomainException('CHILD_MEMBERSHIP_MISMATCH', 'That membership is not for the selected child', 400);
    }

    return this.openVisit(membership, VerificationMethod.MANUAL_OVERRIDE, dto.reason.trim(), actor, client);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async loadMembership(
    client: PrismaExecutor,
    where: { id: string } | { qrToken: string },
  ): Promise<Membership & { customer: Customer; child: Child; plan: KidZonePlan }> {
    const membership = await client.membership.findUnique({
      where: where as { id: string },
      include: { customer: true, child: true, plan: true },
    });
    if (!membership) {
      throw new NotFoundDomainException('Membership', 'id' in where ? where.id : undefined);
    }
    return membership;
  }

  /**
   * The single place a membership visit is created, whatever verified it.
   *
   * All three methods share the same refusals — expired, cancelled, not yet
   * started, already inside — so a manual override cannot accidentally admit a
   * child that OTP would have turned away.
   */
  private async openVisit(
    membership: Membership & { customer: Customer; child: Child; plan: KidZonePlan },
    method: VerificationMethod,
    overrideReason: string | null,
    actor: AuthenticatedUser,
    client: ClientInfo,
  ): Promise<CheckInResult> {
    const today = await this.calendar.today();
    const expiryReminderDays = await this.settings.get('expiryReminderDays');

    const startDate = fromDateColumn(membership.startDate);
    const endDate = fromDateColumn(membership.endDate);

    if (membership.status === MembershipStatus.CANCELLED) {
      throw new DomainException(
        'MEMBERSHIP_CANCELLED',
        `This membership was cancelled and cannot be used. It was valid until ${endDate}.`,
        409,
        { membershipId: membership.id, endDate },
      );
    }

    if (hasExpired(endDate, today)) {
      throw new DomainException(
        'MEMBERSHIP_EXPIRED',
        `This membership expired on ${endDate}. Please renew it to check in.`,
        409,
        { membershipId: membership.id, endDate, expiredDaysAgo: Math.max(0, -daysRemaining(endDate, today) + 1) },
      );
    }

    if (!hasStarted(startDate, today)) {
      throw new DomainException(
        'MEMBERSHIP_NOT_STARTED',
        `This membership starts on ${startDate} and cannot be used yet. It runs until ${endDate}.`,
        409,
        { membershipId: membership.id, startDate, endDate },
      );
    }

    await this.dayLock.assertOpen(Section.KIDZONE, today, 'A check-in');

    const visit = await this.prisma.runInTransaction(async (tx) => {
      const active = await tx.visit.findFirst({
        where: { childId: membership.childId, status: VisitStatus.ACTIVE },
        select: { id: true, gatepassNo: true, checkInAt: true },
      });

      if (active) {
        throw new DomainException(
          'CHILD_ALREADY_CHECKED_IN',
          `${membership.child.name} is already inside on gatepass ${active.gatepassNo}. Check them out first.`,
          409,
          { visitId: active.id, gatepassNo: active.gatepassNo, checkInAt: active.checkInAt },
        );
      }

      const gatepassNo = await this.sequences.nextGatepassNo(today, tx);

      return tx.visit.create({
        data: {
          businessDate: toDateColumn(today),
          customerId: membership.customerId,
          childId: membership.childId,
          membershipId: membership.id,
          gatepassNo,
          checkInAt: new Date(),
          // A membership visit is open ended: the child may stay as long as the
          // Kid Zone is open, so there is nothing to run over.
          expectedCheckOutAt: null,
          verificationMethod: method,
          overrideReason,
          status: VisitStatus.ACTIVE,
          checkedInById: actor.id,
        },
      });
    });

    await this.audit.record({
      actorId: actor.id,
      action: method === VerificationMethod.MANUAL_OVERRIDE ? AUDIT_ACTIONS.MANUAL_CHECKIN : AUDIT_ACTIONS.CHECK_IN,
      entityType: 'Visit',
      entityId: visit.id,
      after: {
        gatepassNo: visit.gatepassNo,
        childId: membership.childId,
        membershipId: membership.id,
        verificationMethod: method,
      },
      reason: overrideReason,
      ip: client.ip,
      userAgent: client.userAgent,
    });

    const summary = this.summarize(
      { ...membership, planName: membership.plan.name },
      today,
      expiryReminderDays,
    );

    return {
      visit,
      child: { id: membership.child.id, name: membership.child.name },
      membership: summary,
      daysRemaining: summary.daysRemaining,
      expiringSoon: summary.expiringSoon,
    };
  }

  private summarize(
    membership: Membership & { planName: string },
    today: BusinessDate,
    expiryReminderDays: number[],
  ): MembershipSummary {
    const startDate = fromDateColumn(membership.startDate);
    const endDate = fromDateColumn(membership.endDate);

    let blockedReason: string | null = null;
    if (membership.status === MembershipStatus.CANCELLED) blockedReason = 'Cancelled';
    else if (hasExpired(endDate, today)) blockedReason = `Expired on ${endDate}`;
    else if (!hasStarted(startDate, today)) blockedReason = `Starts on ${startDate}`;

    return {
      id: membership.id,
      planId: membership.planId,
      planName: membership.planName,
      startDate,
      endDate,
      status: membership.status,
      daysRemaining: daysRemaining(endDate, today),
      expiringSoon: isExpiringSoon(endDate, today, expiryReminderDays),
      usable: blockedReason === null,
      blockedReason,
    };
  }

  private async assertMethodAllowed(method: 'OTP' | 'QR'): Promise<void> {
    const configured = await this.settings.get('checkInMethod');
    if (configured !== 'BOTH' && configured !== method) {
      throw new DomainException(
        'CHECKIN_METHOD_DISABLED',
        `${method} check-in is switched off. This Kid Zone is configured for ${configured}.`,
        409,
        { configured },
      );
    }
  }
}
