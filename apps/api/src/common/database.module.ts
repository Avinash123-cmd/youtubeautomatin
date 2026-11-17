import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/** One lifecycle owner for the shared Prisma client, not one per feature module. */
@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class DatabaseModule {}
