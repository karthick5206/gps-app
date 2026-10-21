import { parseDeviceInfo } from '@veetracer/shared';

describe('parseDeviceInfo (command replies)', () => {
  it('reads Concox and Teltonika version replies and an ICCID', () => {
    expect(parseDeviceInfo('[VERSION]GT06N_20_A1D_D23_R0_V02')).toEqual({ version: 'GT06N_20_A1D_D23_R0_V02' });
    expect(parseDeviceInfo('Ver:03.27.07_04 GPS:AXN_5.10_3333 Hw:FMB920 Mod:13 IMEI:352093080000000')).toMatchObject({ version: '03.27.07_04' });
    expect(parseDeviceInfo('ICCID:89914500001234567890')).toEqual({ iccid: '89914500001234567890' });
    expect(parseDeviceInfo('IMEI:352093080000000 ICCID:8991450000123456789F')).toMatchObject({ iccid: '8991450000123456789' });
    expect(parseDeviceInfo('OK')).toEqual({});
  });
});
