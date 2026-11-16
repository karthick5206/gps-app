import { hasPhotoType, objectPhotoPath, type LiveObject, type ObjectPhotoSize } from '@veetracer/shared';
import { Directory, File, Paths } from 'expo-file-system';
import { Image } from 'expo-image';
import { useEffect, useMemo, useState } from 'react';
import { requestRaw } from '@/lib/api';

/**
 * Person photos (avatars): downloaded through the authorised API (never a public URL) into the app cache, one file per
 * object, photo version and size, so a replaced photo is a new file and an old one is never shown. The map needs a file
 * URI for its marker images; lists and screens reuse the same files.
 */
const DIR = 'object-photos';
const pending = new Map<string, Promise<string | null>>();

const fileName = (objectId: string, version: number, size: ObjectPhotoSize) => `${objectId}-${version}-${size}.${size === 'marker' ? 'png' : 'jpg'}`;

export function photoFileUri(objectId: string, version: number, size: ObjectPhotoSize): Promise<string | null> {
  const key = fileName(objectId, version, size);
  let p = pending.get(key);
  if (!p) {
    p = (async () => {
      const file = new File(Paths.cache, DIR, key);
      if (file.exists) return file.uri;
      const res = await requestRaw(objectPhotoPath(objectId, version, size));
      if (!(res.headers.get('Content-Type') ?? '').startsWith('image/')) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      file.create({ intermediates: true, overwrite: true });
      file.write(bytes);
      return file.uri;
    })().catch(() => {
      pending.delete(key); // try again next time (offline, expired session…)
      return null;
    });
    pending.set(key, p);
  }
  return p;
}

/** Removes every cached photo (sign-out: photos are personal data). */
export function clearPhotoCache(): void {
  pending.clear();
  try {
    const dir = new Directory(Paths.cache, DIR);
    if (dir.exists) dir.delete();
  } catch {
    /* nothing cached */
  }
}

export const hasPhoto = (o: Pick<LiveObject, 'type' | 'photoVersion'>): boolean => !!o.photoVersion && hasPhotoType(o.type);

export function usePhotoUri(objectId: string, version: number | null | undefined, size: ObjectPhotoSize): string | null {
  const [state, setState] = useState<{ key: string; uri: string | null } | null>(null);
  const key = version ? fileName(objectId, version, size) : '';
  useEffect(() => {
    if (!version) return;
    let live = true;
    void photoFileUri(objectId, version, size).then((uri) => live && setState({ key: fileName(objectId, version, size), uri }));
    return () => {
      live = false;
    };
  }, [objectId, version, size]);
  return key && state?.key === key ? state.uri : null;
}

/** Round photo; renders `fallback` until (or unless) the photo is there. */
export function ObjectPhoto({ o, size, ring, fallback = null }: { o: Pick<LiveObject, 'objectId' | 'type' | 'photoVersion' | 'name'>; size: number; ring?: string; fallback?: React.ReactNode }) {
  const uri = usePhotoUri(o.objectId, hasPhoto(o) ? o.photoVersion : null, size > 40 ? 'full' : 'thumb');
  if (!uri) return <>{fallback}</>;
  return (
    <Image
      source={{ uri }}
      accessibilityLabel={o.name}
      style={{ width: size, height: size, borderRadius: size / 2, borderWidth: ring ? 3 : 0, borderColor: ring }}
      contentFit="cover"
    />
  );
}

/**
 * Map marker images for the objects with a photo: `{ 'ava-<id>-<version>': { source: { uri, scale: 2 } } }` (64 px round
 * PNG = 32 pt, like the vehicle icons). Objects appear here once their marker file is ready; until then they keep the
 * cartoon person.
 */
export function usePhotoMarkerImages(objects: LiveObject[]): Record<string, { source: { uri: string; scale: number } }> {
  const wanted = useMemo(() => objects.filter((o) => hasPhoto(o) && o.lat !== null).map((o) => ({ id: o.objectId, v: o.photoVersion! })), [objects]);
  const wantedKey = wanted.map((w) => `${w.id}:${w.v}`).join(',');
  const [ready, setReady] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    for (const w of wanted) {
      const name = markerImageName(w.id, w.v);
      if (ready[name]) continue;
      void photoFileUri(w.id, w.v, 'marker').then((uri) => {
        if (live && uri) setReady((r) => (r[name] ? r : { ...r, [name]: uri }));
      });
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedKey]);
  return useMemo(() => Object.fromEntries(Object.entries(ready).map(([name, uri]) => [name, { source: { uri, scale: 2 } }])), [ready]);
}

export const markerImageName = (objectId: string, version: number) => `ava-${objectId}-${version}`;
