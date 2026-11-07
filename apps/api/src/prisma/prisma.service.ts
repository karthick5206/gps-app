import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { withSoftDelete } from './soft-delete';

/**
 * The database client for the API. Soft-deleted rows ("Delete") are hidden from every read (see soft-delete.ts); the
 * constructor hands Nest the extended client, which keeps the lifecycle hooks below.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super();
    const extended = withSoftDelete(this as PrismaClient) as unknown as PrismaService;
    // The extended client is a new object: give it the hooks Nest calls.
    return new Proxy(extended, {
      get(target, prop) {
        if (prop === 'onModuleInit') return () => (target as PrismaClient).$connect();
        if (prop === 'onModuleDestroy') return () => (target as PrismaClient).$disconnect();
        return Reflect.get(target, prop);
      },
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
