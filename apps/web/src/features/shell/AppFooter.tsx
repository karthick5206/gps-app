import { BRAND_FOOTER } from '@veetracer/shared';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/** "VeeTrax is a product of and powered by …", support phone / e-mail and copyright: one slim line under every page. */
export function AppFooter({ className }: { className?: string }) {
  const { t } = useTranslation();
  const f = BRAND_FOOTER;
  return (
    <footer className={cn('flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5 border-t bg-card/60 px-4 py-1.5 text-center text-[11px] text-muted-foreground', className)}>
      <span>{t('VeeTrax is a product of and powered by {{owner}}', { owner: f.owner })}</span>
      <span className="hidden sm:inline" aria-hidden>
        ·
      </span>
      <span>
        {t('Support:')}{' '}
        <a className="hover:text-foreground hover:underline" href={`tel:${f.supportPhone.replace(/\s/g, '')}`}>
          {f.supportPhone}
        </a>{' '}
        ·{' '}
        <a className="hover:text-foreground hover:underline" href={`mailto:${f.supportEmail}`}>
          {f.supportEmail}
        </a>
      </span>
      <span className="hidden sm:inline" aria-hidden>
        ·
      </span>
      <span>© {f.year} {f.owner}</span>
    </footer>
  );
}
