/**
 * Normalised position attribute keys shared by every protocol decoder, so alerts and UI work across brands.
 * Vendor-specific extras are kept alongside under their own (documented) names.
 */

export const NORMALIZED_ALARMS = [
  'sos',
  'powerCut',
  'lowBattery',
  'vibration',
  'overspeed',
  'tamper',
  'harshAcceleration',
  'harshBraking',
  'harshCornering',
  'crash',
  'towing',
  'jamming',
  'geofenceEnter',
  'geofenceExit',
] as const;
export type NormalizedAlarm = (typeof NORMALIZED_ALARMS)[number];

/** Keys used by decoders (documentation + typo guard in tests). */
export const ATTR = {
  batteryLevel: 'batteryLevel', // %
  batteryVoltage: 'batteryVoltage', // V (internal backup battery)
  extVoltage: 'extVoltage', // V (vehicle supply)
  gsmSignal: 'gsmSignal', // 0..4 (web labels: No signal, Weak, Fair, Good, Excellent)
  charging: 'charging',
  alarm: 'alarm',
  odometerM: 'odometerM',
  hdop: 'hdop',
  pdop: 'pdop',
  driverId: 'driverId',
  iccid: 'iccid',
  mcc: 'mcc',
  mnc: 'mnc',
  lac: 'lac',
  cellId: 'cellId',
  commandResponse: 'commandResponse',
  event: 'event',
  motion: 'motion',
  // Fuel (normalised across protocols; the processor adds calibrated `fuelL` per the vehicle's fuel settings)
  fuelLevelPct: 'fuelLevelPct', // % of tank (CAN bus, Teltonika IO 89)
  fuelLevelL: 'fuelLevelL', // litres reported by the vehicle / tracker (CAN IO 84; JT/T 808 extra 0x02)
  fuelUsedL: 'fuelUsedL', // total fuel used, litres (CAN IO 83)
  fuelSensorRaw: 'fuelSensorRaw', // LLS fuel level sensor raw value (Teltonika IO 201; IO 203 = fuelSensorRaw2)
  fuelSensorTemp: 'fuelSensorTemp', // LLS sensor temperature °C (IO 202; IO 204 = fuelSensorTemp2)
  adc1: 'adc1', // analog input 1, volts (Teltonika AIN1 = IO 9 in mV; analog fuel sensors are calibrated in mV)
  fuelL: 'fuelL', // calibrated litres, written by the processor
  adc2: 'adc2', // analog input 2, volts (Teltonika AIN2 = IO 10 in mV)
  // Digital inputs (AC / door sensors read these; see IoSensorConfig)
  door: 'door', // door switch (GT06 0x94 sub-type 0x05 bit 0)
  in1: 'in1', // digital input 1 (Teltonika DIN1; GT06 0x94/0x05 bit 2)
  in2: 'in2', // digital input 2 (Teltonika DIN2; GT06 0x94/0x05 bit 1, unverified)
  in3: 'in3', // digital input 3 (Teltonika DIN3 = IO 3)
  in4: 'in4', // digital input 4 (Teltonika DIN4 = IO 4)
  ac: 'ac', // AC on (debounced), written by the processor when an AC sensor is configured
  doorOpen: 'doorOpen', // door open (debounced), written by the processor when a door sensor is configured
  // OBD (GT06 0x8C; per public spec, verify units with a device capture)
  rpm: 'rpm', // engine rpm
  coolantTemp: 'coolantTemp', // °C
  engineLoad: 'engineLoad', // % (reserved: no GT06 key mapped yet)
  obdSpeedKph: 'obdSpeedKph', // vehicle speed from the ECU, km/h
  obdOdometerKm: 'obdOdometerKm', // ECU odometer, km
  engineHours: 'engineHours', // h
  dtcs: 'dtcs', // diagnostic trouble codes, comma-separated (reserved)
  // RFID: driverId carries the card; `rfid` repeats it on the swipe event (event = 'rfid')
  rfid: 'rfid',
  reupload: 'reupload', // history / buffered record
  emergency: 'emergency', // AIS-140 emergency status (panic button state)
} as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** GSM signal on the normalised 0..4 scale from a 0..5 level (Teltonika IO 21). GT06 already reports 0..4. */
export function gsmFromLevel5(level: number): number {
  return Math.round((clamp(level, 0, 5) * 4) / 5);
}

/** GSM signal on the normalised 0..4 scale from a modem CSQ value (0..31, 99 = unknown). */
export function gsmFromCsq(csq: number): number | null {
  if (!Number.isFinite(csq) || csq < 0 || csq === 99 || csq > 31) return null;
  if (csq === 0) return 0;
  return clamp(Math.round((csq * 4) / 31), 1, 4);
}

/** Drop null/undefined/NaN values so stored attribute JSON stays small. */
export function compact(attrs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'number' && !Number.isFinite(v)) continue;
    out[k] = v;
  }
  return out;
}

export const round = (value: number, digits = 2): number => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};
