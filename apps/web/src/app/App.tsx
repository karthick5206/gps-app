import { QueryClientProvider } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { RouterProvider } from 'react-router';
import { Toaster } from 'sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AuthProvider } from '@/features/auth/AuthProvider';
import { useTheme } from '@/features/theme/use-theme';
import { queryClient } from '@/lib/query-client';
import { router } from './router';

function ThemedToaster() {
  const { resolved } = useTheme();
  const { t } = useTranslation();
  // T2-L5: the toaster region label (sonner default "Notifications") and close buttons in the user's language.
  return <Toaster theme={resolved} position="top-right" richColors closeButton containerAriaLabel={t('Notifications')} toastOptions={{ closeButtonAriaLabel: t('Close') }} />;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider delayDuration={300}>
          <RouterProvider router={router} />
          <ThemedToaster />
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
