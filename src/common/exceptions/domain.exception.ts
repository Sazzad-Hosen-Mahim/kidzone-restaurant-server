import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * A business-rule failure with a stable machine-readable code, so the frontend
 * can branch on `error` instead of matching on message text.
 *
 * Example: rejecting an expired membership returns
 * `{ statusCode: 409, error: "MEMBERSHIP_EXPIRED", message: "…", details: { endDate } }`.
 */
export class DomainException extends HttpException {
  constructor(
    readonly code: string,
    message: string,
    status: HttpStatus = HttpStatus.CONFLICT,
    readonly details?: unknown,
  ) {
    super({ statusCode: status, error: code, message, details }, status);
  }
}

/** 404 with a stable code. */
export class NotFoundDomainException extends DomainException {
  constructor(entity: string, identifier?: string) {
    super(
      `${entity.toUpperCase().replace(/\s+/g, '_')}_NOT_FOUND`,
      identifier ? `${entity} "${identifier}" was not found` : `${entity} was not found`,
      HttpStatus.NOT_FOUND,
    );
  }
}

/** 422 for input that parsed but cannot be acted on. */
export class UnprocessableDomainException extends DomainException {
  constructor(code: string, message: string, details?: unknown) {
    super(code, message, HttpStatus.UNPROCESSABLE_ENTITY, details);
  }
}

/** 403 for a permission the caller's role does not carry. */
export class ForbiddenDomainException extends DomainException {
  constructor(code: string, message: string, details?: unknown) {
    super(code, message, HttpStatus.FORBIDDEN, details);
  }
}
