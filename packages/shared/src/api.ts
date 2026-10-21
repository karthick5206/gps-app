/** REST API shapes shared by the backend and clients. */
import type { DataScope, MenuKey, Action, PermissionMap } from './permissions';
import type { ObjectType, VehicleType, StatusThresholds } from './tracking';

/**
 * Colour themes (profile; the web and mobile apps share them): four light palettes and one dark.
 * Teal & Saffron is the brand default. `swatch` = [background, accent] for theme pickers.
 */
export const THEMES = [
  { id: 'teal', label: 'Teal & Saffron', scheme: 'light', swatch: ['#0E5E57', '#FFB443'] },
  { id: 'plum', label: 'Plum & Pink', scheme: 'light', swatch: ['#5B1E78', '#FF9ECF'] },
  { id: 'sky', label: 'Sky & Cobalt', scheme: 'light', swatch: ['#EAF1FF', '#1F4FFF'] },
  { id: 'light', label: 'Light', scheme: 'light', swatch: ['#FFFFFF', '#0E5E57'] },
  { id: 'dark', label: 'Dark', scheme: 'dark', swatch: ['#08121D', '#FFB443'] },
] as const;
export type ThemePreference = (typeof THEMES)[number]['id'];
export const THEME_IDS = THEMES.map((t) => t.id) as ThemePreference[];
export const DEFAULT_THEME: ThemePreference = 'teal';
export const themeScheme = (theme: ThemePreference): 'light' | 'dark' => (theme === 'dark' ? 'dark' : 'light');
/** Stored value → theme; older profiles stored 'system', which becomes the default. */
export function normalizeTheme(value: unknown): ThemePreference {
  return THEME_IDS.includes(value as ThemePreference) ? (value as ThemePreference) : DEFAULT_THEME;
}
/** UI languages. */
export const LANGUAGES = [
  { code: 'en', label: 'English', native: 'English', locale: 'en-IN' },
  { code: 'hi', label: 'Hindi', native: 'हिन्दी', locale: 'hi-IN' },
  { code: 'ta', label: 'Tamil', native: 'தமிழ்', locale: 'ta-IN' },
] as const;
export type LanguageCode = (typeof LANGUAGES)[number]['code'];
export const LANGUAGE_CODES = LANGUAGES.map((l) => l.code) as LanguageCode[];

/** Readability settings (profile): text / UI scale and map vehicle-icon size. */
export const DISPLAY_SIZES = ['normal', 'large', 'xlarge'] as const;
export type DisplaySize = (typeof DISPLAY_SIZES)[number];
export const TEXT_SCALE: Record<DisplaySize, number> = { normal: 1, large: 1.125, xlarge: 1.25 };
export const MAP_ICON_SCALE: Record<DisplaySize, number> = { normal: 1, large: 1.3, xlarge: 1.6 };

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Common list query: ?q=&page=&pageSize=&sort=&order=&status=&format=csv (plus entity-specific filters). */
export interface ListQuery {
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  order?: 'asc' | 'desc';
  status?: 'ACTIVE' | 'INACTIVE';
  format?: 'json' | 'csv';
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // seconds until access token expiry
}

export interface CompanySummary {
  id: string;
  name: string;
  accountType: 'BUSINESS' | 'INDIVIDUAL';
  status: 'ACTIVE' | 'SUSPENDED';
  timezone: string;
  thresholds: StatusThresholds;
}

export interface Me {
  user: {
    id: string;
    name: string;
    email: string | null;
    mobile: string | null;
    isSuperAdmin: boolean;
    /** language null = not chosen yet (apps follow the device / browser language). */
    preferences: { theme: ThemePreference; language: LanguageCode | null; textSize: DisplaySize; mapIconSize: DisplaySize };
  };
  /** Company the user acts in. For the Super Admin: the company selected via X-Company-Id, else the platform company. */
  company: CompanySummary;
  permissions: PermissionMap;
  dataScope: DataScope;
}

export interface LoginResponse extends AuthTokens {
  me: Me;
}

export interface BranchDto {
  id: string; name: string; code: string | null; address: string | null;
  isActive: boolean; objectCount: number; createdAt: string; updatedAt: string;
}

export interface RoleDto {
  id: string; name: string; description: string | null; isSystem: boolean;
  dataScope: DataScope; permissions: { menu: MenuKey; actions: Action[] }[];
  userCount: number; createdAt: string; updatedAt: string;
}

export interface UserDto {
  id: string; name: string; email: string | null; mobile: string | null;
  isActive: boolean; managerId: string | null; managerName: string | null;
  roles: { id: string; name: string }[];
  branches: { id: string; name: string }[];
  objects: { id: string; name: string }[];
  lastLoginAt: string | null; createdAt: string; updatedAt: string;
}

export interface DeviceModelDto {
  id: string; brand: string; model: string; protocol: string;
  capabilities: string[]; fields: { key: string; label: string; unit?: string; type: 'number' | 'boolean' | 'string' }[];
  commands: { key: string; label: string }[]; timeOffsetMinutes: number; isActive: boolean;
  deviceCount: number; createdAt: string; updatedAt: string;
}

export interface DeviceDto {
  id: string; uniqueId: string; companyId: string | null; companyName: string | null;
  modelId: string; modelName: string; protocol: string;
  simNumber: string | null; simOperator: string | null; firmware: string | null;
  isActive: boolean; lastSeenAt: string | null;
  /** Reported by the tracker itself (Super Admin): SIM ICCID, firmware version, and when they were last read. */
  iccid?: string | null; firmwareReported?: string | null; deviceInfoAt?: string | null;
  /** Vehicle the device is fitted to; `speedLimitKph` = its own overspeed limit (null = vehicle-type default). */
  object: { id: string; name: string; speedLimitKph: number | null; vehicleType: VehicleType | null } | null;
  createdAt: string; updatedAt: string;
}

export interface TrackedObjectDto {
  id: string; name: string; type: ObjectType; vehicleType: VehicleType | null;
  plateNumber: string | null; make: string | null; model: string | null; color: string | null;
  branchId: string | null; branchName: string | null;
  speedLimitKph: number | null; isActive: boolean;
  /** Set while the vehicle is in maintenance (alerts suppressed). */
  maintenanceSince: string | null; maintenanceNote: string | null;
  device: { id: string; uniqueId: string; modelName: string } | null;
  groups: { id: string; name: string }[];
  customFields: Record<string, unknown>;
  createdAt: string; updatedAt: string;
}

export interface VehicleGroupDto {
  id: string; name: string; description: string | null; isActive: boolean;
  objects: { id: string; name: string }[]; createdAt: string; updatedAt: string;
}

export interface LookupDto {
  id: string; type: string; code: string; label: string; sortOrder: number;
  isSystem: boolean; isActive: boolean;
}

export interface CompanyDto extends CompanySummary {
  branchCount: number; userCount: number; objectCount: number; deviceCount: number;
  /** Days of history (positions, trips, stops, alerts) kept; older data is deleted automatically. */
  retentionDays: number;
  createdAt: string; updatedAt: string;
}

export interface AuditLogDto {
  id: string; userId: string | null; userName: string | null; action: string;
  entity: string; entityId: string | null; changes: unknown; ip: string | null; createdAt: string;
}

/** GET /devices/:id/raw: latest raw frames received from a device (hex). */
export interface RawPacketDto {
  id: string; receivedAt: string; protocol: string; remoteAddress: string | null; hex: string; length: number;
}

export interface UnknownDeviceDto {
  uniqueId: string; protocol: string; remoteAddress: string | null;
  firstSeenAt: string; lastSeenAt: string; packetCount: number;
}

export interface DashboardSummary {
  total: number;
  byStatus: Record<string, number>;
  devicesOnline: number;
}

/** Allowed per-company history retention (design: 30–180 days). */
export const RETENTION_MIN_DAYS = 30;
export const RETENTION_MAX_DAYS = 180;
export const RETENTION_OPTIONS = [30, 60, 90, 120, 180] as const;
