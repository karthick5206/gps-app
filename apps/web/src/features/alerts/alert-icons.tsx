import type { AlertSeverity, AlertTypeCode } from '@veetracer/shared';
import {
  AirVentIcon,
  ArrowDownToDotIcon,
  DoorClosedIcon,
  DoorOpenIcon,
  SnowflakeIcon,
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
  OctagonMinusIcon,
  CornerUpRightIcon,
  PowerOffIcon,
  ScanEyeIcon,
  ShieldAlertIcon,
  ShieldQuestionIcon,
  SignalLowIcon,
  SirenIcon,
  TruckIcon,
  LocateOffIcon,
  VibrateIcon,
  SmartphoneIcon,
  TimerIcon,
  UnplugIcon,
  UserXIcon,
  CardSimIcon,
  WifiIcon,
  WifiOffIcon,
  WrenchIcon,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { SEVERITY_COLOR, SEVERITY_LABEL } from './severity';

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
  DEVICE_ONLINE: WifiIcon,
  SIM_CHANGED: CardSimIcon,
  GPS_LOST: MapPinOffIcon,
  GSM_WEAK: SignalLowIcon,
  DATA_DELAYED: CloudAlertIcon,
  CLOCK_ERROR: ClockAlertIcon,
  POWER_LOW: BatteryWarningIcon,
  DEVICE_TAMPER: ShieldAlertIcon,
  UNKNOWN_ALARM: ShieldQuestionIcon,
  GPS_FAULT: LocateOffIcon,
  VIBRATION: VibrateIcon,
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
  TOWING: TruckIcon,
  PARKING_BREACH: TruckIcon,
  HARSH_ACCELERATION: GaugeIcon,
  HARSH_BRAKING: OctagonMinusIcon,
  HARSH_CORNERING: CornerUpRightIcon,
  DOCUMENT_EXPIRING: FileClockIcon,
  DOCUMENT_EXPIRED: FileXIcon,
  SERVICE_DUE: WrenchIcon,
  FUEL_DRAIN: DropletOffIcon,
  FUEL_REFILL: FuelIcon,
  AC_ON: SnowflakeIcon,
  AC_OFF: SnowflakeIcon,
  AC_ON_ENGINE_OFF: AirVentIcon,
  DOOR_OPEN: DoorOpenIcon,
  DOOR_CLOSED: DoorClosedIcon,
  DOOR_OPEN_WHILE_MOVING: DoorOpenIcon,
};

export const alertIcon = (type: string): LucideIcon => ALERT_ICON[type as AlertTypeCode] ?? BellIcon;

/** Alert type glyph in a round badge tinted by severity. */
export function AlertTypeIcon({ type, severity, size = 'md', className }: { type: string; severity: AlertSeverity; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const { t } = useTranslation();
  const Icon = alertIcon(type);
  const color = SEVERITY_COLOR[severity];
  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full', size === 'sm' ? 'size-6' : size === 'lg' ? 'size-9' : 'size-7', className)}
      style={{ backgroundColor: `${color}1f`, color }}
      title={t(SEVERITY_LABEL[severity])}
    >
      <Icon className={size === 'sm' ? 'size-3.5' : size === 'lg' ? 'size-5' : 'size-4'} aria-hidden />
    </span>
  );
}
