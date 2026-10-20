import { BadRequestException } from '@nestjs/common';
import { MOBILE_TRACKER_PROTOCOL, normalizeMobile } from '@veetracer/shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * A mobile-tracker device's uniqueId is the phone's mobile number, stored as E.164 digits (919876543210) so the
 * Tracker app finds it whatever format the admin typed. Other devices keep their IMEI as entered.
 */
export async function normalizeDeviceUniqueId(prisma: PrismaService, modelId: string, uniqueId: string): Promise<string> {
  const model = await prisma.deviceModel.findUnique({ where: { id: modelId }, select: { protocol: true } });
  if (model?.protocol !== MOBILE_TRACKER_PROTOCOL) return uniqueId;
  const mobile = normalizeMobile(uniqueId);
  if (!mobile) throw new BadRequestException('Enter the mobile number of the phone (10 digits, or with country code)');
  return mobile;
}
