import type { AlertSeverity, AlertTypeCode } from '@veetracer/shared';
import {
  BatteryLowIcon,
  BatteryWarningIcon,
  BellIcon,
  ClockAlertIcon,
  CloudAlertIcon,
  GaugeIcon,
  HourglassIcon,
  KeyRoundIcon,
  LogInIcon,
  LogOutIcon,
  MapPinnedIcon,
  MapPinOffIcon,
  PowerOffIcon,
  ShieldAlertIcon,
  SignalLowIcon,
  SirenIcon,
  TimerIcon,
  UnplugIcon,
  WifiOffIcon,
  type LucideIcon,
} from 'lucide-react';
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
  GPS_LOST: MapPinOffIcon,
  GSM_WEAK: SignalLowIcon,
  DATA_DELAYED: CloudAlertIcon,
  CLOCK_ERROR: ClockAlertIcon,
  POWER_LOW: BatteryWarningIcon,
  DEVICE_TAMPER: ShieldAlertIcon,
};

export const alertIcon = (type: string): LucideIcon => ALERT_ICON[type as AlertTypeCode] ?? BellIcon;

/** Alert type glyph in a round badge tinted by severity. */
export function AlertTypeIcon({ type, severity, size = 'md', className }: { type: string; severity: AlertSeverity; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const Icon = alertIcon(type);
  const color = SEVERITY_COLOR[severity];
  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full', size === 'sm' ? 'size-6' : size === 'lg' ? 'size-9' : 'size-7', className)}
      style={{ backgroundColor: `${color}1f`, color }}
      title={SEVERITY_LABEL[severity]}
    >
      <Icon className={size === 'sm' ? 'size-3.5' : size === 'lg' ? 'size-5' : 'size-4'} aria-hidden />
    </span>
  );
}
