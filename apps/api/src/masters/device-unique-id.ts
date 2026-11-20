import { BadRequestException } from '@nestjs/common';
import { MOBILE_TRACKER_PROTOCOL, normalizeMobile } from '@veetracer/shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * JT808 terminals send their id as 12 BCD digits ("014800018486") and the gateway drops the leading zeros
 * ("14800018486"), so a JT808 device is stored without them; the admin may type either form.
 */
export function stripJt808LeadingZeros(protocol: string | null | undefined, uniqueId: string): string {
  if ((protocol ?? '').toLowerCase() !== 'jt808') return uniqueId;
  const trimmed = uniqueId.trim();
  return /^\d+$/.test(trimmed) ? trimmed.replace(/^0+(?=\d)/, '') : uniqueId;
}

/**
 * Normalises a device's uniqueId from its model's protocol:
 * - mobile tracker: the phone's mobile number as E.164 digits (919876543210), whatever format the admin typed;
 * - JT808: without leading zeros (see stripJt808LeadingZeros);
 * - other devices keep their IMEI as entered.
 */
export function normalizeUniqueIdForProtocol(protocol: string | null | undefined, uniqueId: string): string {
  if (protocol === MOBILE_TRACKER_PROTOCOL) {
    const mobile = normalizeMobile(uniqueId);
    if (!mobile) throw new BadRequestException('Enter the mobile number of the phone (10 digits, or with country code)');
    return mobile;
  }
  return stripJt808LeadingZeros(protocol, uniqueId);
}

export async function normalizeDeviceUniqueId(prisma: PrismaService, modelId: string, uniqueId: string): Promise<string> {
  const model = await prisma.deviceModel.findUnique({ where: { id: modelId }, select: { protocol: true } });
  return normalizeUniqueIdForProtocol(model?.protocol, uniqueId);
}
