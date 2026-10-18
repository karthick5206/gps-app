import { useTranslation } from 'react-i18next';
import { LogoMark } from './logo';

export function FullScreenLoader() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-dvh items-center justify-center" role="status" aria-label={t('Loading')}>
      <LogoMark className="size-10 animate-pulse" />
    </div>
  );
}
