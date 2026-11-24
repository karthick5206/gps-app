import { Body, Controller, HttpCode, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { DRIVER_MEDIA_MAX_VIDEO_BYTES } from '@veetracer/shared';
import { Public } from '../access/decorators';
import { DvrUploadService, JimiUploadReply } from './dvr-upload.service';

/**
 * Device-facing upload endpoint for Jimi dashcams (no user login: the request is checked by the firmware's `sign`).
 * Public URLs: https://app.veetrax.com/api/dvr/jimi/upload and http://track.veetrax.com/dvr/upload (Caddy rewrite,
 * for firmware without HTTPS).
 */
@Controller('dvr')
export class DvrUploadController {
  constructor(private readonly service: DvrUploadService) {}

  @Public() @Post('jimi/upload') @HttpCode(200) @Throttle({ default: { ttl: 60_000, limit: 120 } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: DRIVER_MEDIA_MAX_VIDEO_BYTES, files: 1 } }))
  upload(
    @UploadedFile() file: { buffer: Buffer; originalname?: string } | undefined,
    @Body() body: Record<string, string | undefined>,
    @Query() query: Record<string, string | undefined>,
  ): Promise<JimiUploadReply> {
    // The vendor document lists filename / timestamp / sign as URL parameters; form fields are accepted too.
    const pick = (k: string) => body?.[k] ?? query?.[k];
    return this.service.upload({ file, filename: pick('filename'), timestamp: pick('timestamp'), sign: pick('sign') });
  }
}
