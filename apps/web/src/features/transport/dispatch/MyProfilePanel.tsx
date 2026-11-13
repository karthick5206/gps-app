import type { MeTransportProfileDto } from '@veetracer/shared';
import { CircleCheckIcon, HomeIcon, MapPinIcon, PencilIcon, PlusIcon, SearchIcon, Trash2Icon, UserRoundIcon, XIcon } from 'lucide-react';
import { lazy, Suspense, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { ApiError, errorMessage } from '@/lib/api';
import { e3ErrorMessage, SimpleSelect } from './e3-ui';
import {
  buildHomeInput,
  buildProfileUpdate,
  emptyContact,
  hasProfileErrors,
  HOME_SOURCE_LABEL,
  homeDraftOf,
  homeSavedText,
  ME_PROFILE_LIMITS,
  parseLatLng,
  profileDraftOf,
  validateHome,
  validateProfile,
  type HomeDraft,
  type ProfileDraft,
} from './me-profile';
import { useMyGeocode, useMyPolicy, useMyProfile, useSetMyHome, useUpdateMyProfile } from './use-e3';

const HomePinMap = lazy(() => import('../HomePinMap').then((m) => ({ default: m.HomePinMap })));
const NONE = '__none';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words">{children}</dd>
    </div>
  );
}

/** Edit default stop, emergency contacts and accessibility (PATCH /me/transport/profile). */
function ProfileForm({ profile, onDone }: { profile: MeTransportProfileDto; onDone: () => void }) {
  const { t } = useTranslation();
  const policy = useMyPolicy();
  const update = useUpdateMyProfile();
  const [d, setD] = useState<ProfileDraft>(() => profileDraftOf(profile));
  const [tried, setTried] = useState(false);
  const errors = validateProfile(d, t);
  const stops = policy.data?.stops ?? [];
  const set = (patch: Partial<ProfileDraft>) => setD((x) => ({ ...x, ...patch }));
  const setContact = (i: number, patch: Partial<ProfileDraft['contacts'][number]>) => setD((x) => ({ ...x, contacts: x.contacts.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (hasProfileErrors(validateProfile(d, t))) return;
    const input = buildProfileUpdate(d, profile);
    if (!input) {
      onDone();
      return;
    }
    update.mutate(input, {
      onSuccess: () => {
        toast.success(t('Profile saved'));
        onDone();
      },
    });
  };

  const stopOptions = [{ value: NONE, label: t('No default stop') }, ...stops.map((s) => ({ value: s.id, label: s.name }))];
  if (profile.defaultStop && !stops.some((s) => s.id === profile.defaultStop!.id)) stopOptions.push({ value: profile.defaultStop.id, label: profile.defaultStop.name });

  return (
    <form noValidate onSubmit={submit} className="grid gap-4">
      {update.isError && <FormError message={e3ErrorMessage(update.error, t)} />}
      <Field label={t('Default stop')} htmlFor="me-stop" hint={stops.length ? t('The company stop used when you do not give a pickup.') : t('No company stops are offered to you right now.')}>
        <SimpleSelect id="me-stop" label={t('Default stop')} value={d.defaultStopId ?? NONE} onChange={(v) => set({ defaultStopId: v === NONE ? null : v })} options={stopOptions} disabled={!stops.length && !profile.defaultStop} />
      </Field>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">{t('Emergency contacts')}</legend>
        {d.contacts.length === 0 && <p className="text-sm text-muted-foreground">{t('No emergency contacts yet.')}</p>}
        {d.contacts.map((c, i) => {
          const ce = tried ? errors.contact?.[i] : undefined;
          return (
            <div key={i} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-start">
              <Field label={t('Name')} htmlFor={`me-c${i}-name`} required error={ce?.name}>
                <Input id={`me-c${i}-name`} value={c.name} maxLength={ME_PROFILE_LIMITS.nameMax} onChange={(e) => setContact(i, { name: e.target.value })} autoComplete="off" />
              </Field>
              <Field label={t('Phone')} htmlFor={`me-c${i}-phone`} required error={ce?.phone}>
                <Input id={`me-c${i}-phone`} type="tel" inputMode="tel" value={c.phone} maxLength={ME_PROFILE_LIMITS.phoneMax} onChange={(e) => setContact(i, { phone: e.target.value })} autoComplete="off" />
              </Field>
              <Field label={t('Relation (optional)')} htmlFor={`me-c${i}-rel`} error={ce?.relation}>
                <Input id={`me-c${i}-rel`} value={c.relation} maxLength={ME_PROFILE_LIMITS.relationMax} onChange={(e) => setContact(i, { relation: e.target.value })} autoComplete="off" />
              </Field>
              <Button type="button" variant="ghost" size="icon" className="sm:mt-6" aria-label={t('Remove contact {{n}}', { n: i + 1 })} onClick={() => set({ contacts: d.contacts.filter((_, j) => j !== i) })}>
                <Trash2Icon />
              </Button>
            </div>
          );
        })}
        {tried && errors.contacts && <p role="alert" className="text-xs text-destructive">{errors.contacts}</p>}
        {d.contacts.length < ME_PROFILE_LIMITS.contactsMax && (
          <div>
            <Button type="button" size="sm" variant="outline" onClick={() => set({ contacts: [...d.contacts, emptyContact()] })}>
              <PlusIcon /> {t('Add a contact')}
            </Button>
          </div>
        )}
      </fieldset>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">{t('Accessibility')}</legend>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={d.wheelchair} onCheckedChange={(v) => set({ wheelchair: v })} />
          {t('I use a wheelchair')}
        </label>
        <Field label={t('Other needs (optional)')} htmlFor="me-notes" error={tried ? errors.notes : undefined} hint={t('Shown to the transport team so they can plan a suitable vehicle.')}>
          <Textarea id="me-notes" value={d.notes} maxLength={ME_PROFILE_LIMITS.notesMax} onChange={(e) => set({ notes: e.target.value })} rows={2} />
        </Field>
      </fieldset>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={onDone} disabled={update.isPending}>
          {t('Cancel')}
        </Button>
        <Button type="submit" disabled={update.isPending}>
          {update.isPending && <Spinner />} {t('Save profile')}
        </Button>
      </div>
    </form>
  );
}

/** Home location: self-hosted address search, map pin or typed coordinates (PUT /me/transport/home); consent-gated. */
function HomeEditor({ profile, onDone }: { profile: MeTransportProfileDto; onDone: (message: string) => void }) {
  const { t } = useTranslation();
  const save = useSetMyHome();
  const [d, setD] = useState<HomeDraft>(() => homeDraftOf(profile));
  const [text, setText] = useState('');
  const [query, setQuery] = useState<string | null>(null);
  const [typedError, setTypedError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const geocode = useMyGeocode(query ?? '', query !== null);
  const error = validateHome(d, profile.routingConsent, t);
  const consentMissing = save.error instanceof ApiError && save.error.code === 'CONSENT_REQUIRED';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (validateHome(d, profile.routingConsent, t)) return;
    save.mutate(buildHomeInput(d), { onSuccess: (r) => onDone(homeSavedText(r.openBookingsKept, t)) });
  };
  const useTyped = () => {
    const r = parseLatLng(d.latText, d.lngText, t);
    if ('error' in r) {
      setTypedError(r.error);
      return;
    }
    setTypedError(null);
    setD((x) => ({ ...x, point: r, source: 'TYPED' }));
  };

  return (
    <form noValidate onSubmit={submit} className="grid gap-3">
      {save.isError && <FormError message={consentMissing ? t('Your transport consent is needed before a home location can be saved.') : e3ErrorMessage(save.error, t)} />}
      <div className="flex gap-2">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (text.trim().length >= 3) setQuery(text.trim());
            }
          }}
          placeholder={t('Search your address…')}
          aria-label={t('Search your address')}
          autoComplete="off"
        />
        <Button type="button" variant="outline" onClick={() => setQuery(text.trim())} disabled={text.trim().length < 3} aria-label={t('Search address')}>
          <SearchIcon />
          <span className="hidden sm:inline">{t('Search')}</span>
        </Button>
      </div>
      {query !== null && (
        <div className="grid gap-1" aria-live="polite">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground">{t('Address matches')}</p>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t('Close results')} onClick={() => setQuery(null)}>
              <XIcon />
            </Button>
          </div>
          {geocode.isFetching ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> {t('Searching…')}
            </p>
          ) : geocode.isError ? (
            <FormError message={errorMessage(geocode.error)} />
          ) : geocode.data?.length ? (
            <ul className="max-h-44 divide-y overflow-y-auto rounded-lg border">
              {geocode.data.slice(0, 6).map((c, i) => (
                <li key={`${c.lat},${c.lng},${i}`}>
                  <button
                    type="button"
                    className="flex min-h-11 w-full items-start gap-2 px-3 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                    onClick={() => {
                      const point = { lat: Number(c.lat.toFixed(6)), lng: Number(c.lng.toFixed(6)) };
                      setD((x) => ({ ...x, point, address: c.label.slice(0, ME_PROFILE_LIMITS.addressMax), source: 'PHOTON', latText: String(point.lat), lngText: String(point.lng) }));
                      setQuery(null);
                    }}
                  >
                    <MapPinIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 break-words">{c.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t('No match found. Click the map to place the point instead.')}</p>
          )}
        </div>
      )}
      <Suspense fallback={<Skeleton className="h-56 w-full rounded-lg" />}>
        <HomePinMap
          position={d.point}
          onChange={(p) => setD((x) => ({ ...x, point: p, source: 'PIN', latText: String(p.lat), lngText: String(p.lng) }))}
          className="h-56 min-h-0 sm:h-64"
          texts={{ marker: t('Home'), empty: t('Click the map to place your home.'), set: t('Click the map or drag the pin to move it.'), region: t('Map to place your home. You can also search an address above.') }}
        />
      </Suspense>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field label={t('Latitude')} htmlFor="me-lat">
          <Input id="me-lat" inputMode="decimal" value={d.latText} onChange={(e) => setD((x) => ({ ...x, latText: e.target.value }))} />
        </Field>
        <Field label={t('Longitude')} htmlFor="me-lng">
          <Input id="me-lng" inputMode="decimal" value={d.lngText} onChange={(e) => setD((x) => ({ ...x, lngText: e.target.value }))} />
        </Field>
        <Button type="button" variant="outline" className="col-span-2 sm:col-span-1" onClick={useTyped}>
          {t('Use these coordinates')}
        </Button>
      </div>
      {typedError && <p role="alert" className="text-xs text-destructive">{typedError}</p>}
      <Field label={t('Address (optional)')} htmlFor="me-addr" hint={t('Shown to the driver as your pickup label.')}>
        <Input id="me-addr" value={d.address} maxLength={ME_PROFILE_LIMITS.addressMax} onChange={(e) => setD((x) => ({ ...x, address: e.target.value }))} />
      </Field>
      {tried && error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <p className="text-xs text-muted-foreground">{t('New bookings use the new home. Bookings already made keep their pickup.')}</p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => onDone('')} disabled={save.isPending}>
          {t('Cancel')}
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending && <Spinner />} {t('Save home location')}
        </Button>
      </div>
    </form>
  );
}

/**
 * My transport profile (D-A9) on the passenger's "My commute" page: view the profile, edit default stop / emergency
 * contacts / accessibility, and set the home location (consent-gated). Login email and mobile are read-only.
 */
export function MyProfilePanel() {
  const { t } = useTranslation();
  const profile = useMyProfile();
  const [mode, setMode] = useState<'view' | 'profile' | 'home'>('view');
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    if (mode !== 'view') setSaved(null);
  }, [mode]);

  if (profile.isPending) return <Skeleton className="h-40 w-full" />;
  if (profile.isError) {
    // An older server without the profile route: hide the section instead of showing an error.
    if (profile.error instanceof ApiError && profile.error.status === 404) return null;
    return <FormError message={e3ErrorMessage(profile.error, t)} />;
  }
  const p = profile.data;
  const home = p.home;

  return (
    <Card className="gap-4 p-4">
      <div className="flex flex-wrap items-start gap-2">
        <UserRoundIcon className="mt-0.5 size-5 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{p.displayName}</p>
          <p className="text-xs text-muted-foreground">{[p.employeeCode, p.branchName, p.officeName].filter(Boolean).join(' · ')}</p>
        </div>
        {mode === 'view' && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setMode('profile')}>
              <PencilIcon /> {t('Edit profile')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setMode('home')} disabled={!p.routingConsent} title={!p.routingConsent ? t('Your transport consent is needed before a home location can be saved.') : undefined}>
              <HomeIcon /> {home?.address || (home?.lat !== null && home?.lat !== undefined) ? t('Change home') : t('Set home')}
            </Button>
          </div>
        )}
      </div>

      {saved && (
        <p role="status" className="flex items-start gap-2 rounded-lg bg-success/10 p-3 text-sm">
          <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
          {saved}
        </p>
      )}

      {mode === 'profile' ? (
        <ProfileForm profile={p} onDone={() => setMode('view')} />
      ) : mode === 'home' ? (
        <HomeEditor
          profile={p}
          onDone={(msg) => {
            setMode('view');
            if (msg) {
              setSaved(msg);
              toast.success(msg);
            }
          }}
        />
      ) : (
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <Row label={t('Login email')}>{p.email ?? '—'}</Row>
          <Row label={t('Mobile')}>{p.mobile ?? '—'}</Row>
          <Row label={t('Home')}>
            {home?.address ?? (home && home.lat !== null ? t('Set on the map') : t('Not set'))}
            {home?.source && <span className="block text-xs text-muted-foreground">{t(HOME_SOURCE_LABEL[home.source] ?? home.source)}</span>}
          </Row>
          <Row label={t('Default stop')}>{p.defaultStop?.name ?? '—'}</Row>
          <Row label={t('Emergency contacts')}>
            {p.emergencyContacts.length ? (
              <ul className="grid gap-0.5">
                {p.emergencyContacts.map((c, i) => (
                  <li key={i}>
                    {c.name} · <span className="tabular-nums">{c.phone}</span>
                    {c.relation && <span className="text-muted-foreground"> ({c.relation})</span>}
                  </li>
                ))}
              </ul>
            ) : (
              '—'
            )}
          </Row>
          <Row label={t('Accessibility')}>
            {p.accessibility?.wheelchair && <Badge variant="info">{t('Wheelchair')}</Badge>} {p.accessibility?.notes ?? (!p.accessibility?.wheelchair ? '—' : '')}
          </Row>
          <p className="text-xs text-muted-foreground sm:col-span-2">
            {t('Your login email and mobile can only be changed by your administrator.')}
            {!p.routingConsent && <> {t('Your transport consent is needed before a home location can be saved.')}</>}
          </p>
        </dl>
      )}
    </Card>
  );
}
