import { useQueryClient } from '@tanstack/react-query';
import { hasPhotoType, OBJECT_PHOTO_MAX_BYTES, OBJECT_PHOTO_MIME_TYPES, objectPhotoPath, type ObjectPhotoSize, type ObjectType } from '@veetracer/shared';
import { CameraIcon, PawPrintIcon, PackageIcon, Trash2Icon, UserIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { liveStore } from '@/features/live/live-store';
import { api, errorMessage, fetchBlob } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Person photos: fetched through the authorised API (never a public URL) and kept as object URLs per object, version
 * and size. A new version is a new key, so a replaced photo never shows stale.
 */
const urls = new Map<string, Promise<string | null>>();
const MAX_CACHED = 400;

export function photoObjectUrl(objectId: string, version: number, size: ObjectPhotoSize): Promise<string | null> {
  const key = `${objectId}:${version}:${size}`;
  let p = urls.get(key);
  if (!p) {
    p = fetchBlob(objectPhotoPath(objectId, version, size))
      .then((b) => (b.type.startsWith('image/') ? URL.createObjectURL(b) : null))
      .catch(() => {
        urls.delete(key); // retry on the next ask (e.g. after a network error)
        return null;
      });
    urls.set(key, p);
    if (urls.size > MAX_CACHED) {
      const [oldest, value] = urls.entries().next().value!;
      urls.delete(oldest);
      void value.then((u) => u && URL.revokeObjectURL(u));
    }
  }
  return p;
}

/** The decoded 64 px thumbnail, for drawing the map marker. */
export async function photoBitmap(objectId: string, version: number): Promise<ImageBitmap | HTMLImageElement | null> {
  const url = await photoObjectUrl(objectId, version, 'thumb');
  if (!url) return null;
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
    return img;
  } catch {
    return null;
  }
}

export function useObjectPhotoUrl(objectId: string | null | undefined, version: number | null | undefined, size: ObjectPhotoSize): string | null {
  const [state, setState] = useState<{ key: string; url: string | null } | null>(null);
  const key = objectId && version ? `${objectId}:${version}:${size}` : '';
  useEffect(() => {
    if (!objectId || !version) return;
    let live = true;
    void photoObjectUrl(objectId, version, size).then((url) => live && setState({ key: `${objectId}:${version}:${size}`, url }));
    return () => {
      live = false;
    };
  }, [objectId, version, size]);
  return key && state?.key === key ? state.url : null;
}

const FALLBACK_ICON = { PERSON: UserIcon, PET: PawPrintIcon, ASSET: PackageIcon } as const;

/** Round avatar: the photo, else a neutral icon for the object type. */
export function ObjectAvatar({
  objectId,
  version,
  type,
  name,
  size = 32,
  photoSize,
  className,
}: {
  objectId: string;
  version: number | null | undefined;
  type: ObjectType;
  name: string;
  size?: number;
  photoSize?: ObjectPhotoSize;
  className?: string;
}) {
  const url = useObjectPhotoUrl(objectId, version, photoSize ?? (size > 64 ? 'full' : 'thumb'));
  const Icon = FALLBACK_ICON[type as keyof typeof FALLBACK_ICON] ?? UserIcon;
  return (
    <span className={cn('inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border bg-muted text-muted-foreground', className)} style={{ width: size, height: size }}>
      {url ? <img src={url} alt={name} className="size-full object-cover" draggable={false} /> : <Icon aria-hidden style={{ width: size * 0.55, height: size * 0.55 }} />}
    </span>
  );
}

/** Lets the live map, lists and drawers see a new photo version right away. */
function publishVersion(qc: ReturnType<typeof useQueryClient>, objectId: string, photoVersion: number | null) {
  liveStore.patch(objectId, { photoVersion });
  void qc.invalidateQueries({ queryKey: ['master', '/objects'] });
}

/**
 * Upload / replace / remove a person photo (Masters → Objects form, the live map drawer). JPEG, PNG or WebP up to 5 MB;
 * the server crops it square and drops EXIF (including GPS).
 */
export function ObjectPhotoEditor({
  objectId,
  version,
  type,
  name,
  onChange,
  size = 72,
  compact = false,
}: {
  objectId: string;
  version: number | null | undefined;
  type: ObjectType;
  name: string;
  onChange?: (photoVersion: number | null) => void;
  size?: number;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState<{ id: string; v: number | null } | null>(null);
  const v = current?.id === objectId ? current.v : (version ?? null);
  if (!hasPhotoType(type)) return null;

  const done = (photoVersion: number | null, message: string) => {
    setCurrent({ id: objectId, v: photoVersion });
    publishVersion(qc, objectId, photoVersion);
    onChange?.(photoVersion);
    toast.success(message);
  };

  const pick = async (file: File | undefined) => {
    if (!file) return;
    if (!(OBJECT_PHOTO_MIME_TYPES as readonly string[]).includes(file.type)) return toast.error(t('Upload a JPEG, PNG or WebP photo'));
    if (file.size > OBJECT_PHOTO_MAX_BYTES) return toast.error(t('The photo is larger than 5 MB'));
    const form = new FormData();
    form.append('file', file);
    setBusy(true);
    try {
      const res = await api.upload<{ photoVersion: number | null }>(`/objects/${objectId}/photo`, form);
      done(res.photoVersion, t('Photo saved'));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.delete(`/objects/${objectId}/photo`);
      done(null, t('Photo removed'));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cn('flex items-center gap-3', compact && 'gap-2')}>
      <ObjectAvatar objectId={objectId} version={v} type={type} name={name} size={size} />
      <div className="flex flex-wrap items-center gap-2">
        <input ref={input} type="file" accept={OBJECT_PHOTO_MIME_TYPES.join(',')} className="hidden" onChange={(e) => void pick(e.target.files?.[0])} aria-label={t('Choose a photo')} />
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? <Spinner /> : <CameraIcon />} {v ? t('Change photo') : t('Add photo')}
        </Button>
        {v && (
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void remove()} aria-label={t('Remove photo')}>
            <Trash2Icon /> {!compact && t('Remove photo')}
          </Button>
        )}
        {!compact && <p className="w-full text-xs text-muted-foreground">{t('JPEG, PNG or WebP, up to 5 MB. Cropped square; location and camera details are removed.')}</p>}
      </div>
    </div>
  );
}
