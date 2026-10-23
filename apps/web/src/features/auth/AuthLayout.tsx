import { MapPinnedIcon, PhoneIcon, ShieldCheckIcon, ZapIcon } from 'lucide-react';
import { LanguageToggle } from '@/features/shell/LanguageToggle';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Logo, LogoMark, Wordmark } from '@/components/logo';

const HIGHLIGHTS = [
  { icon: MapPinnedIcon, text: 'Live fleet map with second-by-second updates' },
  { icon: ZapIcon, text: 'Built for 10,000+ vehicles per account' },
  { icon: ShieldCheckIcon, text: 'Role-based access down to branch and vehicle' },
];

/** Support line shown under the sign-in / sign-up forms. */
const SUPPORT_PHONE = { display: '94449 07658', tel: '+919444907658' };

export function AuthLayout({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <aside className="relative hidden overflow-hidden bg-sidebar p-10 text-sidebar-foreground lg:flex lg:flex-col lg:justify-between">
        <div className="pointer-events-none absolute -top-32 -right-32 size-96 rounded-full bg-sidebar-primary/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-40 -left-20 size-96 rounded-full bg-primary/20 blur-3xl" />
        <span className="relative inline-flex items-center gap-2.5">
          <LogoMark />
          <Wordmark className="text-xl text-sidebar-accent-foreground" />
        </span>
        <div className="relative max-w-md space-y-6">
          <h2 className="text-3xl leading-tight font-semibold text-sidebar-accent-foreground">{t('Every vehicle, every second, one screen.')}</h2>
          <ul className="space-y-3">
            {HIGHLIGHTS.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3 text-sm">
                <span className="flex size-8 items-center justify-center rounded-lg bg-sidebar-accent text-sidebar-primary">
                  <Icon className="size-4" />
                </span>
                {t(text)}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-sidebar-muted">© {new Date().getFullYear()} VeeTrax</p>
      </aside>
      <main className="relative flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="absolute top-4 right-4">
          <LanguageToggle signedIn={false} />
        </div>
        <div className="w-full max-w-sm space-y-7">
          <Logo className="lg:hidden" />
          <div className="space-y-1.5">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            {description && <p className="text-sm text-muted-foreground">{description}</p>}
          </div>
          {children}
          <footer className="space-y-1 border-t pt-5 text-center text-xs text-muted-foreground">
            <p>
              {t('VeeTrax is a product of and powered by')}
              <br />
              <span className="font-medium text-foreground">Vibhav Enterprise Solutions</span>
            </p>
            <p>
              {t('Support')}:{' '}
              <a href={`tel:${SUPPORT_PHONE.tel}`} className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                <PhoneIcon className="size-3" aria-hidden />
                {SUPPORT_PHONE.display}
              </a>
            </p>
          </footer>
        </div>
      </main>
    </div>
  );
}
