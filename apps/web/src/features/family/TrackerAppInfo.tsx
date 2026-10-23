import { DownloadIcon, SmartphoneIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const POINTS = [
  'Install it on the phone to be tracked (Android 7 or newer).',
  'Open it and enter that phone’s mobile number: a 6-digit code comes by SMS.',
  'Allow location “All the time”: tracking keeps running in the background until Stop is tapped.',
  'Free for 100 days, then a yearly licence. Uses mobile data lightly and saves battery when the phone is still.',
] as const;

/**
 * What the VeeTrax Tracker app is and where to get it, wherever someone is asked to set up phone tracking
 * (Track a phone, Devices → Tracker app, Family members).
 */
export function TrackerAppInfo({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <div className={cn('space-y-2 rounded-md border bg-muted/40 p-3 text-sm', className)}>
      <p className="flex items-center gap-2 font-medium">
        <SmartphoneIcon className="size-4 text-primary" /> {t('VeeTrax Tracker app')}
      </p>
      <ul className="list-disc space-y-1 ps-5 text-muted-foreground">
        {POINTS.map((p) => (
          <li key={p}>{t(p)}</li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild size="sm" variant="outline">
          <a href="/download" target="_blank" rel="noreferrer">
            <DownloadIcon /> {t('Download VeeTrax Tracker')}
          </a>
        </Button>
        <span className="text-xs text-muted-foreground">{t('Or open app.veetrax.com/download on that phone.')}</span>
      </div>
    </div>
  );
}
