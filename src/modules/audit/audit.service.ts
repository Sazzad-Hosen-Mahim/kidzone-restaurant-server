import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService, PrismaExecutor } from '@/prisma/prisma.service';
import { AuditAction } from './audit.constants';

export interface AuditEntry {
  actorId: string | null;
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Append-only audit trail. Every money-touching or privileged action writes one
 * entry; there is deliberately no update or delete path, in the service or in
 * the controller layer.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records an entry. Pass `tx` when the action happens inside a transaction so
   * the audit row commits or rolls back together with the change it describes.
   */
  async record(entry: AuditEntry, tx?: PrismaExecutor): Promise<void> {
    const client = tx ?? this.prisma;
    await client.auditLog.create({
      data: {
        actorId: entry.actorId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        before: toJson(entry.before),
        after: toJson(entry.after),
        reason: entry.reason ?? null,
        ip: entry.ip ?? null,
        userAgent: entry.userAgent ?? null,
      },
    });
  }

  /**
   * Records an entry outside any transaction and never throws. Used for
   * side-channel events such as LOGIN, where losing an audit row must not fail
   * the user's request.
   */
  async recordSafe(entry: AuditEntry): Promise<void> {
    try {
      await this.record(entry);
    } catch (error) {
      this.logger.error(`Failed to write audit entry ${entry.action}`, error instanceof Error ? error.stack : error);
    }
  }
}

function toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === undefined || value === null) return Prisma.JsonNull;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
