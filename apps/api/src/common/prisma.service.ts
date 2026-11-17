import { StartupDependencyError } from './startup-error';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { env } from './env';
import { boundedProbe } from './health-probe';
import { prisma } from '@clipforge/database';

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly client = prisma;

  async onModuleInit(): Promise<void> {
    try {
      await boundedProbe(async () => {
        await this.client.$connect();
        // Also catches a missing/unapplied application schema before the API accepts requests.
        await this.client.$queryRaw`SELECT 1 FROM "ProcessingJob" LIMIT 1`;
      }, env.HEALTHCHECK_TIMEOUT_MS);
    } catch {
      throw new StartupDependencyError('postgres');
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
