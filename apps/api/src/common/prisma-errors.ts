import { ConflictException, HttpException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export const IN_USE_MESSAGE = 'In use (has history or links) — deactivate it instead, or ask a Super Admin to delete it permanently';

/** Translate known Prisma errors into HTTP errors; returns null for anything else. */
export function httpErrorFromPrisma(error: unknown): HttpException | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  switch (error.code) {
    case 'P2002': {
      const target = error.meta?.target;
      const fields = Array.isArray(target) ? target.filter((f) => f !== 'companyId').join(', ') : 'Value';
      return new ConflictException(`${fields || 'Value'} already exists`);
    }
    case 'P2003':
    case 'P2014':
      return new ConflictException(IN_USE_MESSAGE);
    case 'P2025':
      return new NotFoundException('Not found');
    default:
      return null;
  }
}
