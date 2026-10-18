import { ForbiddenException, HttpException } from '@nestjs/common';
import { MenuKey } from '@veetracer/shared';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsUUID } from 'class-validator';
import { hasPermission } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';
import { httpErrorFromPrisma } from './prisma-errors';

export class BulkActionDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(1000) @IsUUID('all', { each: true }) ids!: string[];
  @IsIn(['activate', 'deactivate', 'delete']) action!: 'activate' | 'deactivate' | 'delete';
}

export interface BulkResult {
  succeeded: string[];
  failed: { id: string; message: string }[];
}

export interface BulkHandlers {
  setActive: (id: string, active: boolean) => Promise<unknown>;
  remove: (id: string) => Promise<unknown>;
}

/**
 * Apply a bulk action one record at a time so each write is validated and audited like a single edit.
 * The route itself requires `edit`; deleting additionally requires `delete` on the menu.
 */
export async function runBulk(
  ctx: AuthContext,
  menu: MenuKey,
  dto: BulkActionDto,
  handlers: BulkHandlers,
): Promise<BulkResult> {
  if (dto.action === 'delete' && !hasPermission(ctx, menu, 'delete')) throw new ForbiddenException('Permission denied');
  const result: BulkResult = { succeeded: [], failed: [] };
  for (const id of new Set(dto.ids)) {
    try {
      if (dto.action === 'delete') await handlers.remove(id);
      else await handlers.setActive(id, dto.action === 'activate');
      result.succeeded.push(id);
    } catch (error) {
      const http = error instanceof HttpException ? error : httpErrorFromPrisma(error);
      if (!http) throw error;
      result.failed.push({ id, message: http.message });
    }
  }
  return result;
}
