import { MENUS, type MenuDef, type MenuGroup, type MenuKey, type PermissionMap } from '@veetracer/shared';
import {
  ActivityIcon,
  IdCardIcon,
  ReceiptIndianRupeeIcon,
  SlidersHorizontalIcon,
  BellIcon,
  BellRingIcon,
  BoxesIcon,
  Building2Icon,
  CpuIcon,
  CodeXmlIcon,
  GaugeIcon,
  CalendarClockIcon,
  FileBarChartIcon,
  FileCheck2Icon,
  HardDriveIcon,
  HexagonIcon,
  HistoryIcon,
  LayersIcon,
  MailIcon,
  ListTreeIcon,
  MapIcon,
  MapPinIcon,
  RadarIcon,
  ScrollTextIcon,
  SettingsIcon,
  ShieldCheckIcon,
  TruckIcon,
  UsersIcon,
  VideoIcon,
  WarehouseIcon,
  type LucideIcon,
} from 'lucide-react';

export const MENU_ICONS: Record<MenuKey, LucideIcon> = {
  dashboard: GaugeIcon,
  live_map: MapIcon,
  video: VideoIcon,
  objects: TruckIcon,
  drivers: IdCardIcon,
  documents: FileCheck2Icon,
  devices: CpuIcon,
  vehicle_groups: LayersIcon,
  branches: WarehouseIcon,
  lookups: ListTreeIcon,
  users: UsersIcon,
  roles: ShieldCheckIcon,
  audit_log: ScrollTextIcon,
  settings: SettingsIcon,
  api: CodeXmlIcon,
  billing: ReceiptIndianRupeeIcon,
  sa_licences: ShieldCheckIcon,
  sa_platform_settings: SlidersHorizontalIcon,
  sa_companies: Building2Icon,
  sa_device_models: BoxesIcon,
  sa_device_inventory: HardDriveIcon,
  sa_unknown_devices: RadarIcon,
  sa_system_health: ActivityIcon,
  history: HistoryIcon,
  alerts: BellIcon,
  reports: FileBarChartIcon,
  geofences: HexagonIcon,
  pois: MapPinIcon,
  alert_settings: BellRingIcon,
  message_templates: MailIcon,
  report_schedules: CalendarClockIcon,
};

export const GROUP_LABELS: Record<MenuGroup, string> = {
  main: 'Main',
  masters: 'Masters',
  alerting: 'Alert Management',
  admin: 'Administration',
  platform: 'Platform',
};

const GROUP_ORDER: MenuGroup[] = ['main', 'masters', 'alerting', 'admin', 'platform'];

export interface NavGroup {
  group: MenuGroup;
  label: string;
  items: MenuDef[];
}

/** Menus the user may view, grouped in display order. */
export function buildNav(perms: PermissionMap): NavGroup[] {
  return GROUP_ORDER.map((group) => ({
    group,
    label: GROUP_LABELS[group],
    items: MENUS.filter((m) => m.group === group && perms[m.key]?.includes('view')),
  })).filter((g) => g.items.length > 0);
}

export function menuByKey(key: MenuKey): MenuDef {
  const m = MENUS.find((x) => x.key === key);
  if (!m) throw new Error(`Unknown menu ${key}`);
  return m;
}
