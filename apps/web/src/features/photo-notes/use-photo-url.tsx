import { photoNotePhotoPath } from '@veetracer/shared';
import { ImageOffIcon } from 'lucide-react';
import { useEffect, useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchBlob } from '@/lib/api';
import { cn } from '@/lib/utils';

type State = { url: string | null; error: boolean };

/**
 * A photo-note photo fetched with the session's Bearer token (an <img src> can't send it) as an object URL, revoked
 * when the photo changes or the component unmounts.
 */
export function usePhotoUrl(noteId: string | null, photoId: string | null, size: 'thumb' | 'full' = 'full'): State & { loading: boolean } {
  const [state, setState] = useState<State>({ url: null, error: false });
  useEffect(() => {
    if (!noteId || !photoId) {
      setState({ url: null, error: false });
      return;
    }
    let alive = true;
    let url: string | null = null;
    setState({ url: null, error: false });
    fetchBlob(photoNotePhotoPath(noteId, photoId, size))
      .then((blob) => {
        if (!alive) return;
        url = URL.createObjectURL(blob);
        setState({ url, error: false });
      })
      .catch(() => alive && setState({ url: null, error: true }));
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [noteId, photoId, size]);
  return { ...state, loading: !!noteId && !!photoId && !state.url && !state.error };
}

/** <img> for a photo-note photo (authenticated fetch), with a skeleton while loading and an icon when it fails. */
export function PhotoNoteImage({
  noteId,
  photoId,
  size = 'thumb',
  alt,
  className,
  ...rest
}: { noteId: string; photoId: string; size?: 'thumb' | 'full'; alt: string } & Omit<ComponentProps<'img'>, 'src' | 'alt'>) {
  const { t } = useTranslation();
  const { url, error } = usePhotoUrl(noteId, photoId, size);
  if (error)
    return (
      <div className={cn('flex items-center justify-center bg-muted text-muted-foreground', className)} title={t("Couldn't load the photo")}>
        <ImageOffIcon className="size-5" />
        <span className="sr-only">{t("Couldn't load the photo")}</span>
      </div>
    );
  if (!url) return <Skeleton className={className} />;
  return <img src={url} alt={alt} className={className} {...rest} />;
}
