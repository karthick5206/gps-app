import { BRAND_FOOTER } from '@veetracer/shared';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/** Copyright and the privacy policy: one slim line under every page. */
export function AppFooter({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <footer className={cn('border-t bg-card/60 px-4 py-1.5 text-center text-[11px] text-muted-foreground', className)}>
      © {BRAND_FOOTER.year} {BRAND_FOOTER.owner} ·{' '}
      <a href="/privacy" className="hover:text-foreground hover:underline">
        {t('Privacy policy')}
      </a>{' '}
      ·{' '}
      <a href="/guide" className="hover:text-foreground hover:underline">
        {t('Getting-started guide')}
      </a>
    </footer>
  );
}
