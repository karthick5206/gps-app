import type { Me, ThemePreference } from '@veetracer/shared';
import { useQueryClient } from '@tanstack/react-query';
import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
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

const OPTIONS: { value: ThemePreference; label: string; icon: typeof SunIcon }[] = [
  { value: 'light', label: 'Light', icon: SunIcon },
  { value: 'dark', label: 'Dark', icon: MoonIcon },
  { value: 'system', label: 'System', icon: MonitorIcon },
];

export function ThemeToggle() {
  const { preference, resolved } = useTheme();
  const { companyId } = useAuth();
  const queryClient = useQueryClient();

  const setTheme = (theme: ThemePreference) => {
    themeStore.setPreference(theme);
    // Persist server-side as well; the local value already applies, so failures are non-fatal.
    api
      .patch<Me>('/auth/me/preferences', { theme })
      .then((me) => queryClient.setQueryData(meQueryKey(companyId), me))
      .catch(() => undefined);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Change theme">
          {resolved === 'dark' ? <MoonIcon /> : <SunIcon />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={preference} onValueChange={(v) => setTheme(v as ThemePreference)}>
          {OPTIONS.map(({ value, label, icon: Icon }) => (
            <DropdownMenuRadioItem key={value} value={value}>
              <Icon /> {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
