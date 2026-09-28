import { INestApplication, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

/** The Prisma transaction client handed to `$transaction` callbacks. */
export type PrismaTransaction = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/** Anything that can run a query: the root client or an open transaction. */
export type PrismaExecutor = PrismaClient | PrismaTransaction;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log:
        process.env.NODE_ENV === 'development'
          ? [{ emit: 'event', level: 'warn' }, { emit: 'event', level: 'error' }]
          : [{ emit: 'event', level: 'error' }],
      errorFormat: 'minimal',
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Connected to PostgreSQL');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  async enableShutdownHooks(app: INestApplication): Promise<void> {
    process.on('beforeExit', () => {
      void app.close();
    });
  }

  /**
   * Runs `fn` inside a transaction, or reuses `existing` when the caller is
   * already inside one. Lets a service compose without opening nested
   * transactions, which Postgres would otherwise turn into savepoints.
   */
  runInTransaction<T>(
    fn: (tx: PrismaTransaction) => Promise<T>,
    existing?: PrismaTransaction,
    options?: { timeout?: number; maxWait?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
  ): Promise<T> {
    if (existing) return fn(existing);
    return this.$transaction(fn, {
      maxWait: options?.maxWait ?? 5_000,
      timeout: options?.timeout ?? 15_000,
      ...(options?.isolationLevel ? { isolationLevel: options.isolationLevel } : {}),
    });
  }

  /**
   * Truncates every table. Used only by the e2e harness between suites; refuses
   * to run outside NODE_ENV=test so it can never be aimed at a real database.
   */
  async truncateAll(): Promise<void> {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('truncateAll() is only available when NODE_ENV=test');
    }
    const tables = await this.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%'
    `;
    if (tables.length === 0) return;
    const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
    await this.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  }
}
