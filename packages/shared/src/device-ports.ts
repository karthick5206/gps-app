/**
 * Device server port per protocol family (DeviceModel.protocol), as the gateway listens by default (GT06_PORT,
 * TELTONIKA_PORT, JT808_PORT, AIS140_PORT, ZHONGXUN_PORT). Shown next to the model when adding a device so installers know what to
 * set. Phone apps (MOBILE / PHONE) connect over HTTPS and have no port.
 */
export const DEVICE_PROTOCOL_PORTS: Record<string, number> = {
  GT06: 5023,
  TELTONIKA: 5027,
  JT808: 6808,
  AIS140: 5030,
  ZHONGXUN: 5032,
};

export const deviceProtocolPort = (protocol: string | null | undefined): number | null => DEVICE_PROTOCOL_PORTS[(protocol ?? '').toUpperCase()] ?? null;
