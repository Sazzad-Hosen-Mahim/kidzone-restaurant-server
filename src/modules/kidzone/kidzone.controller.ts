import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { KidZoneSale, Role } from '@prisma/client';
import { Roles } from '@common/decorators/roles.decorator';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { Client, ClientInfo } from '@common/decorators/client-info.decorator';
import { SkipGlobalThrottle } from '@common/decorators/skip-global-throttle.decorator';
import { AuthenticatedUser } from '@common/types/authenticated-user';
import { PageResult, ApiErrorResponse } from '@common/http/api-response';
import { Throttle } from '@nestjs/throttler';
import { SalesService, SaleResult } from './sales/sales.service';
import { CreateKidZoneSaleDto, RenewMembershipDto, VoidSaleDto } from './sales/dto/create-sale.dto';
import { QueryKidZoneSalesDto } from './sales/dto/query-sales.dto';
import { MembershipsService, QrCard } from './memberships/memberships.service';
import { QueryMembershipsDto } from './memberships/dto/query-memberships.dto';
import { ReissueQrDto } from './memberships/dto/qr-card.dto';
import { CheckInService, CheckInResult, LookupResult } from './checkin/checkin.service';
import { CheckInLookupDto, ManualCheckInDto, QrCheckInDto, SendOtpDto, VerifyOtpDto } from './checkin/dto/checkin.dto';
import { VisitsService } from './visits/visits.service';
import { CheckOutDto, QueryVisitsDto } from './visits/dto/visit.dto';

/** Everyone who works the Kid Zone floor. */
const KIDZONE_STAFF = [Role.ADMIN, Role.KIDZONE_MANAGER] as const;

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

@ApiTags('Kid Zone / Sales')
@ApiBearerAuth('access-token')
@Controller('kidzone/sales')
export class KidZoneSalesController {
  constructor(private readonly sales: SalesService) {}

  @Post()
  @Roles(...KIDZONE_STAFF)
  @ApiOperation({
    summary: 'Sell a Kid Zone plan',
    description: `Creates the sale, its payments and either a membership or an immediate check-in, all in one transaction.

- The guardian is found or created by phone, so the same customer is never duplicated across sections.
- The plan name and price are **snapshotted** onto the sale; a later price change never rewrites history.
- A **MEMBERSHIP** plan creates a dated membership with a QR token and texts the guardian the plan, end date and code.
- A **SESSION** plan checks the child straight in, issues a gatepass number and texts it, with \`expectedCheckOutAt\` set from the plan's \`sessionMinutes\`.
- Payments must add up to exactly the total after discount. Split payments are supported.
- Rejected with \`DAY_ALREADY_CLOSED\` if today has already been closed off for the Kid Zone.`,
  })
  @ApiCreatedResponse({ description: 'The sale, plus the membership or opening visit it created' })
  @ApiConflictResponse({ type: ApiErrorResponse, description: 'DAY_ALREADY_CLOSED, CHILD_ALREADY_CHECKED_IN' })
  create(
    @Body() dto: CreateKidZoneSaleDto,
    @CurrentUser() user: AuthenticatedUser,
    @Client() client: ClientInfo,
  ): Promise<SaleResult> {
    return this.sales.createSale(dto, user, client);
  }

  @Get()
  @Roles(...KIDZONE_STAFF)
  @ApiOperation({
    summary: 'List Kid Zone sales',
    description: 'Filter by `from`/`to` business date, `status`, customer, child or plan. `search` matches the receipt number, customer name and phone.',
  })
  list(@Query() query: QueryKidZoneSalesDto): Promise<PageResult<unknown>> {
    return this.sales.list(query);
  }

  @Get(':id')
  @Roles(...KIDZONE_STAFF)
  @ApiOperation({ summary: 'One Kid Zone sale with payments, membership and visits' })
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<unknown> {
    return this.sales.findOne(id);
  }

  @Post(':id/void')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Void a sale',
    description: `Admin only, and a reason is required. The sale is never deleted: it is marked VOIDED and excluded from revenue, while still being counted and listed separately in the reports.

Voiding a membership sale also **cancels the membership**, so a refunded customer cannot keep using the gate. An in-progress session visit is checked out.`,
  })
  voidSale(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidSaleDto,
    @CurrentUser() user: AuthenticatedUser,
    @Client() client: ClientInfo,
  ): Promise<KidZoneSale> {
    return this.sales.voidSale(id, dto, user, client);
  }
}

// ---------------------------------------------------------------------------
// Memberships
// ---------------------------------------------------------------------------

@ApiTags('Kid Zone / Memberships')
@ApiBearerAuth('access-token')
@Controller('kidzone/memberships')
export class MembershipsController {
  constructor(
    private readonly memberships: MembershipsService,
    private readonly sales: SalesService,
  ) {}

  @Get()
  @Roles(...KIDZONE_STAFF)
  @ApiOperation({
    summary: 'List memberships',
    description:
      'Each row carries `daysRemaining` and `expiringSoon`. `expiringWithinDays=7` gives the follow-up call list for this week. QR tokens are never included here.',
  })
  list(@Query() query: QueryMembershipsDto): Promise<PageResult<unknown>> {
    return this.memberships.list(query);
  }

  @Get(':id')
  @Roles(...KIDZONE_STAFF)
  @ApiOperation({ summary: 'One membership with its visits and renewal chain' })
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<unknown> {
    return this.memberships.findOne(id);
  }

  @Get(':id/qr')
  @Roles(...KIDZONE_STAFF)
  @ApiOperation({
    summary: 'The membership card, including its QR token',
    description: `The only endpoint that returns \`qrToken\`. Every other membership read strips it, because it is a **bearer credential**: whoever holds it can check the child in.

Use it to print or reprint the card the guardian carries. Encode \`qrToken\` verbatim in the QR square — that same string is what \`POST /kidzone/checkin/qr\` expects.

\`usable\` is false when the card would be refused at the gate today, with \`blockedReason\` saying which of the three refusals applies. Every call is audited as \`MEMBERSHIP_QR_ISSUED\`.`,
  })
  @ApiOkResponse({ description: 'The QR token plus the names and dates printed beside it' })
  qrCard(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Client() client: ClientInfo,
  ): Promise<QrCard> {
    return this.memberships.qrCard(id, user, client);
  }

  @Post(':id/qr/reissue')
  @Roles(...KIDZONE_STAFF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Issue a new card and revoke the old one',
    description: `For a card that was **lost**, not merely left at home. A fresh token is minted and the printed card stops working immediately, so a reason is required and the rotation is audited as \`MEMBERSHIP_QR_REISSUED\`.

If the guardian simply forgot the card, check the child in by OTP instead — rotating the token would lock them out of the card they still have. A cancelled membership is refused with \`MEMBERSHIP_CANCELLED\`.`,
  })
  @ApiOkResponse({ description: 'The membership card, carrying the new token' })
  @ApiConflictResponse({ type: ApiErrorResponse, description: 'MEMBERSHIP_CANCELLED' })
  reissueQr(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReissueQrDto,
    @CurrentUser() user: AuthenticatedUser,
    @Client() client: ClientInfo,
  ): Promise<QrCard> {
    return this.memberships.reissueQr(id, dto, user, client);
  }

  @Post(':id/renew')
  @Roles(...KIDZONE_STAFF)
  @ApiOperation({
    summary: 'Renew a membership',
    description: `Creates a new sale and a new membership linked to the old one through \`renewedFromId\`.

Renewing **early** starts the new term the day after the current end date, so the customer keeps the days they already paid for. Renewing after it lapsed starts today. Pass \`planId\` to renew onto a different plan, e.g. upgrading from 3 to 6 months.`,
  })
  renew(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RenewMembershipDto,
    @CurrentUser() user: AuthenticatedUser,
    @Client() client: ClientInfo,
  ): Promise<SaleResult> {
    return this.sales.renew(id, dto, user, client);
  }
}

// ---------------------------------------------------------------------------
// Check-in
// ---------------------------------------------------------------------------

@ApiTags('Kid Zone / Check-in')
@ApiBearerAuth('access-token')
@Controller('kidzone/checkin')
export class CheckInController {
  constructor(private readonly checkin: CheckInService) {}

  @Post('lookup')
  @Roles(...KIDZONE_STAFF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Look up a guardian by phone',
    description:
      'Returns the guardian, their children and every membership with `daysRemaining`, `expiringSoon`, whether it is `usable` and, if not, `blockedReason` (expired, cancelled or not yet started). Also flags a child who is already inside.',
  })
  @ApiOkResponse({ description: 'The guardian, their children and each child’s memberships' })
  lookup(@Body() dto: CheckInLookupDto): Promise<LookupResult> {
    return this.checkin.lookup(dto);
  }

  @Post('otp/send')
  @Roles(...KIDZONE_STAFF)
  @SkipGlobalThrottle()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send a check-in OTP to the guardian',
    description: `A 6-digit code, valid for \`otpExpiryMinutes\` (5 by default). Only the hash is stored.

Rate limited three ways: a 60-second resend cooldown, at most 5 sends per number per hour, and a per-IP limit on this endpoint. Outside production the response also carries \`devCode\` so the flow can be exercised without a real SMS gateway.`,
  })
  sendOtp(@Body() dto: SendOtpDto): Promise<unknown> {
    return this.checkin.sendOtp(dto.phone);
  }

  @Post('otp/verify')
  @Roles(...KIDZONE_STAFF)
  @SkipGlobalThrottle()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify the OTP and check the child in',
    description:
      'After `otpMaxAttempts` wrong tries (5 by default) the code is invalidated and a new one must be requested. On success the code is consumed and a visit is created with `verificationMethod = OTP`.',
  })
  @ApiConflictResponse({
    type: ApiErrorResponse,
    description: 'MEMBERSHIP_EXPIRED (includes the end date), MEMBERSHIP_NOT_STARTED, CHILD_ALREADY_CHECKED_IN',
  })
  verifyOtp(
    @Body() dto: VerifyOtpDto,
    @CurrentUser() user: AuthenticatedUser,
    @Client() client: ClientInfo,
  ): Promise<CheckInResult> {
    return this.checkin.checkInWithOtp(dto, user, client);
  }

  @Post('qr')
  @Roles(...KIDZONE_STAFF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Check in by scanning the membership QR code',
    description: 'No SMS is sent. The same membership rules apply as for OTP. An unknown token returns `QR_INVALID`.',
  })
  qr(
    @Body() dto: QrCheckInDto,
    @CurrentUser() user: AuthenticatedUser,
    @Client() client: ClientInfo,
  ): Promise<CheckInResult> {
    return this.checkin.checkInWithQr(dto, user, client);
  }

  @Post('manual')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Manual check-in override',
    description:
      'Admin only. For a dead phone or an SMS outage. Verification is skipped, so a reason is required and the action is audited as `MANUAL_CHECKIN`. Expired, cancelled and not-yet-started memberships are still refused.',
  })
  manual(
    @Body() dto: ManualCheckInDto,
    @CurrentUser() user: AuthenticatedUser,
    @Client() client: ClientInfo,
  ): Promise<CheckInResult> {
    return this.checkin.checkInManually(dto, user, client);
  }
}

// ---------------------------------------------------------------------------
// Visits
// ---------------------------------------------------------------------------

@ApiTags('Kid Zone / Visits')
@ApiBearerAuth('access-token')
@Controller('kidzone/visits')
export class VisitsController {
  constructor(private readonly visits: VisitsService) {}

  @Get('active')
  @Roles(...KIDZONE_STAFF)
  @ApiOperation({
    summary: 'Who is inside right now',
    description:
      'The live gate board. Each visit carries `elapsedMinutes`, `remainingMinutes` (negative once over), `isOvertime`, `withinGrace` and the `projectedOvertimeCharge` in poisha if they left now. Sorted with overtime visits first.',
  })
  listActive(): Promise<unknown[]> {
    return this.visits.listActive();
  }

  @Get()
  @Roles(...KIDZONE_STAFF)
  @ApiOperation({ summary: 'The visit log', description: 'Filter by `from`/`to` business date, child, customer, membership, status or verification method.' })
  list(@Query() query: QueryVisitsDto): Promise<PageResult<unknown>> {
    return this.visits.list(query);
  }

  @Get(':id')
  @Roles(...KIDZONE_STAFF)
  @ApiOperation({ summary: 'One visit' })
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<unknown> {
    return this.visits.findOne(id);
  }

  @Post(':id/checkout')
  @Roles(...KIDZONE_STAFF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Check a child out',
    description: `Computes overtime server-side: \`max(0, elapsed - sessionMinutes - gracePeriodMinutes)\`, billed as whole started blocks of \`overtimeBlockMinutes\` at \`overtimeRatePerBlock\` poisha each.

If anything is owed, \`payments\` must be supplied covering **exactly** that amount, otherwise the request is refused with \`OVERTIME_PAYMENT_REQUIRED\` (402) and the amount due. Membership visits are open ended and are never charged overtime.`,
  })
  checkOut(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CheckOutDto,
    @CurrentUser() user: AuthenticatedUser,
    @Client() client: ClientInfo,
  ): Promise<unknown> {
    return this.visits.checkOut(id, dto, user, client);
  }
}
