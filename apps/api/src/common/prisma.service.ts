import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { prisma } from '@clipforge/database';

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly client = prisma;

  async onModuleInit(): Promise<void> {
    try { await this.client.$connect(); }
    catch (cause) { throw new Error('PostgreSQL initialization failed. Check DATABASE_URL, credentials, TLS and network access.', { cause }); }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
