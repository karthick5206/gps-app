import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LANGUAGES, type LanguageCode, type Me } from '@veetracer/shared';
import { useTranslation } from 'react-i18next';
import { Chips } from '@/components/ui';
import { meQueryKey, useAuth } from '@/features/auth/auth';
import { api } from '@/lib/api';
import { setLanguage } from '@/lib/i18n';

/** English / हिन्दी / தமிழ் switch. Signed in, the choice is saved to the profile (the web app follows it). */
export function LanguageChips({ signedIn = true }: { signedIn?: boolean }) {
  const { i18n } = useTranslation();
  const { companyId, status } = useAuth();
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (code: LanguageCode) => api.patch<Me>('/auth/me/preferences', { language: code }),
    onSuccess: (me) => queryClient.setQueryData(meQueryKey(companyId), me),
  });
  return (
    <Chips
      value={i18n.language as LanguageCode}
      onChange={(code) => {
        setLanguage(code);
        if (signedIn && status === 'authenticated') save.mutate(code);
      }}
      options={LANGUAGES.map((l) => ({ value: l.code, label: l.native }))}
    />
  );
}
