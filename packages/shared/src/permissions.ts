/**
 * Menu catalogue and permission actions. Roles grant actions per menu (menu-role mapping);
 * web and mobile build their navigation from this list filtered by the user's permissions.
 */
export const ACTIONS = ['view', 'create', 'edit', 'delete', 'export', 'command'] as const;
export type Action = (typeof ACTIONS)[number];

export type MenuGroup = 'main' | 'masters' | 'alerting' | 'admin' | 'platform';

export interface MenuDef {
  key: MenuKey;
  label: string;
  group: MenuGroup;
  path: string;
  actions: readonly Action[];
  /** Only the single Super Admin can ever hold this menu. */
  superAdminOnly?: boolean;
}

export const MENU_KEYS = [
  'dashboard',
  'live_map',
  'history',
  'alerts',
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
  'alert_settings',
  'message_templates',
  'report_schedules',
  'audit_log',
  'settings',
  'sa_companies',
  'sa_device_models',
  'sa_device_inventory',
  'sa_unknown_devices',
] as const;
export type MenuKey = (typeof MENU_KEYS)[number];

const CRUD: readonly Action[] = ['view', 'create', 'edit', 'delete', 'export'];

export const MENUS: readonly MenuDef[] = [
  { key: 'dashboard', label: 'Dashboard', group: 'main', path: '/dashboard', actions: ['view'] },
  { key: 'live_map', label: 'Live Map', group: 'main', path: '/live', actions: ['view', 'command'] },
  { key: 'history', label: 'History & Playback', group: 'main', path: '/history', actions: ['view', 'export'] },
  { key: 'alerts', label: 'Alerts', group: 'main', path: '/alerts', actions: ['view', 'edit', 'export'] },
  { key: 'reports', label: 'Reports', group: 'main', path: '/reports', actions: ['view', 'export'] },
  { key: 'objects', label: 'Vehicles & Objects', group: 'masters', path: '/masters/objects', actions: CRUD },
  { key: 'drivers', label: 'Drivers', group: 'masters', path: '/masters/drivers', actions: CRUD },
  { key: 'documents', label: 'Documents & Service', group: 'masters', path: '/masters/documents', actions: CRUD },
  { key: 'devices', label: 'Devices', group: 'masters', path: '/masters/devices', actions: CRUD },
  { key: 'vehicle_groups', label: 'Vehicle Groups', group: 'masters', path: '/masters/vehicle-groups', actions: CRUD },
  { key: 'branches', label: 'Branches', group: 'masters', path: '/masters/branches', actions: CRUD },
  { key: 'lookups', label: 'Lookups', group: 'masters', path: '/masters/lookups', actions: CRUD },
  { key: 'geofences', label: 'Geofences', group: 'masters', path: '/masters/geofences', actions: CRUD },
  { key: 'alert_settings', label: 'Alert Settings', group: 'alerting', path: '/alerting/settings', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'message_templates', label: 'Message Templates', group: 'alerting', path: '/alerting/templates', actions: ['view', 'create', 'edit', 'delete', 'export'] },
  { key: 'report_schedules', label: 'Scheduled Reports', group: 'alerting', path: '/reports/schedules', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'users', label: 'Users', group: 'admin', path: '/admin/users', actions: CRUD },
  { key: 'roles', label: 'Roles & Permissions', group: 'admin', path: '/admin/roles', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'audit_log', label: 'Audit Log', group: 'admin', path: '/admin/audit-log', actions: ['view', 'export'] },
  { key: 'settings', label: 'Company Settings', group: 'admin', path: '/admin/settings', actions: ['view', 'edit'] },
  { key: 'sa_companies', label: 'Companies', group: 'platform', path: '/platform/companies', actions: CRUD, superAdminOnly: true },
  { key: 'sa_device_models', label: 'Device Models', group: 'platform', path: '/platform/device-models', actions: CRUD, superAdminOnly: true },
  { key: 'sa_device_inventory', label: 'Device Inventory', group: 'platform', path: '/platform/device-inventory', actions: CRUD, superAdminOnly: true },
  { key: 'sa_unknown_devices', label: 'Unknown Devices', group: 'platform', path: '/platform/unknown-devices', actions: ['view'], superAdminOnly: true },
];

export type PermissionMap = Partial<Record<MenuKey, Action[]>>;

/** Data scope of a role: whole company, or only assigned branches/objects. */
export type DataScope = 'COMPANY' | 'ASSIGNED';

export function can(perms: PermissionMap, menu: MenuKey, action: Action = 'view'): boolean {
  return perms[menu]?.includes(action) ?? false;
}

/** Built-in roles created for every new company. */
export const SYSTEM_ROLES: { name: string; description: string; dataScope: DataScope; permissions: PermissionMap }[] = [
  {
    name: 'Admin',
    description: 'Full access to the whole company',
    dataScope: 'COMPANY',
    permissions: Object.fromEntries(
      MENUS.filter((m) => !m.superAdminOnly).map((m) => [m.key, [...m.actions]]),
    ) as PermissionMap,
  },
  {
    name: 'Manager',
    description: 'Manages assigned branches and their team',
    dataScope: 'ASSIGNED',
    permissions: {
      dashboard: ['view'],
      live_map: ['view'], // device commands (engine stop…) are for Admin roles only
      history: ['view', 'export'],
      alerts: ['view', 'edit', 'export'],
      reports: ['view', 'export'],
      geofences: ['view', 'create', 'edit', 'export'],
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
      dashboard: ['view'], live_map: ['view'], history: ['view'], alerts: ['view', 'edit'], reports: ['view'],
      geofences: ['view'], report_schedules: ['view', 'create', 'edit', 'delete'], objects: ['view'], drivers: ['view'], documents: ['view'], vehicle_groups: ['view'],
    },
  },
  {
    name: 'Viewer',
    description: 'Read-only live tracking',
    dataScope: 'ASSIGNED',
    permissions: { dashboard: ['view'], live_map: ['view'], history: ['view'], alerts: ['view'] },
  },
];
