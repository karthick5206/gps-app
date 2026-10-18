import { THEMES, type Me, type ThemePreference } from '@veetracer/shared';
import { useQueryClient } from '@tanstack/react-query';
import { PaletteIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { meQueryKey, useAuth } from '@/features/auth/auth-context';
import { themeStore } from '@/features/theme/theme-store';
import { useTheme } from '@/features/theme/use-theme';
import { api } from '@/lib/api';

/** Two-colour dot showing a theme's background and accent. */
export function ThemeSwatch({ colors }: { colors: readonly [string, string] }) {
  return (
    <span aria-hidden="true" className="relative inline-block size-4 shrink-0 overflow-hidden rounded-full border border-border" style={{ background: colors[0] }}>
      <span className="absolute right-0 bottom-0 size-2 rounded-tl-full" style={{ background: colors[1] }} />
    </span>
  );
}

export function ThemeToggle() {
  const { t } = useTranslation();
  const { preference } = useTheme();
  const { companyId } = useAuth();
  const queryClient = useQueryClient();

  const setTheme = (theme: ThemePreference) => {
    themeStore.setPreference(theme);
    // Persist server-side as well (the mobile app follows it); the local value already applies, so failures are non-fatal.
    api
      .patch<Me>('/auth/me/preferences', { theme })
      .then((me) => queryClient.setQueryData(meQueryKey(companyId), me))
      .catch(() => undefined);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('Change theme')}>
          <PaletteIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>{t('Theme')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={preference} onValueChange={(v) => setTheme(v as ThemePreference)}>
          {THEMES.map((theme) => (
            <DropdownMenuRadioItem key={theme.id} value={theme.id}>
              <ThemeSwatch colors={theme.swatch} /> {t(theme.label)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
