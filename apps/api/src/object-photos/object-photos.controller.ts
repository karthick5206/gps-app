import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { OBJECT_PHOTO_MAX_BYTES } from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { Auth, RequireAnyPermission, RequirePermission } from '../access/decorators';
import { parsePhotoSize } from './object-photo-access';
import { UploadedPhoto } from './object-photo-image';
import { ObjectPhotoState, ObjectPhotosService } from './object-photos.service';

/** Person / pet / asset photo of a tracked object (web, mobile). No public URL: always through this endpoint. */
@Controller('objects')
export class ObjectPhotosController {
  constructor(private readonly service: ObjectPhotosService) {}

  /** `size=thumb` (64 px, map markers) or `full` (256 px). `v` is the photo version, only there to bust caches. */
  @Get(':id/photo') @RequireAnyPermission(['objects', 'view'], ['live_map', 'view'])
  file(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query('size') size?: string): Promise<StreamableFile> {
    return this.service.file(ctx, id, parsePhotoSize(size));
  }

  /** Upload or replace: multipart `file`, JPEG / PNG / WebP up to 5 MB. */
  @Post(':id/photo') @HttpCode(200) @RequirePermission('objects', 'edit')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: OBJECT_PHOTO_MAX_BYTES, files: 1 } }))
  upload(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file?: UploadedPhoto): Promise<ObjectPhotoState> {
    return this.service.upload(ctx, id, file);
  }

  @Delete(':id/photo') @RequirePermission('objects', 'edit')
  remove(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<ObjectPhotoState> {
    return this.service.remove(ctx, id);
  }
}
