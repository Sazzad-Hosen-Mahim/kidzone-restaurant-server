import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import type { CookieOptions, Request, Response } from 'express';
import { Public } from '@common/decorators/public.decorator';
import { Roles } from '@common/decorators/roles.decorator';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { Client, ClientInfo } from '@common/decorators/client-info.decorator';
import { LoginThrottlerGuard } from '@common/guards/login-throttler.guard';
import { SkipGlobalThrottle } from '@common/decorators/skip-global-throttle.decorator';
import { AuthenticatedUser } from '@common/types/authenticated-user';
import { ApiErrorResponse } from '@common/http/api-response';
import { AppConfigService } from '@config/app-config.service';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginResponseDto, MeResponseDto } from './dto/auth-response.dto';

const ALL_ROLES = [Role.ADMIN, Role.KIDZONE_MANAGER, Role.RESTAURANT_CASHIER];

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfigService,
  ) {}

  @Post('login')
  @Public()
  @SkipGlobalThrottle()
  @UseGuards(LoginThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Log in with a phone number or email and a password',
    description:
      'Returns a 15-minute access token in the body and sets a rotating 7-day refresh token in an httpOnly cookie. Limited to 5 attempts per minute per IP and per identifier. Deactivated accounts are rejected with the same generic message as a wrong password.',
  })
  @ApiBody({ type: LoginDto })
  @ApiOkResponse({ type: LoginResponseDto })
  @ApiUnauthorizedResponse({ type: ApiErrorResponse, description: 'Invalid credentials' })
  @ApiTooManyRequestsResponse({ type: ApiErrorResponse, description: 'TOO_MANY_LOGIN_ATTEMPTS' })
  async login(
    @Body() dto: LoginDto,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginResponseDto> {
    const { user, tokens } = await this.auth.login(dto, client);
    this.setRefreshCookie(response, tokens.refreshToken, tokens.refreshTokenExpiresAt);
    return {
      user,
      accessToken: tokens.accessToken,
      expiresIn: tokens.accessTokenExpiresIn,
      tokenType: 'Bearer',
    };
  }

  @Post('refresh')
  @Public()
  @SkipGlobalThrottle()
  @UseGuards(LoginThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth('refresh-cookie')
  @ApiOperation({
    summary: 'Rotate the refresh token and get a new access token',
    description:
      'Reads the refresh token from the httpOnly cookie, revokes it and issues a fresh pair. Presenting an already-rotated token is treated as theft: every session for that user is revoked. Deactivated accounts are rejected here too.',
  })
  @ApiOkResponse({ type: LoginResponseDto })
  @ApiUnauthorizedResponse({ type: ApiErrorResponse })
  async refresh(
    @Req() request: Request,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginResponseDto> {
    const token = this.readRefreshCookie(request);
    if (!token) throw new UnauthorizedException('No refresh token was supplied');

    try {
      const { user, tokens } = await this.auth.refresh(token, client);
      this.setRefreshCookie(response, tokens.refreshToken, tokens.refreshTokenExpiresAt);
      return {
        user,
        accessToken: tokens.accessToken,
        expiresIn: tokens.accessTokenExpiresIn,
        tokenType: 'Bearer',
      };
    } catch (error) {
      this.clearRefreshCookie(response);
      throw error;
    }
  }

  @Post('logout')
  @Roles(...ALL_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Log out',
    description: 'Revokes the presented refresh token and clears the cookie. Other devices stay logged in.',
  })
  async logout(
    @Req() request: Request,
    @CurrentUser() user: AuthenticatedUser,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ success: true }> {
    await this.auth.logout(this.readRefreshCookie(request), user, client);
    this.clearRefreshCookie(response);
    return { success: true };
  }

  @Get('me')
  @Roles(...ALL_ROLES)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'The signed-in user', description: 'Returns the caller’s profile and role.' })
  @ApiOkResponse({ type: MeResponseDto })
  me(@CurrentUser() user: AuthenticatedUser): Promise<MeResponseDto> {
    return this.auth.me(user.id);
  }

  @Patch('change-password')
  @Roles(...ALL_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Change your own password',
    description:
      'Requires the current password. On success every session — including this one — is revoked, so the client must log in again.',
  })
  async changePassword(
    @Body() dto: ChangePasswordDto,
    @CurrentUser() user: AuthenticatedUser,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ success: true }> {
    await this.auth.changePassword(user.id, dto.currentPassword, dto.newPassword, client);
    this.clearRefreshCookie(response);
    return { success: true };
  }

  // -------------------------------------------------------------------------
  // Refresh cookie
  // -------------------------------------------------------------------------

  private cookieOptions(expires?: Date): CookieOptions {
    const domain = this.config.get('COOKIE_DOMAIN');
    return {
      httpOnly: true,
      secure: this.config.get('COOKIE_SECURE'),
      sameSite: this.config.get('COOKIE_SAME_SITE'),
      // Scoped to the refresh and logout routes so the token is not attached to
      // every API call the browser makes.
      path: `/${this.config.get('API_PREFIX')}/auth`,
      ...(domain ? { domain } : {}),
      ...(expires ? { expires } : {}),
    };
  }

  private setRefreshCookie(response: Response, token: string, expiresAt: Date): void {
    response.cookie(this.config.get('REFRESH_COOKIE_NAME'), token, this.cookieOptions(expiresAt));
  }

  private clearRefreshCookie(response: Response): void {
    response.clearCookie(this.config.get('REFRESH_COOKIE_NAME'), this.cookieOptions());
  }

  private readRefreshCookie(request: Request): string | undefined {
    const cookies = request.cookies as Record<string, string> | undefined;
    return cookies?.[this.config.get('REFRESH_COOKIE_NAME')];
  }
}
