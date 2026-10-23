/** Published APK files: "VeeTrax-0.3.6.apk", "VeeTrax-Tracker-1.1.10.apk". */
export const APK_NAME = /^(VeeTrax(?:-Tracker)?)-(\d+(?:\.\d+){1,3})\.apk$/;

export interface ApkFile {
  file: string;
  app: 'VeeTrax' | 'VeeTrax Tracker';
  version: string;
  sizeBytes: number;
}

const versionKey = (v: string) => v.split('.').map((n) => n.padStart(5, '0')).join('.');

/** Newest version of each app from a directory listing (ignores anything that isn't a published APK). */
export function latestApks(files: { name: string; size: number }[]): ApkFile[] {
  const best = new Map<string, ApkFile>();
  for (const f of files) {
    const m = APK_NAME.exec(f.name);
    if (!m) continue;
    const app = m[1] === 'VeeTrax' ? 'VeeTrax' : 'VeeTrax Tracker';
    const cur = best.get(app);
    if (!cur || versionKey(m[2]) > versionKey(cur.version)) best.set(app, { file: f.name, app, version: m[2], sizeBytes: f.size });
  }
  return [...best.values()].sort((a, b) => a.app.localeCompare(b.app));
}
