/** localStorage access that never throws (private mode, blocked storage). */
export const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null): void {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* storage unavailable */
    }
  },
  getJson<T>(key: string, fallback: T): T {
    const raw = storage.get(key);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },
  setJson(key: string, value: unknown): void {
    storage.set(key, JSON.stringify(value));
  },
};

export const STORAGE_KEYS = {
  theme: 'vt.theme',
  refreshToken: 'vt.refreshToken',
  companyId: 'vt.companyId',
  sidebarCollapsed: 'vt.sidebarCollapsed',
  columns: (menu: string) => `vt.columns.${menu}`,
} as const;
