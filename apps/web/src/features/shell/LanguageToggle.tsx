import { useQueryClient } from '@tanstack/react-query';
import { LANGUAGES, type LanguageCode, type Me } from '@veetracer/shared';
import { LanguagesIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { meQueryKey, useAuth } from '@/features/auth/auth-context';
import { api } from '@/lib/api';
import { setLanguage } from '@/lib/i18n';

/** Language menu (top bar and sign-in page). Signed in, the choice is saved to the profile so the mobile app follows it. */
export function LanguageToggle({ signedIn = true }: { signedIn?: boolean }) {
  const { t, i18n } = useTranslation();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const choose = (code: LanguageCode) => {
    setLanguage(code);
    if (!signedIn || auth.status !== 'authenticated') return;
    api
      .patch<Me>('/auth/me/preferences', { language: code })
      .then((me) => queryClient.setQueryData(meQueryKey(auth.companyId), me))
      .catch(() => undefined);
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('Language')}>
          <LanguagesIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t('Language')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={i18n.language} onValueChange={(v) => choose(v as LanguageCode)}>
          {LANGUAGES.map((l) => (
            <DropdownMenuRadioItem key={l.code} value={l.code}>
              {l.native}
              {l.code !== 'en' && <span className="ml-auto pl-3 text-xs text-muted-foreground">{l.label}</span>}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
