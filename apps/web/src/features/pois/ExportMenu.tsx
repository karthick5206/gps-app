import { FileDownIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { errorMessage } from '@/lib/api';
import { exportPois, type ExportFormat, type ExportInclude } from './api';

const FORMATS: { format: ExportFormat; label: string }[] = [
  { format: 'kml', label: 'KML (Google Earth)' },
  { format: 'geojson', label: 'GeoJSON' },
];

const INCLUDE_LABEL: Record<ExportInclude, string> = {
  pois: 'POIs only',
  all: 'POIs + geofences',
  geofences: 'Geofences only',
};

/** "Export" dropdown: KML / GeoJSON download of POIs and/or geofences via `GET /pois/export`. */
export function ExportMenu({ includes }: { includes: ExportInclude[] }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  const run = async (format: ExportFormat, include: ExportInclude) => {
    setBusy(true);
    try {
      await exportPois(format, include);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" disabled={busy}>
          {busy ? <Spinner /> : <FileDownIcon />}
          <span className="hidden sm:inline">{t('Export map file')}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {FORMATS.map((f, i) => (
          <div key={f.format}>
            {i > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel>{t(f.label)}</DropdownMenuLabel>
            {includes.map((inc) => (
              <DropdownMenuItem key={inc} onSelect={() => run(f.format, inc)}>
                {t(INCLUDE_LABEL[inc])}
              </DropdownMenuItem>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
