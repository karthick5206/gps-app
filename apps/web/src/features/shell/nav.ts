import { MENUS, PERSONAL_HIDDEN_MENUS, type MenuDef, type MenuGroup, type MenuKey, type PermissionMap } from '@veetracer/shared';
import {
  ActivityIcon,
  PackageIcon,
  IdCardIcon,
  ReceiptIndianRupeeIcon,
  SlidersHorizontalIcon,
  BellIcon,
  BellRingIcon,
  BoxesIcon,
  Building2Icon,
  CpuIcon,
  CodeXmlIcon,
  FuelIcon,
  GaugeIcon,
  CalendarCheckIcon,
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
  RouteIcon,
  ScrollTextIcon,
  SettingsIcon,
  ShareIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  TrophyIcon,
  TruckIcon,
  UsersIcon,
  UsersRoundIcon,
  VideoIcon,
  ScanEyeIcon,
  ScanFaceIcon,
  WarehouseIcon,
  CardSimIcon,
  BusIcon,
  CarFrontIcon,
  HandshakeIcon,
  LayoutDashboardIcon,
  Settings2Icon,
  type LucideIcon,
} from 'lucide-react';

export const MENU_ICONS: Record<MenuKey, LucideIcon> = {
  dashboard: GaugeIcon,
  live_map: MapIcon,
  video: VideoIcon,
  driver_events: ScanFaceIcon,
  dms: ScanEyeIcon,
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
  stock: PackageIcon,
  sa_licences: ShieldCheckIcon,
  sa_platform_settings: SlidersHorizontalIcon,
  sa_companies: Building2Icon,
  sa_device_models: BoxesIcon,
  sa_device_inventory: HardDriveIcon,
  sa_inventory: WarehouseIcon,
  sa_sim_cards: CardSimIcon,
  sa_unknown_devices: RadarIcon,
  sa_system_health: ActivityIcon,
  sa_relay: ShareIcon,
  history: HistoryIcon,
  alerts: BellIcon,
  parking_mode: ShieldAlertIcon,
  driver_scores: TrophyIcon,
  attendance: CalendarCheckIcon,
  expenses: FuelIcon,
  reports: FileBarChartIcon,
  geofences: HexagonIcon,
  pois: MapPinIcon,
  routes: RouteIcon,
  plannedTrips: CalendarClockIcon,
  // Employee transport (doc 07 §2.2; self / driver are the mobile-first passenger and driver entries).
  etms_dashboard: LayoutDashboardIcon,
  etms_partners: HandshakeIcon,
  etms_passengers: UsersRoundIcon,
  etms_settings: Settings2Icon,
  etms_self: BusIcon,
  etms_driver: CarFrontIcon,
  alert_settings: BellRingIcon,
  message_templates: MailIcon,
  report_schedules: CalendarClockIcon,
};

export const GROUP_LABELS: Record<MenuGroup, string> = {
  main: 'Tracking',
  transport: 'Employee transport',
  people: 'Drivers & Staff',
  costs: 'Costs & Reports',
  masters: 'Masters',
  alerting: 'Alert Management',
  stock: 'Purchases & sales',
  admin: 'Administration',
  platform: 'Platform',
};

const GROUP_ORDER: MenuGroup[] = ['main', 'transport', 'people', 'costs', 'masters', 'alerting', 'stock', 'admin', 'platform'];

export interface NavGroup {
  group: MenuGroup;
  label: string;
  items: MenuDef[];
}

/** Menus the user may view, grouped in display order. */
export function buildNav(perms: PermissionMap, personal = false, reseller = false): NavGroup[] {
  // Partner-only menus (Stock): the platform (it holds Super Admin menus) and resellers.
  const stockSide = reseller || !!perms.sa_companies;
  return GROUP_ORDER.map((group) => ({
    group,
    label: GROUP_LABELS[group],
    items: MENUS.filter((m) => m.group === group && perms[m.key]?.includes('view') && !(personal && PERSONAL_HIDDEN_MENUS.includes(m.key)) && !(m.partnerOnly && !stockSide)),
  })).filter((g) => g.items.length > 0);
}

export function menuByKey(key: MenuKey): MenuDef {
  const m = MENUS.find((x) => x.key === key);
  if (!m) throw new Error(`Unknown menu ${key}`);
  return m;
}
