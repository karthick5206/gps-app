import { useQueryClient } from '@tanstack/react-query';
import { DISPLAY_SIZES, type DisplaySize, type Me } from '@veetracer/shared';
import { ALargeSmallIcon } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { meQueryKey, useAuth } from '@/features/auth/auth-context';
import { displayStore } from '@/features/display/display-store';
import { api } from '@/lib/api';

const SIZE_LABEL: Record<DisplaySize, string> = { normal: 'Normal', large: 'Large', xlarge: 'Extra large' };

/** Text size and map icon size (top bar). Saved to the profile so the mobile app follows it. */
export function DisplayToggle() {
  const { t } = useTranslation();
  const { companyId } = useAuth();
  const queryClient = useQueryClient();
  const textSize = useSyncExternalStore(displayStore.subscribe, displayStore.getTextSize);
  const mapIconSize = useSyncExternalStore(displayStore.subscribe, displayStore.getMapIconSize);
  const save = (prefs: { textSize?: DisplaySize; mapIconSize?: DisplaySize }) => {
    displayStore.set(prefs);
    api
      .patch<Me>('/auth/me/preferences', prefs)
      .then((me) => queryClient.setQueryData(meQueryKey(companyId), me))
      .catch(() => undefined);
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('Display size')}>
          <ALargeSmallIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>{t('Text size')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={textSize} onValueChange={(v) => save({ textSize: v as DisplaySize })}>
          {DISPLAY_SIZES.map((s) => (
            <DropdownMenuRadioItem key={s} value={s}>
              {t(SIZE_LABEL[s])}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t('Map icon size')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={mapIconSize} onValueChange={(v) => save({ mapIconSize: v as DisplaySize })}>
          {DISPLAY_SIZES.map((s) => (
            <DropdownMenuRadioItem key={s} value={s}>
              {t(SIZE_LABEL[s])}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
