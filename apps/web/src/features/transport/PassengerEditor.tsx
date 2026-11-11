import { zodResolver } from '@hookform/resolvers/zod';
import {
  phoneCountryForTimezone,
  type BranchDto,
  type CreatePassengerInput,
  type HomeLocationSource,
  type PassengerDto,
  type PassengerHomeInput,
  type PassengerProjection,
  type PoiDto,
  type UpdatePassengerInput,
} from '@veetracer/shared';
import { EyeOffIcon, HistoryIcon, InfoIcon, LockIcon, MapPinIcon, PlusIcon, SearchIcon, Trash2Icon, XIcon } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { FormError } from '@/components/form-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { Option } from '@/components/ui/multi-select';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/features/auth/auth-context';
import { ComboboxField, SwitchField, TextField } from '@/features/masters/form-fields';
import { nullIfBlank, optionalText, requiredText, str } from '@/features/masters/form-schema';
import type { MasterFormProps } from '@/features/masters/types';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { errorMessage } from '@/lib/api';
import { AppLoginPanel } from './AppLoginPanel';
import { ConsentPanel } from './ConsentPanel';
import { HomePinMap } from './HomePinMap';
import { PassengerHistorySheet } from './PassengerHistorySheet';
import { AppAccessBadge, LocationBadge, RoutingConsentBadge, ToneBadge } from './passenger-ui';
import { formatCoords, geocodeMatchBadge, HOME_SOURCE_LABEL, isApproximate, MAX_EMERGENCY_CONTACTS, parseLatLng, validateEmergencyContacts } from './people-format';
import { ErasePassengerDialog } from './ErasePassengerDialog';
import { useAppAccess, useGeocode, usePassenger, usePassengerLoginReset, useSavePassenger } from './use-people';

const schema = z.object({
  employeeCode: requiredText(40),
  displayName: requiredText(120),
  mobile: optionalText(25),
  email: z.string().trim().max(254).refine((v) => v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Invalid email address'),
  branchId: z.string().nullable(),
  officePoiId: z.string().nullable(),
  defaultStopPoiId: z.string().nullable(),
  wheelchair: z.boolean(),
  accessibilityNotes: optionalText(500),
  isActive: z.boolean(),
});
type Values = z.infer<typeof schema>;

interface HomeDraft {
  address: string;
  lat: number | null;
  lng: number | null;
  source: HomeLocationSource | null;
  confidence: number | null;
}
interface ContactDraft {
  name: string;
  phone: string;
  relation: string;
}

/** Enter in the consent / login inputs must not submit the passenger form around them (implicit submission). */
const swallowEnter = (e: React.KeyboardEvent) => {
  if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') e.preventDefault();
};

const poiOption = (p: PoiDto): Option => ({ value: p.id, label: p.name, description: p.branchName ?? undefined });

function valuesOf(p: PassengerDto | null): Values {
  return {
    employeeCode: str(p?.employeeCode),
    displayName: str(p?.displayName),
    mobile: str(p?.mobile),
    email: str(p?.email),
    branchId: p?.branchId ?? null,
    officePoiId: p?.office?.id ?? null,
    defaultStopPoiId: p?.defaultStop?.id ?? null,
    wheelchair: !!p?.accessibility?.wheelchair,
    accessibilityNotes: str(p?.accessibility?.notes),
    isActive: p?.isActive ?? true,
  };
}

function homeOf(p: PassengerDto | null): HomeDraft {
  const h = p?.home;
  return { address: h?.address ?? '', lat: h?.lat ?? null, lng: h?.lng ?? null, source: h?.source ?? null, confidence: h?.confidence ?? null };
}

function contactsOf(p: PassengerDto | null): ContactDraft[] {
  return (p?.emergencyContacts ?? []).map((c) => ({ name: c.name, phone: c.phone, relation: c.relation ?? '' }));
}

/** Only the fields that changed (PATCH); dispatchers must never send `home` or contacts, the server refuses them. */
function diff(before: Values, v: Values): UpdatePassengerInput {
  const out: UpdatePassengerInput = {};
  if (v.employeeCode !== before.employeeCode) out.employeeCode = v.employeeCode;
  if (v.displayName !== before.displayName) out.displayName = v.displayName;
  if (v.mobile !== before.mobile) out.mobile = nullIfBlank(v.mobile);
  if (v.email !== before.email) out.email = nullIfBlank(v.email);
  if (v.branchId !== before.branchId) out.branchId = v.branchId;
  if (v.officePoiId !== before.officePoiId) out.officePoiId = v.officePoiId;
  if (v.defaultStopPoiId !== before.defaultStopPoiId) out.defaultStopPoiId = v.defaultStopPoiId;
  if (v.wheelchair !== before.wheelchair || v.accessibilityNotes !== before.accessibilityNotes) {
    out.accessibility = { wheelchair: v.wheelchair, ...(v.accessibilityNotes.trim() ? { notes: v.accessibilityNotes.trim() } : {}) };
  }
  if (v.isActive !== before.isActive) out.isActive = v.isActive;
  return out;
}

/**
 * Full-screen passenger editor (RouteEditor shell, doc 07 §6.1 / §8.3): Details, Home & pickup (self-hosted map, pin by
 * click / drag / typed coordinates / Photon address search through the API), Safety (emergency contacts, accessibility),
 * and for saved passengers Consent and App access. What is shown and editable follows the server projection: dispatchers
 * (STANDARD) see a hidden address and a rounded pin and cannot change home or contacts.
 */
export function PassengerEditor({ record, open, onOpenChange }: MasterFormProps<PassengerDto>) {
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const uid = useId();
  const [passengerId, setPassengerId] = useState<string | null>(record?.id ?? null);
  const detail = usePassenger(passengerId);
  const p = detail.data ?? null;
  const projection: PassengerProjection = p?.projection ?? record?.projection ?? (me?.dataScope === 'COMPANY' ? 'FULL' : 'STANDARD');
  const canWrite = projection !== 'MINIMAL' && (passengerId ? can('etms_passengers', 'edit') : can('etms_passengers', 'create'));
  const readOnly = !canWrite;
  const canEditHome = canWrite && projection === 'FULL';
  const country = phoneCountryForTimezone(me?.company.timezone);

  const [tab, setTab] = useState('details');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [eraseOpen, setEraseOpen] = useState(false);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: valuesOf(record) });
  const baseline = useRef<Values>(valuesOf(record));
  const [home, setHome] = useState<HomeDraft>(homeOf(null));
  const [homeDirty, setHomeDirty] = useState(false);
  const [contacts, setContacts] = useState<ContactDraft[]>([]);
  const [contactsDirty, setContactsDirty] = useState(false);
  const [contactErrors, setContactErrors] = useState<ReturnType<typeof validateEmergencyContacts>['errors']>([]);
  const loadedFor = useRef<string | null>(null);

  // Load the detail once per passenger (later refetches, e.g. after consent changes, must not wipe unsaved edits).
  useEffect(() => {
    if (!p || loadedFor.current === p.id) return;
    loadedFor.current = p.id;
    const v = valuesOf(p);
    baseline.current = v;
    form.reset(v);
    setHome(homeOf(p));
    setHomeDirty(false);
    setContacts(contactsOf(p));
    setContactsDirty(false);
  }, [p, form]);

  const branches = useEntityOptions<BranchDto>('/branches', named, { enabled: open && can('branches') });
  const pois = useEntityOptions<PoiDto>('/pois', poiOption, { enabled: open && can('pois') });
  const save = useSavePassenger(passengerId);

  const setPoint = (lat: number, lng: number, source: HomeLocationSource, confidence: number | null = null) => {
    setHome((h) => ({ ...h, lat, lng, source, confidence }));
    setHomeDirty(true);
  };

  const submit = form.handleSubmit(
    (v) => {
      const { contacts: cleanContacts, errors } = validateEmergencyContacts(contacts, country);
      if (canEditHome && contactsDirty && errors.length) {
        setContactErrors(errors);
        setTab('safety');
        return;
      }
      setContactErrors([]);
      const homeInput: PassengerHomeInput | null | undefined =
        canEditHome && homeDirty
          ? home.lat === null && !home.address.trim()
            ? null
            : {
                address: home.address.trim() || null,
                lat: home.lat,
                lng: home.lng,
                ...(home.lat !== null && home.source ? { source: home.source } : {}),
                ...(home.source === 'PHOTON' ? { confidence: home.confidence } : {}),
              }
          : undefined;

      let body: CreatePassengerInput | UpdatePassengerInput;
      if (!passengerId) {
        body = {
          employeeCode: v.employeeCode,
          displayName: v.displayName,
          mobile: nullIfBlank(v.mobile),
          email: nullIfBlank(v.email),
          branchId: v.branchId,
          officePoiId: v.officePoiId,
          defaultStopPoiId: v.defaultStopPoiId,
          accessibility: { wheelchair: v.wheelchair, ...(v.accessibilityNotes.trim() ? { notes: v.accessibilityNotes.trim() } : {}) },
          ...(homeInput ? { home: homeInput } : {}),
          ...(canEditHome && cleanContacts.length ? { emergencyContacts: cleanContacts } : {}),
        } satisfies CreatePassengerInput;
      } else {
        body = diff(baseline.current, v);
        if (homeInput !== undefined) body.home = homeInput;
        if (canEditHome && contactsDirty) body.emergencyContacts = cleanContacts;
        if (!Object.keys(body).length) {
          onOpenChange(false);
          return;
        }
      }
      save.mutate(body, {
        onSuccess: (row) => {
          toast.success(passengerId ? t('Passenger updated') : t('Passenger created'));
          if (!passengerId) {
            // Stay open on the new passenger so consent and app access can be set right away.
            loadedFor.current = null;
            setPassengerId(row.id);
            setTab('consent');
          } else onOpenChange(false);
        },
        onError: (err) => toast.error(errorMessage(err)),
      });
    },
    () => setTab('details'),
  );

  const loading = !!passengerId && detail.isPending;
  const title = passengerId ? (p?.displayName ?? record?.displayName ?? t('Passenger')) : t('Add passenger');
  const showConsent = !!passengerId && projection === 'FULL';
  const showAccess = !!passengerId && projection !== 'MINIMAL';
  // M3: a dispatcher's map shows the pickup point only (the server sends no home point), and only with routing consent.
  const pickup = projection === 'STANDARD' ? (p?.pickup ?? null) : null;
  const position = projection === 'STANDARD' ? (pickup?.kind === 'HOME' ? { lat: pickup.lat, lng: pickup.lng } : null) : home.lat !== null && home.lng !== null ? { lat: home.lat, lng: home.lng } : null;
  const mapStop = projection === 'STANDARD' ? (pickup?.kind === 'STOP' ? { lat: pickup.lat, lng: pickup.lng, name: pickup.label ?? '' } : null) : p?.defaultStop ? { lat: p.defaultStop.lat, lng: p.defaultStop.lng, name: p.defaultStop.name } : null;
  const approximate = isApproximate(projection);

  return (
    <Dialog open={open} onOpenChange={(o) => !save.isPending && onOpenChange(o)}>
      <DialogContent className="top-0 left-0 h-dvh max-h-none w-screen max-w-none translate-x-0 translate-y-0 gap-0 rounded-none border-0 p-0 sm:top-1/2 sm:left-1/2 sm:h-[calc(100dvh-2rem)] sm:w-[calc(100vw-2rem)] sm:max-w-6xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:border">
        <form noValidate onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
            <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3 pr-12">
              <div className="min-w-0 flex-1">
                <DialogTitle className="flex flex-wrap items-center gap-2">
                  <span className="truncate">{title}</span>
                  {p && <span className="font-mono text-xs font-normal text-muted-foreground">{p.employeeCode}</span>}
                  {readOnly && (
                    <Badge variant="muted">
                      <LockIcon /> {t('Read only')}
                    </Badge>
                  )}
                  {p && !p.isActive && !p.erasedAt && <Badge variant="neutral">{t('Archived')}</Badge>}
                  {p?.erasedAt && <Badge variant="neutral">{t('Personal data erased')}</Badge>}
                </DialogTitle>
                <DialogDescription className="flex flex-wrap items-center gap-1.5 pt-1 text-xs">
                  {p ? (
                    <>
                      <LocationBadge passenger={p} />
                      <RoutingConsentBadge active={p.routingConsent} />
                      {p.projection !== 'MINIMAL' && <AppAccessBadge access={p.appAccess} />}
                    </>
                  ) : (
                    t('Employee transport profile: who to pick up, where and how.')
                  )}
                </DialogDescription>
              </div>
              <TabsList className="order-last w-full overflow-x-auto sm:order-none sm:w-auto">
                <TabsTrigger value="details" className="flex-1 sm:flex-none">
                  {t('Details')}
                </TabsTrigger>
                <TabsTrigger value="location" className="flex-1 sm:flex-none">
                  {t('Home & pickup')}
                </TabsTrigger>
                <TabsTrigger value="safety" className="flex-1 sm:flex-none">
                  {t('Safety')}
                </TabsTrigger>
                {showConsent && (
                  <TabsTrigger value="consent" className="flex-1 sm:flex-none">
                    {t('Consent')}
                  </TabsTrigger>
                )}
                {showAccess && (
                  <TabsTrigger value="access" className="flex-1 sm:flex-none">
                    {t('App access')}
                  </TabsTrigger>
                )}
              </TabsList>
              <div className="flex gap-2">
                {p && !p.isActive && !p.erasedAt && projection === 'FULL' && can('etms_passengers', 'delete') && (
                  <Button type="button" variant="ghost" className="text-destructive" onClick={() => setEraseOpen(true)} aria-label={t('Erase personal data')}>
                    <Trash2Icon /> <span className="hidden lg:inline">{t('Erase personal data')}</span>
                  </Button>
                )}
                {passengerId && p && (
                  <Button type="button" variant="ghost" onClick={() => setHistoryOpen(true)} aria-label={t('History')}>
                    <HistoryIcon /> <span className="hidden lg:inline">{t('History')}</span>
                  </Button>
                )}
                <Button variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>
                  {readOnly ? t('Close') : t('Cancel')}
                </Button>
                {!readOnly && (
                  <Button type="submit" disabled={save.isPending || loading}>
                    {save.isPending && <Spinner />}
                    {t('Save')}
                  </Button>
                )}
              </div>
            </header>

            {loading ? (
              <div className="flex flex-1 items-center justify-center">
                <Spinner />
              </div>
            ) : detail.isError ? (
              <div className="p-6">
                <FormError message={errorMessage(detail.error)} />
              </div>
            ) : (
              <>
                <TabsContent value="details" forceMount className="min-h-0 flex-1 overflow-y-auto data-[state=inactive]:hidden">
                  <fieldset disabled={readOnly} className="mx-auto w-full max-w-2xl min-w-0 space-y-4 p-4 sm:p-6">
                    {save.error && <FormError message={errorMessage(save.error)} />}
                    <div className="grid gap-3 sm:grid-cols-2">
                      <TextField form={form} name="displayName" label="Name" required autoComplete="off" />
                      <TextField form={form} name="employeeCode" label="Employee code" required autoComplete="off" />
                      {projection === 'MINIMAL' ? (
                        <Field label={t('Mobile')}>
                          <Input value={p?.mobile ?? t('Not shared')} disabled />
                        </Field>
                      ) : (
                        <TextField form={form} name="mobile" label="Mobile" type="tel" placeholder="+919876543210" autoComplete="off" hint="Local numbers get the company’s country code." />
                      )}
                      {projection !== 'MINIMAL' && <TextField form={form} name="email" label="Email" type="email" autoComplete="off" />}
                      {can('branches') ? (
                        <ComboboxField
                          form={form}
                          name="branchId"
                          label="Branch"
                          options={branches.options}
                          loading={branches.loading}
                          placeholder={me?.dataScope === 'COMPANY' ? 'Company-wide' : 'Choose a branch'}
                          selectedOption={p?.branchId ? { value: p.branchId, label: p.branchName ?? '' } : null}
                        />
                      ) : (
                        <Field label={t('Branch')}>
                          <Input value={p?.branchName ?? t('Company-wide')} disabled />
                        </Field>
                      )}
                      {can('pois') ? (
                        <ComboboxField
                          form={form}
                          name="officePoiId"
                          label="Office / site"
                          options={pois.options}
                          loading={pois.loading}
                          placeholder="Choose the office"
                          selectedOption={p?.office ? { value: p.office.id, label: p.office.name } : null}
                        />
                      ) : (
                        <Field label={t('Office / site')} hint={t('You need access to Places to change it.')}>
                          <Input value={p?.office?.name ?? '—'} disabled />
                        </Field>
                      )}
                    </div>
                    {passengerId && <SwitchField form={form} name="isActive" label="Active" hint="Archived passengers are kept with their history; their login is disabled." />}
                  </fieldset>
                </TabsContent>

                <TabsContent value="location" forceMount className="flex min-h-0 flex-1 flex-col overflow-y-auto data-[state=inactive]:hidden md:flex-row md:overflow-hidden">
                  <HomePinMap
                    position={position}
                    approximate={approximate && !homeDirty}
                    readOnly={!canEditHome}
                    stop={mapStop}
                    onChange={(pt) => setPoint(pt.lat, pt.lng, 'PIN')}
                    className="h-[45vh] shrink-0 rounded-none border-0 md:h-auto md:flex-1"
                  />
                  <div className="w-full min-w-0 shrink-0 space-y-4 p-4 md:w-[420px] md:overflow-y-auto md:border-l">
                    <HomeFields
                      idPrefix={uid}
                      home={home}
                      projection={projection}
                      editable={canEditHome}
                      dirty={homeDirty}
                      hasHome={!!p?.hasHomeLocation}
                      onAddress={(address) => {
                        setHome((h) => ({ ...h, address }));
                        setHomeDirty(true);
                      }}
                      onPoint={setPoint}
                      onClear={() => {
                        setHome({ address: '', lat: null, lng: null, source: null, confidence: null });
                        setHomeDirty(true);
                      }}
                    />
                    <fieldset disabled={readOnly} className="space-y-3 border-t pt-4">
                      <legend className="sr-only">{t('Pickup stop')}</legend>
                      {can('pois') ? (
                        <ComboboxField
                          form={form}
                          name="defaultStopPoiId"
                          label="Pickup stop"
                          options={pois.options}
                          loading={pois.loading}
                          placeholder="Door-to-door (home)"
                          hint="Set a shuttle stop to pick the passenger up there instead of at home."
                          selectedOption={p?.defaultStop ? { value: p.defaultStop.id, label: p.defaultStop.name } : null}
                        />
                      ) : (
                        <Field label={t('Pickup stop')}>
                          <Input value={p?.defaultStop?.name ?? t('Door-to-door (home)')} disabled />
                        </Field>
                      )}
                      {p && <PickupSummary passenger={p} />}
                    </fieldset>
                  </div>
                </TabsContent>

                <TabsContent value="safety" forceMount className="min-h-0 flex-1 overflow-y-auto data-[state=inactive]:hidden">
                  <div className="mx-auto w-full max-w-2xl min-w-0 space-y-6 p-4 sm:p-6">
                    <fieldset disabled={readOnly} className="space-y-3">
                      <legend className="text-sm font-semibold">{t('Accessibility')}</legend>
                      <SwitchField form={form} name="wheelchair" label="Uses a wheelchair" hint="Only vehicles with a wheelchair space will be planned for this passenger." />
                      <TextField form={form} name="accessibilityNotes" label="Accessibility notes" multiline hint="For example: needs the front seat, travels with a guide dog." />
                    </fieldset>
                    <section className="space-y-3" aria-labelledby={`${uid}-contacts`}>
                      <h3 id={`${uid}-contacts`} className="text-sm font-semibold">
                        {t('Emergency contacts')}
                      </h3>
                      {projection === 'FULL' ? (
                        <ContactsEditor
                          idPrefix={uid}
                          rows={contacts}
                          errors={contactErrors}
                          editable={canEditHome}
                          onChange={(rows) => {
                            setContacts(rows);
                            setContactsDirty(true);
                          }}
                        />
                      ) : (
                        <p className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
                          <EyeOffIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
                          {t('Emergency contacts are visible to the corporate transport admin only.')}
                        </p>
                      )}
                    </section>
                  </div>
                </TabsContent>

                {showConsent && passengerId && (
                  <TabsContent value="consent" className="min-h-0 flex-1 overflow-y-auto">
                    <div className="mx-auto w-full max-w-3xl min-w-0 p-4 sm:p-6" onSubmit={(e) => e.stopPropagation()} onKeyDown={swallowEnter}>
                      <ConsentPanel passengerId={passengerId} canRecord={canWrite && !!p?.isActive} />
                    </div>
                  </TabsContent>
                )}

                {showAccess && p && (
                  <TabsContent value="access" className="min-h-0 flex-1 overflow-y-auto">
                    <div className="mx-auto w-full max-w-2xl min-w-0 p-4 sm:p-6" onSubmit={(e) => e.stopPropagation()} onKeyDown={swallowEnter}>
                      <PassengerAccess passenger={p} canEdit={can('etms_passengers', 'edit')} />
                    </div>
                  </TabsContent>
                )}
              </>
            )}
          </Tabs>
        </form>
        {passengerId && p && <PassengerHistorySheet target={historyOpen ? { id: passengerId, label: p.displayName } : null} onClose={() => setHistoryOpen(false)} />}
        {p && !p.erasedAt && <ErasePassengerDialog passenger={p} open={eraseOpen} onOpenChange={setEraseOpen} />}
      </DialogContent>
    </Dialog>
  );
}

/** Address search (Photon via the API only), typed coordinates (the keyboard way to set the pin) and the location source. */
function HomeFields({
  idPrefix,
  home,
  projection,
  editable,
  dirty,
  hasHome,
  onAddress,
  onPoint,
  onClear,
}: {
  idPrefix: string;
  home: HomeDraft;
  projection: PassengerProjection;
  editable: boolean;
  dirty: boolean;
  hasHome: boolean;
  onAddress: (address: string) => void;
  onPoint: (lat: number, lng: number, source: HomeLocationSource, confidence?: number | null) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState<string | null>(null);
  const geocode = useGeocode(query ?? '', editable && query !== null);
  const [latText, setLatText] = useState('');
  const [lngText, setLngText] = useState('');
  const [coordError, setCoordError] = useState<string | null>(null);

  useEffect(() => {
    setLatText(home.lat === null ? '' : String(home.lat));
    setLngText(home.lng === null ? '' : String(home.lng));
  }, [home.lat, home.lng]);

  const applyCoords = () => {
    const pt = parseLatLng(latText, lngText);
    if (!pt) {
      setCoordError(t('Enter a valid latitude (−90 to 90) and longitude (−180 to 180), not 0, 0.'));
      return;
    }
    setCoordError(null);
    if (pt.lat !== home.lat || pt.lng !== home.lng) onPoint(pt.lat, pt.lng, 'TYPED');
  };

  const coords = formatCoords(home.lat, home.lng, dirty ? 'FULL' : projection);
  const approximate = !dirty && isApproximate(projection);

  if (projection === 'MINIMAL') {
    return <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">{t('The home location is not shared with transport providers. Only the pickup point is shown.')}</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <MapPinIcon className="size-4 text-muted-foreground" aria-hidden />
        <h3 className="text-sm font-semibold">{t('Home location')}</h3>
      </div>

      {projection === 'STANDARD' ? (
        <div className="space-y-2 rounded-lg border p-3 text-sm">
          <p className="flex items-center gap-2 text-muted-foreground">
            <EyeOffIcon className="size-4 shrink-0" aria-hidden /> {t('Address hidden for your role')}
          </p>
          <p className="text-muted-foreground">{hasHome ? t('A home point is set.') : t('No home point yet.')}</p>
          <p className="text-xs text-muted-foreground">{t('The home point is not shown to your role. The map shows the pickup point only, once the passenger has consented to transport planning. Only the corporate admin sees and changes the home location.')}</p>
        </div>
      ) : (
        <>
          <Field label={t('Address')} htmlFor={`${idPrefix}-addr`} hint={editable ? t('Search uses the VeeTrax address server. Confirm a result, then check the pin.') : undefined}>
            <div className="flex gap-2">
              <Input
                id={`${idPrefix}-addr`}
                value={home.address}
                disabled={!editable}
                onChange={(e) => onAddress(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (home.address.trim().length >= 3) setQuery(home.address.trim());
                  }
                }}
                autoComplete="off"
              />
              {editable && (
                <Button type="button" variant="outline" onClick={() => setQuery(home.address.trim())} disabled={home.address.trim().length < 3} aria-label={t('Search address')}>
                  <SearchIcon />
                  <span className="hidden sm:inline">{t('Search')}</span>
                </Button>
              )}
            </div>
          </Field>

          {query !== null && editable && (
            <div className="space-y-1.5" aria-live="polite">
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
                <ul className="divide-y rounded-lg border">
                  {geocode.data.slice(0, 6).map((c, i) => {
                    const match = geocodeMatchBadge(c);
                    return (
                      <li key={`${c.lat},${c.lng},${i}`}>
                        <button
                          type="button"
                          className="flex min-h-11 w-full items-start gap-2 px-3 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                          onClick={() => {
                            onPoint(Number(c.lat.toFixed(6)), Number(c.lng.toFixed(6)), 'PHOTON', c.confidence ?? null);
                            setQuery(null);
                          }}
                        >
                          <MapPinIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                          <span className="min-w-0 flex-1 break-words">{c.label}</span>
                          {match && <ToneBadge tone={match.tone}>{t(match.label)}</ToneBadge>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">{t('No match found. Place the pin on the map or type the coordinates instead.')}</p>
              )}
            </div>
          )}

          <fieldset className="space-y-2" disabled={!editable}>
            <legend className="text-xs font-medium text-muted-foreground">{t('Coordinates')}</legend>
            <div className="grid grid-cols-2 gap-2">
              <Field label={t('Latitude')} htmlFor={`${idPrefix}-lat`}>
                <Input id={`${idPrefix}-lat`} inputMode="decimal" value={latText} onChange={(e) => setLatText(e.target.value)} onBlur={() => latText && lngText && applyCoords()} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), applyCoords())} className="font-mono" />
              </Field>
              <Field label={t('Longitude')} htmlFor={`${idPrefix}-lng`}>
                <Input id={`${idPrefix}-lng`} inputMode="decimal" value={lngText} onChange={(e) => setLngText(e.target.value)} onBlur={() => latText && lngText && applyCoords()} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), applyCoords())} className="font-mono" />
              </Field>
            </div>
            {coordError && (
              <p role="alert" className="text-xs text-destructive">
                {coordError}
              </p>
            )}
          </fieldset>
        </>
      )}

      {(home.source || coords) && projection !== 'STANDARD' && (
        <div className="space-y-1 rounded-lg bg-muted/50 px-3 py-2 text-xs">
          {home.source && (
            <p>
              <span className="text-muted-foreground">{t('Location source')}: </span>
              <span className="font-medium">{t(HOME_SOURCE_LABEL[home.source])}</span>
              {home.source === 'PHOTON' && home.confidence !== null && <span className="text-muted-foreground"> · {t('match {{pct}}%', { pct: Math.round(home.confidence * 100) })}</span>}
            </p>
          )}
          {coords && (
            <p className="font-mono tabular-nums">
              {coords}
              {approximate && <span className="font-sans text-muted-foreground"> ({t('approximate')})</span>}
            </p>
          )}
          {dirty && <p className="text-muted-foreground">{t('Not saved yet.')}</p>}
        </div>
      )}

      {editable && (home.lat !== null || home.address) && (
        <Button type="button" variant="ghost" size="sm" onClick={onClear}>
          <Trash2Icon /> {t('Clear home location')}
        </Button>
      )}
    </div>
  );
}

/** Where routing would pick the passenger up, straight from the server (null without routing consent; detail view only). */
function PickupSummary({ passenger }: { passenger: PassengerDto }) {
  const { t } = useTranslation();
  const pk = passenger.pickup;
  return (
    <div className="flex items-start gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-xs">
      <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      {pk ? (
        <span>
          {pk.kind === 'STOP' ? t('Routing picks this passenger up at the stop {{name}}.', { name: pk.label ?? '—' }) : t('Routing picks this passenger up at home.')}{' '}
          {isApproximate(passenger.projection) && pk.kind === 'HOME' && t('(Shown approximately for your role.)')}
        </span>
      ) : passenger.routingConsent ? (
        <span>{t('No pickup point yet: add a home location or a pickup stop.')}</span>
      ) : (
        <span>{t('Routing uses no location of this passenger until they consent to transport planning.')}</span>
      )}
    </div>
  );
}

function ContactsEditor({
  idPrefix,
  rows,
  errors,
  editable,
  onChange,
}: {
  idPrefix: string;
  rows: ContactDraft[];
  errors: { index: number; field: 'name' | 'phone'; message: string }[];
  editable: boolean;
  onChange: (rows: ContactDraft[]) => void;
}) {
  const { t } = useTranslation();
  const errorOf = (i: number, f: 'name' | 'phone') => errors.find((e) => e.index === i && e.field === f)?.message;
  const patch = (i: number, v: Partial<ContactDraft>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...v } : r)));
  return (
    <div className="space-y-3">
      {rows.length === 0 && <p className="text-sm text-muted-foreground">{t('No emergency contacts yet.')}</p>}
      {rows.map((r, i) => (
        <fieldset key={i} disabled={!editable} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
          <legend className="sr-only">{t('Contact {{n}}', { n: i + 1 })}</legend>
          <Field label={t('Name')} htmlFor={`${idPrefix}-c${i}-name`} error={errorOf(i, 'name') && t(errorOf(i, 'name')!)} required>
            <Input id={`${idPrefix}-c${i}-name`} value={r.name} onChange={(e) => patch(i, { name: e.target.value })} autoComplete="off" />
          </Field>
          <Field label={t('Phone')} htmlFor={`${idPrefix}-c${i}-phone`} error={errorOf(i, 'phone') && t(errorOf(i, 'phone')!)} required>
            <Input id={`${idPrefix}-c${i}-phone`} type="tel" value={r.phone} onChange={(e) => patch(i, { phone: e.target.value })} autoComplete="off" />
          </Field>
          <Field label={t('Relation')} htmlFor={`${idPrefix}-c${i}-rel`}>
            <Input id={`${idPrefix}-c${i}-rel`} value={r.relation} onChange={(e) => patch(i, { relation: e.target.value })} autoComplete="off" />
          </Field>
          {editable && (
            <Button type="button" variant="ghost" size="icon" aria-label={t('Remove contact {{n}}', { n: i + 1 })} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
              <Trash2Icon />
            </Button>
          )}
        </fieldset>
      ))}
      {editable && rows.length < MAX_EMERGENCY_CONTACTS && (
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...rows, { name: '', phone: '', relation: '' }])}>
          <PlusIcon /> {t('Add contact')}
        </Button>
      )}
      <p className="text-xs text-muted-foreground">{t('Up to 3 contacts. Phone numbers without a country code get the company’s code.')}</p>
    </div>
  );
}

function PassengerAccess({ passenger, canEdit }: { passenger: PassengerDto; canEdit: boolean }) {
  const access = useAppAccess(passenger.id);
  const reset = usePassengerLoginReset(passenger.id);
  const outcome = access.data?.outcome ?? null;
  const current = useMemo(
    () => (passenger.appAccess ? { active: passenger.appAccess.active, email: passenger.appAccess.email, mobile: passenger.appAccess.mobile, lastLoginAt: passenger.appAccess.lastLoginAt, otherRoles: passenger.appAccess.otherRoles } : null),
    [passenger.appAccess],
  );
  return (
    <AppLoginPanel
      who="passenger"
      current={current}
      defaults={{ email: passenger.email, mobile: passenger.mobile }}
      canEdit={canEdit}
      disabledReason={passenger.isActive ? null : 'Reactivate the passenger first.'}
      pending={access.isPending}
      error={access.error ?? reset.error}
      outcome={outcome}
      onGrant={(input) => access.mutate({ kind: 'grant', input })}
      onRevoke={(mode) => access.mutate({ kind: 'revoke', mode })}
      onReset={() => reset.mutate()}
      reset={reset.data ?? null}
      resetPending={reset.isPending}
    />
  );
}
