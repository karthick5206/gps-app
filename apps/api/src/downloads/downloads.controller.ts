import { Controller, Get, NotFoundException, Param, Res, StreamableFile } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Response } from 'express';
import { Public } from '../access/decorators';
import { APP_ROOT } from '../config/env';
import { APK_NAME, latestApks, type ApkFile } from './downloads';

/** C:\apps\veetracer\downloads on the server (outside the app checkout, so deploys don't touch it). */
const DIR = process.env.DOWNLOADS_DIR || join(APP_ROOT, '..', '..', '..', 'downloads');

/** Public app downloads for the /download page and the e-mails: the newest VeeTrax and VeeTrax Tracker APKs. */
@Controller('downloads')
export class DownloadsController {
  @Public() @Get()
  async list(): Promise<ApkFile[]> {
    const names = await readdir(DIR).catch(() => [] as string[]);
    const files = await Promise.all(names.filter((n) => APK_NAME.test(n)).map(async (name) => ({ name, size: (await stat(join(DIR, name))).size })));
    return latestApks(files);
  }

  @Public() @Get(':file') @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async file(@Param('file') file: string, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    if (!APK_NAME.test(file)) throw new NotFoundException();
    const path = join(DIR, file);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw new NotFoundException();
    res.set({ 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': String(info.size), 'Content-Disposition': `attachment; filename="${file}"`, 'Cache-Control': 'public, max-age=3600' });
    return new StreamableFile(createReadStream(path));
  }
}
