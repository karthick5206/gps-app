import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PhotoFeatureKey, PhotoFeaturesDto } from '@veetracer/shared';
import { CameraIcon, ImageIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { api, errorMessage } from '@/lib/api';

export const PHOTO_FEATURES_KEY = ['company-photo-features'] as const;

const ROWS: { key: PhotoFeatureKey; label: string; hint: string; icon: typeof CameraIcon }[] = [
  { key: 'personPhotos', label: 'Person photos', hint: 'Photos of people, pets and assets: upload in the object form and the Tracker app, photo markers and the photo on hover on the maps.', icon: ImageIcon },
  { key: 'photoNotes', label: 'Photo notes', hint: 'Photos with a note and their place ("Add photo here"): the Photos & notes page and the photo-note layers on the live map and in history.', icon: CameraIcon },
];

/**
 * Settings → Features: the company's own photo switches (default off). Administrators switch them here; everyone else
 * sees the state. Saved at once per switch; /auth/me is read again so menus, map layers and upload buttons follow.
 */
export function PhotoFeaturesCard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const state = useQuery({
    queryKey: PHOTO_FEATURES_KEY,
    queryFn: ({ signal }) => api.get<PhotoFeaturesDto>('/company/photo-features', undefined, signal),
  });
  const save = useMutation({
    mutationFn: (change: Partial<Record<PhotoFeatureKey, boolean>>) => api.put<PhotoFeaturesDto>('/company/photo-features', change),
    onSuccess: (res, change) => {
      queryClient.setQueryData(PHOTO_FEATURES_KEY, res);
      queryClient.invalidateQueries({ queryKey: ['me'] });
      toast.success(Object.values(change)[0] ? t('Feature switched on') : t('Feature switched off'));
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const data = state.data;
  const canEdit = !!data?.canEdit;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('Features')}</CardTitle>
        <CardDescription>
          {t('Choose which photo features this account uses. Both are off until switched on. Switching a feature off only hides it: photos and notes already saved are kept and come back when it is switched on again.')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {state.isError && <FormError message={errorMessage(state.error)} />}
        {state.isPending ? (
          <>
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </>
        ) : (
          data &&
          ROWS.map(({ key, label, hint, icon: Icon }) => (
            <label key={key} htmlFor={`pf-${key}`} className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2.5">
              <span className="flex min-w-0 items-start gap-3">
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="space-y-0.5">
                  <span className="block text-sm font-medium">{t(label)}</span>
                  <span className="block text-xs text-muted-foreground">{t(hint)}</span>
                </span>
              </span>
              <Switch id={`pf-${key}`} checked={data[key]} disabled={!canEdit || save.isPending} onCheckedChange={(v) => save.mutate({ [key]: v })} />
            </label>
          ))
        )}
        {data && !canEdit && <p className="text-xs text-muted-foreground">{t('Only an administrator can change these.')}</p>}
      </CardContent>
    </Card>
  );
}
