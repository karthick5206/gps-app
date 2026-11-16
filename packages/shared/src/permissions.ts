/**
 * Menu catalogue and permission actions. Roles grant actions per menu (menu-role mapping);
 * web and mobile build their navigation from this list filtered by the user's permissions.
 */
import type { CompanyFeature } from './api';
import type { CompanySwitch } from './photo-features';

/** `approve` (doc 19 §9.3): maker-checker approvals (pricing contracts, vehicle rates, adjustments), grantable without `command`. */
export const ACTIONS = ['view', 'create', 'edit', 'delete', 'export', 'command', 'approve'] as const;
export type Action = (typeof ACTIONS)[number];

export type MenuGroup = 'main' | 'transport' | 'pricing' | 'people' | 'costs' | 'masters' | 'alerting' | 'stock' | 'admin' | 'platform';

/** What a menu needs besides a role grant. */
export interface MenuRequires {
  /** Company add-on (COMPANY_FEATURES) that must be on in the acting company; otherwise the menu is hidden and refused. */
  companyFeature?: CompanyFeature;
  /**
   * Company self-service switch (Company.settings, e.g. photos.photoNotes) that must be on. Unlike an add-on the menu
   * stays part of the built-in roles; while the switch is off it is stripped from the caller's permissions and its
   * routes answer 403 FEATURE_OFF (not a hidden 404: the company knows the feature and can switch it on).
   */
  companySetting?: CompanySwitch;
}

export interface MenuDef {
  key: MenuKey;
  label: string;
  group: MenuGroup;
  path: string;
  actions: readonly Action[];
  /** Only the single Super Admin can ever hold this menu. */
  superAdminOnly?: boolean;
  /** Shown only to the platform and to resellers (partners); other companies never see it, whatever their role says. */
  partnerOnly?: boolean;
  /** Module gating: without it the menu is stripped from the caller's permissions (hidden in nav, refused by the API). */
  requires?: MenuRequires;
}

export const MENU_KEYS = [
  'dashboard',
  'live_map',
  'video',
  'driver_events',
  'dms',
  'history',
  'alerts',
  'parking_mode',
  'plannedTrips',
  'etms_dashboard',
  'etms_partners',
  'etms_passengers',
  'etms_schedules',
  'etms_bookings',
  'etms_dispatch',
  'etms_planning',
  'etms_incidents',
  'etms_settings',
  'etms_vendors',
  'etms_billing',
  'etms_self',
  'etms_driver',
  'pricing',
  'pricing_contracts',
  'pricing_vehicle_rates',
  'pricing_trip_charges',
  'pricing_availability',
  'pricing_invoices',
  'pricing_adjustments',
  'pricing_reports',
  'pricing_costs',
  'driver_scores',
  'attendance',
  'expenses',
  'photo_notes',
  'reports',
  'objects',
  'drivers',
  'documents',
  'devices',
  'vehicle_groups',
  'branches',
  'users',
  'roles',
  'lookups',
  'geofences',
  'routes',
  'pois',
  'alert_settings',
  'message_templates',
  'report_schedules',
  'audit_log',
  'settings',
  'api',
  'billing',
  'stock',
  'sa_companies',
  'sa_device_models',
  'sa_device_inventory',
  'sa_inventory',
  'sa_sim_cards',
  'sa_unknown_devices',
  'sa_licences',
  'sa_platform_settings',
  'sa_system_health',
  'sa_relay',
] as const;
export type MenuKey = (typeof MENU_KEYS)[number];

const CRUD: readonly Action[] = ['view', 'create', 'edit', 'delete', 'export'];
const ETMS: MenuRequires = { companyFeature: 'etms' };
const PRICING: MenuRequires = { companyFeature: 'pricing' };

export const MENUS: readonly MenuDef[] = [
  // Tracking: where vehicles are and what is happening now.
  { key: 'dashboard', label: 'Dashboard', group: 'main', path: '/dashboard', actions: ['view'] },
  { key: 'live_map', label: 'Live Map', group: 'main', path: '/live', actions: ['view', 'command'] },
  { key: 'history', label: 'History & Playback', group: 'main', path: '/history', actions: ['view', 'export'] },
  { key: 'alerts', label: 'Alerts', group: 'main', path: '/alerts', actions: ['view', 'edit', 'export'] },
  { key: 'parking_mode', label: 'Parking mode', group: 'main', path: '/parking-mode', actions: ['view', 'edit'] },
  { key: 'video', label: 'Video', group: 'main', path: '/video', actions: ['view'] },
  { key: 'plannedTrips', label: 'Planned trips', group: 'main', path: '/planned-trips', actions: CRUD },
  // Employee transport (ETMS, doc 07 §2.2): only when the company add-on `etms` is on. E1a ships these keys, E2 adds
  // etms_passengers, E3 etms_schedules / etms_bookings / etms_dispatch; later phases add etms_stops, etms_incidents, etms_policies, … .
  { key: 'etms_dashboard', label: 'Transport dashboard', group: 'transport', path: '/transport', actions: ['view', 'export'], requires: ETMS },
  { key: 'etms_partners', label: 'Customers / Providers & agreements', group: 'transport', path: '/transport/partners', actions: CRUD, requires: ETMS },
  { key: 'etms_passengers', label: 'Passengers', group: 'transport', path: '/transport/passengers', actions: CRUD, requires: ETMS },
  { key: 'etms_schedules', label: 'Shifts & schedules', group: 'transport', path: '/transport/schedules', actions: CRUD, requires: ETMS },
  { key: 'etms_bookings', label: 'Bookings', group: 'transport', path: '/transport/bookings', actions: CRUD, requires: ETMS },
  { key: 'etms_dispatch', label: 'Daily transport', group: 'transport', path: '/transport/dispatch', actions: ['view', 'edit', 'command', 'export'], requires: ETMS },
  // E4 (WP 4.5): route planner. Shown only with the web flag etmsRouting and when GET /routing/capabilities is enabled
  // (ETMS + ETMS_ROUTING=on); RoutingAccess: view = canView, create = canPlan, edit = canEdit, delete = canDelete, command = canPublish.
  { key: 'etms_planning', label: 'Route planning', group: 'transport', path: '/transport/planning', actions: ['view', 'create', 'edit', 'delete', 'command'], requires: ETMS },
  // E5 (WP 5.4): open SOS lane; view = list / detail, edit = acknowledge / resolve (export / command reserved for E6).
  { key: 'etms_incidents', label: 'Incidents & SOS', group: 'transport', path: '/transport/incidents', actions: ['view', 'edit', 'export', 'command'], requires: ETMS },
  // v1.16.10: vendors (cab / fleet operators) with their vehicles, drivers and rates, for every company (normal
  // tracking too); only Vendor billing needs the Employee transport add-on. The key keeps its etms_ prefix (stored grants).
  { key: 'etms_vendors', label: 'Vendors', group: 'masters', path: '/vendors', actions: CRUD },
  { key: 'etms_billing', label: 'Vendor billing', group: 'transport', path: '/transport/billing', actions: ['view', 'export'], requires: ETMS },
  { key: 'etms_settings', label: 'Transport settings', group: 'transport', path: '/transport/settings', actions: ['view', 'edit'], requires: ETMS },
  { key: 'etms_self', label: 'My commute', group: 'transport', path: '/transport/me', actions: ['view', 'create', 'edit'], requires: ETMS },
  { key: 'etms_driver', label: 'My transport duty', group: 'transport', path: '/transport/driver', actions: ['view', 'edit'], requires: ETMS },
  // Customer pricing & billing (doc 19 §6): only when the company add-on `pricing` is on. Cost / margin is its own menu
  // (pricing_costs) so ordinary pricing roles never see it; `approve` = maker-checker (approver ≠ submitter, server-side).
  { key: 'pricing', label: 'Pricing dashboard', group: 'pricing', path: '/pricing', actions: ['view'], requires: PRICING },
  { key: 'pricing_contracts', label: 'Company contracts', group: 'pricing', path: '/pricing/contracts', actions: ['view', 'create', 'edit', 'delete', 'export', 'approve'], requires: PRICING },
  { key: 'pricing_vehicle_rates', label: 'Vehicle rates', group: 'pricing', path: '/pricing/vehicle-rates', actions: ['view', 'create', 'edit', 'approve'], requires: PRICING },
  { key: 'pricing_trip_charges', label: 'Trip charges', group: 'pricing', path: '/pricing/trip-charges', actions: ['view', 'edit', 'command', 'export'], requires: PRICING },
  { key: 'pricing_availability', label: 'Availability billing', group: 'pricing', path: '/pricing/availability', actions: ['view', 'command', 'export'], requires: PRICING },
  { key: 'pricing_invoices', label: 'Customer invoices', group: 'pricing', path: '/pricing/invoices', actions: ['view', 'create', 'edit', 'delete', 'command', 'export'], requires: PRICING },
  { key: 'pricing_adjustments', label: 'Billing adjustments', group: 'pricing', path: '/pricing/adjustments', actions: ['view', 'create', 'approve'], requires: PRICING },
  { key: 'pricing_reports', label: 'Pricing reports', group: 'pricing', path: '/pricing/reports', actions: ['view', 'export'], requires: PRICING },
  { key: 'pricing_costs', label: 'Operating costs & margin', group: 'pricing', path: '/pricing/costs', actions: ['view', 'create'], requires: PRICING },
  // Drivers & staff: behaviour, safety and attendance.
  { key: 'dms', label: 'DMS dashboard', group: 'people', path: '/dms', actions: ['view', 'export'] },
  { key: 'driver_events', label: 'Driver events', group: 'people', path: '/driver-events', actions: ['view', 'edit', 'export'] },
  { key: 'driver_scores', label: 'Driver scorecard', group: 'people', path: '/driver-scores', actions: ['view'] },
  { key: 'attendance', label: 'Staff attendance', group: 'people', path: '/attendance', actions: ['view', 'edit', 'export'] },
  // Costs & reports.
  { key: 'expenses', label: 'Fuel & expenses', group: 'costs', path: '/expenses', actions: ['view', 'create', 'delete'] },
  // Location photo notes (bills, receipts, visits): view = own notes + those within the data scope; edit / delete reach
  // other people's visible notes (one's own need only create).
  { key: 'photo_notes', label: 'Photos & notes', group: 'people', path: '/photo-notes', actions: CRUD, requires: { companySetting: 'photoNotes' } },
  { key: 'reports', label: 'Reports', group: 'costs', path: '/reports', actions: ['view', 'export'] },
  { key: 'report_schedules', label: 'Scheduled Reports', group: 'costs', path: '/reports/schedules', actions: ['view', 'create', 'edit', 'delete'] },
  // Masters: fleet set-up first, then places, then reference data.
  { key: 'objects', label: 'Vehicles & Objects', group: 'masters', path: '/masters/objects', actions: CRUD },
  { key: 'devices', label: 'Devices', group: 'masters', path: '/masters/devices', actions: CRUD },
  { key: 'drivers', label: 'Drivers', group: 'masters', path: '/masters/drivers', actions: CRUD },
  { key: 'vehicle_groups', label: 'Vehicle Groups', group: 'masters', path: '/masters/vehicle-groups', actions: CRUD },
  { key: 'branches', label: 'Branches', group: 'masters', path: '/masters/branches', actions: CRUD },
  { key: 'documents', label: 'Documents & Service', group: 'masters', path: '/masters/documents', actions: CRUD },
  { key: 'geofences', label: 'Geofences', group: 'masters', path: '/masters/geofences', actions: CRUD },
  { key: 'routes', label: 'Routes', group: 'masters', path: '/routes', actions: CRUD },
  { key: 'pois', label: 'Points of Interest', group: 'masters', path: '/masters/pois', actions: CRUD },
  { key: 'lookups', label: 'Lookups', group: 'masters', path: '/masters/lookups', actions: CRUD },
  { key: 'alert_settings', label: 'Alert Settings', group: 'alerting', path: '/alerting/settings', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'message_templates', label: 'Message Templates', group: 'alerting', path: '/alerting/templates', actions: ['view', 'create', 'edit', 'delete', 'export'] },
  { key: 'users', label: 'Users', group: 'admin', path: '/admin/users', actions: CRUD },
  { key: 'roles', label: 'Roles & Permissions', group: 'admin', path: '/admin/roles', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'settings', label: 'Company Settings', group: 'admin', path: '/admin/settings', actions: ['view', 'edit'] },
  { key: 'billing', label: 'Billing & Licences', group: 'admin', path: '/admin/billing', actions: ['view', 'create', 'edit'] },
  { key: 'api', label: 'Developer API', group: 'admin', path: '/admin/developer-api', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'audit_log', label: 'Audit Log', group: 'admin', path: '/admin/audit-log', actions: ['view', 'export'] },
  { key: 'stock', label: 'Purchases & sales', group: 'stock', path: '/stock', actions: CRUD, partnerOnly: true },
  { key: 'sa_companies', label: 'Companies', group: 'platform', path: '/platform/companies', actions: CRUD, superAdminOnly: true },
  { key: 'sa_licences', label: 'Licences & Invoices', group: 'platform', path: '/platform/licences', actions: CRUD, superAdminOnly: true },
  { key: 'sa_device_models', label: 'Device Models', group: 'platform', path: '/platform/device-models', actions: CRUD, superAdminOnly: true },
  { key: 'sa_device_inventory', label: 'Device Inventory', group: 'platform', path: '/platform/device-inventory', actions: CRUD, superAdminOnly: true },
  { key: 'sa_inventory', label: 'Stock & Movements', group: 'platform', path: '/platform/inventory', actions: CRUD, superAdminOnly: true },
  { key: 'sa_sim_cards', label: 'SIM Cards', group: 'platform', path: '/platform/sim-cards', actions: CRUD, superAdminOnly: true },
  { key: 'sa_unknown_devices', label: 'Unknown Devices', group: 'platform', path: '/platform/unknown-devices', actions: ['view'], superAdminOnly: true },
  { key: 'sa_relay', label: 'Data forwarding', group: 'platform', path: '/platform/data-forwarding', actions: ['view', 'create', 'edit', 'delete'], superAdminOnly: true },
  { key: 'sa_platform_settings', label: 'Platform Settings', group: 'platform', path: '/platform/settings', actions: ['view', 'edit'], superAdminOnly: true },
  { key: 'sa_system_health', label: 'System Health', group: 'platform', path: '/platform/system-health', actions: ['view', 'edit'], superAdminOnly: true },
];

export type PermissionMap = Partial<Record<MenuKey, Action[]>>;

/** Menus hidden for personal (INDIVIDUAL) accounts: business structure they don't need. Permissions are unchanged. */
export const PERSONAL_HIDDEN_MENUS: readonly MenuKey[] = ['branches', 'vehicle_groups', 'lookups', 'roles', 'audit_log', 'api', 'message_templates', 'drivers', 'routes', 'plannedTrips'];

/** Data scope of a role: whole company, or only assigned branches/objects. */
export type DataScope = 'COMPANY' | 'ASSIGNED';

export function can(perms: PermissionMap, menu: MenuKey, action: Action = 'view'): boolean {
  return perms[menu]?.includes(action) ?? false;
}

/**
 * Whether a menu's requirements are met by the acting company's add-ons and self-service switches. `switches` defaults
 * to none: a caller that does not pass them treats every switch-gated menu as unavailable (fail closed).
 */
export function menuAvailable(menu: Pick<MenuDef, 'requires'>, features: readonly CompanyFeature[], switches: readonly CompanySwitch[] = []): boolean {
  const need = menu.requires?.companyFeature;
  const setting = menu.requires?.companySetting;
  return (!need || features.includes(need)) && (!setting || switches.includes(setting));
}

/** Menus of an add-on module (hidden, 404 while off), as opposed to a company switch (403 FEATURE_OFF while off). */
export function isModuleMenu(menu: Pick<MenuDef, 'requires'>): boolean {
  return !!menu.requires?.companyFeature;
}

/** Menus of a module (e.g. 'etms'): hidden and refused while the company add-on is off. */
export function moduleMenuKeys(feature: CompanyFeature): MenuKey[] {
  return MENUS.filter((m) => m.requires?.companyFeature === feature).map((m) => m.key);
}

/**
 * Drop grants of menus whose module (add-on) or company switch is off in the acting company (navigation hides them,
 * the API refuses them).
 */
export function withoutUnavailableMenus(perms: PermissionMap, features: readonly CompanyFeature[], switches: readonly CompanySwitch[] = []): PermissionMap {
  const out: PermissionMap = {};
  for (const m of MENUS) {
    const actions = perms[m.key];
    if (actions && menuAvailable(m, features, switches)) out[m.key] = actions;
  }
  return out;
}

/** Built-in roles created for every new company. */
export const SYSTEM_ROLES: { name: string; description: string; dataScope: DataScope; permissions: PermissionMap }[] = [
  {
    name: 'Admin',
    description: 'Full access to the whole company',
    dataScope: 'COMPANY',
    permissions: Object.fromEntries(
      // Module menus (requires) are never part of the global built-in roles: they come from the module's role templates
      // (ETMS: ETMS_ROLE_TEMPLATES, seeded when the add-on is switched on; P6).
      // Menus behind a company switch (requires.companySetting, e.g. photo notes) stay in: the switch hides them.
      MENUS.filter((m) => !m.superAdminOnly && !isModuleMenu(m)).map((m) => [m.key, [...m.actions]]),
    ) as PermissionMap,
  },
  {
    name: 'Manager',
    description: 'Manages assigned branches and their team',
    dataScope: 'ASSIGNED',
    permissions: {
      dashboard: ['view'],
      live_map: ['view'], // device commands (engine stop…) are for Admin roles only
      video: ['view'],
      driver_events: ['view', 'edit', 'export'],
      dms: ['view', 'export'],
      history: ['view', 'export'],
      alerts: ['view', 'edit', 'export'],
      parking_mode: ['view', 'edit'],
      driver_scores: ['view'],
      attendance: ['view', 'export'],
      expenses: ['view', 'create', 'delete'],
      photo_notes: ['view', 'create', 'edit', 'delete', 'export'],
      reports: ['view', 'export'],
      geofences: ['view', 'create', 'edit', 'export'],
      routes: ['view', 'create', 'edit', 'delete', 'export'],
      plannedTrips: ['view', 'create', 'edit', 'delete', 'export'],
      pois: ['view', 'create', 'edit', 'delete', 'export'],
      alert_settings: ['view', 'create', 'edit'],
      message_templates: ['view'],
      report_schedules: ['view', 'create', 'edit', 'delete'],
      objects: ['view', 'edit', 'export'],
      drivers: ['view', 'create', 'edit', 'export'],
      documents: ['view', 'create', 'edit', 'delete', 'export'],
      devices: ['view'],
      vehicle_groups: ['view', 'create', 'edit', 'export'],
      branches: ['view'],
      lookups: ['view'],
      users: ['view', 'create', 'edit'],
    },
  },
  {
    name: 'User',
    description: 'Tracks assigned branches/vehicles',
    dataScope: 'ASSIGNED',
    permissions: {
      dashboard: ['view'], live_map: ['view'], history: ['view'], alerts: ['view', 'edit'], parking_mode: ['view', 'edit'], driver_scores: ['view'], expenses: ['view', 'create'], photo_notes: ['view', 'create'], reports: ['view'], driver_events: ['view'], dms: ['view'],
      geofences: ['view'], pois: ['view'], report_schedules: ['view', 'create', 'edit', 'delete'], objects: ['view'], drivers: ['view'], documents: ['view'], vehicle_groups: ['view'],
      routes: ['view'], plannedTrips: ['view'],
    },
  },
  {
    name: 'Viewer',
    description: 'Read-only live tracking',
    dataScope: 'ASSIGNED',
    permissions: { dashboard: ['view'], live_map: ['view'], history: ['view'], alerts: ['view'], parking_mode: ['view'] },
  },
];
