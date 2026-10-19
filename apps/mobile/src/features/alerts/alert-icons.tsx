import type { AlertSeverity, AlertTypeCode } from '@veetracer/shared';
import { View } from 'react-native';
import {
  ArrowDownToDotIcon,
  BatteryLowIcon,
  BatteryWarningIcon,
  BellIcon,
  CameraOffIcon,
  CarFrontIcon,
  CigaretteIcon,
  ClockAlertIcon,
  CloudAlertIcon,
  DropletOffIcon,
  EyeOffIcon,
  FileClockIcon,
  FileXIcon,
  FuelIcon,
  GaugeIcon,
  HourglassIcon,
  KeyRoundIcon,
  LogInIcon,
  LogOutIcon,
  MapPinnedIcon,
  MapPinOffIcon,
  MoveHorizontalIcon,
  OctagonAlertIcon,
  PowerOffIcon,
  ScanEyeIcon,
  ShieldAlertIcon,
  ShieldQuestionIcon,
  SignalLowIcon,
  SirenIcon,
  SmartphoneIcon,
  TimerIcon,
  UnplugIcon,
  UserXIcon,
  WifiOffIcon,
  WrenchIcon,
  type LucideIcon,
} from 'lucide-react-native';


/** One recognisable glyph per alert type; the colour comes from the severity. */
export const ALERT_ICON: Record<AlertTypeCode, LucideIcon> = {
  OVERSPEED: GaugeIcon,
  IDLING: HourglassIcon,
  IGNITION_ON: KeyRoundIcon,
  IGNITION_OFF: PowerOffIcon,
  GEOFENCE_ENTER: LogInIcon,
  GEOFENCE_EXIT: LogOutIcon,
  GEOFENCE_STAY: TimerIcon,
  GEOFENCE_OVERSPEED: MapPinnedIcon,
  POWER_CUT: UnplugIcon,
  SOS: SirenIcon,
  LOW_BATTERY: BatteryLowIcon,
  DEVICE_OFFLINE: WifiOffIcon,
  GPS_LOST: MapPinOffIcon,
  GSM_WEAK: SignalLowIcon,
  DATA_DELAYED: CloudAlertIcon,
  CLOCK_ERROR: ClockAlertIcon,
  POWER_LOW: BatteryWarningIcon,
  DEVICE_TAMPER: ShieldAlertIcon,
  UNKNOWN_ALARM: ShieldQuestionIcon,
  DRIVER_FATIGUE: EyeOffIcon,
  DRIVER_PHONE: SmartphoneIcon,
  DRIVER_SMOKING: CigaretteIcon,
  DRIVER_DISTRACTED: ScanEyeIcon,
  DRIVER_ABSENT: UserXIcon,
  FORWARD_COLLISION_WARNING: CarFrontIcon,
  LANE_DEPARTURE: MoveHorizontalIcon,
  TAILGATING: ArrowDownToDotIcon,
  CAMERA_FAULT: CameraOffIcon,
  CRASH: OctagonAlertIcon,
  DOCUMENT_EXPIRING: FileClockIcon,
  DOCUMENT_EXPIRED: FileXIcon,
  SERVICE_DUE: WrenchIcon,
  FUEL_DRAIN: DropletOffIcon,
  FUEL_REFILL: FuelIcon,
};

export const alertIcon = (type: string): LucideIcon => ALERT_ICON[type as AlertTypeCode] ?? BellIcon;

export const SEVERITY_COLOR: Record<AlertSeverity, string> = { INFO: '#2563eb', WARNING: '#d97706', CRITICAL: '#dc2626' };
export const SEVERITY_LABEL: Record<AlertSeverity, string> = { INFO: 'Info', WARNING: 'Warning', CRITICAL: 'Critical' };

/** Alert type glyph in a round badge tinted by severity (same look as the web app). */
export function AlertTypeIcon({ type, severity, size = 34 }: { type: string; severity: AlertSeverity; size?: number }) {
  const Icon = alertIcon(type);
  const color = SEVERITY_COLOR[severity];
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: `${color}1f`, alignItems: 'center', justifyContent: 'center' }}>
      <Icon size={Math.round(size * 0.53)} color={color} />
    </View>
  );
}
