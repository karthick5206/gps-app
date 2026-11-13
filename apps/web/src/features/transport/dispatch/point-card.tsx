import type { LucideIcon } from 'lucide-react';
import { lazy, Suspense, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { geocodeLabelDefault } from './adhoc-booking';
import { AddressSearchCombobox, BOOKING_GEOCODE_ENDPOINT } from '../AddressSearchCombobox';

/*
 * Building blocks of a ride end ("Pickup" / "Destination") shared by the desk booking dialogs (BookingDialogs,
 * GroupBookingDialog) and the passenger "Request a ride" dialog (MyRideRequestDialog): a full-width card with a heading,
 * a segmented source control, one map for a one-time point, and a folded one-line summary of the chosen point.
 */

const HomePinMap = lazy(() => import('../HomePinMap').then((m) => ({ default: m.HomePinMap })));

export interface SegmentedOption<T extends string> {
  value: T;
  /** Visible text (keep it short). */
  label: string;
  icon?: LucideIcon;
  /** Accessible name and tooltip when the visible label is a short form. */
  fullLabel?: string;
  disabled?: boolean;
  /** Tooltip (e.g. why it is disabled); wins over fullLabel as the tooltip. */
  title?: string;
}

/**
 * Segmented choice (buttons with aria-pressed): full width, equal-width segments. A label that does not fit wraps inside
 * its own segment (never under its neighbour); a segment never shrinks below its longest word, so on a phone it moves to
 * a second row instead. Disabled choices keep their reason as a title. `fit="content"`: segments grow from their own width
 * and never wrap their text (a long label such as "Company place" stays on one line; whole segments wrap instead).
 */
export function Segmented<T extends string>({ value, onChange, options, label, id, fit = 'equal' }: { value: T; onChange: (v: T) => void; options: SegmentedOption<T>[]; label: string; id?: string; fit?: 'equal' | 'content' }) {
  return (
    <div id={id} role="group" aria-label={label} className="flex w-full flex-wrap gap-1 rounded-lg bg-muted p-1">
      {options.map((o) => {
        const Icon = o.icon;
        const short = !!o.fullLabel && o.fullLabel !== o.label;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            aria-label={short ? o.fullLabel : undefined}
            disabled={o.disabled}
            title={o.title ?? (short ? o.fullLabel : undefined)}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex min-h-8 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-center text-sm leading-tight font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45',
              fit === 'content' ? 'flex-auto whitespace-nowrap' : 'flex-1 text-balance',
              value === o.value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {Icon && <Icon className="size-4 shrink-0" aria-hidden />}
            <span>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** One end of a ride as its own full-width card: a heading (legend), the controls, and the end's error. Never stretched. */
export function PointCard({ title, required = true, error, id, children }: { title: string; required?: boolean; error?: string; id?: string; children: ReactNode }) {
  return (
    <fieldset id={id} className="grid min-w-0 content-start gap-2 rounded-lg border bg-card p-3">
      <legend className="px-1 text-sm font-semibold">
        {title}
        {required && (
          <span className="ml-1 text-destructive" aria-hidden>
            *
          </span>
        )}
      </legend>
      {children}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/** The folded one-line summary of a chosen point ("Company place: …") with a Change button that unfolds the card. */
export function PointSummary({ icon: Icon, kindLabel, text, cardTitle, onChange }: { icon: LucideIcon; kindLabel: string; text: string; cardTitle: string; onChange: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md bg-muted/60 py-1.5 pr-1.5 pl-3 text-sm">
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <p className="min-w-0 flex-1 truncate" title={text}>
        <span className="text-muted-foreground">{kindLabel}: </span>
        <span className="font-medium">{text}</span>
      </p>
      <Button type="button" size="sm" variant="outline" onClick={onChange} aria-label={`${t('Change')}: ${cardTitle}`}>
        {t('Change')}
      </Button>
    </div>
  );
}

/** "Done" under a finished point: folds the card into its summary. */
export function PointDone({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex justify-end">
      <Button type="button" size="sm" variant="outline" onClick={onClick}>
        {t('Done')}
      </Button>
    </div>
  );
}

/**
 * A one-time point: address type-ahead (self-hosted Photon via the API) directly above one self-hosted map (~220 px).
 * `onChange` gets the short form of a picked address as `label`; moving the pin gives no label.
 */
export function MapPoint({
  value,
  onChange,
  idPrefix,
  endpoint = BOOKING_GEOCODE_ENDPOINT,
  markerText,
  regionText,
}: {
  value: { lat: number; lng: number } | null;
  onChange: (p: { lat: number; lng: number }, label?: string) => void;
  idPrefix: string;
  endpoint?: string;
  markerText?: string;
  regionText?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-2">
      <AddressSearchCombobox id={`${idPrefix}-addr`} endpoint={endpoint} ariaLabel={t('Search an address')} onPick={(h) => onChange({ lat: h.lat, lng: h.lng }, geocodeLabelDefault(h.label))} />
      <Suspense fallback={<Skeleton className="h-56 w-full rounded-lg" />}>
        <HomePinMap
          position={value}
          onChange={(p) => onChange(p)}
          className="h-56 min-h-0"
          texts={{
            marker: markerText ?? t('Booking point'),
            empty: t('Click the map to place the point.'),
            set: t('Click the map or drag the pin to move it.'),
            region: regionText ?? t('Map to place the booking point. You can also search an address above.'),
          }}
        />
      </Suspense>
    </div>
  );
}
