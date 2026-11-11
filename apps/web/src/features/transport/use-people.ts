import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AuditLogDto,
  ConsentNoticeDto,
  ConsentNoticesDto,
  CreatePassengerInput,
  DriverLoginDto,
  DriverLoginInput,
  GeocodeCandidate,
  LoginRemovalMode,
  Paginated,
  PassengerAppAccessInput,
  PassengerAppAccessResult,
  PassengerConsentsDto,
  PassengerDto,
  PassengerImportResult,
  PublishConsentNoticeInput,
  RecordConsentInput,
  TransportVehicleListQuery,
  TransportVehicleProfileDto,
  TransportVehicleProfileInput,
  TransportVehicleRowDto,
  UpdatePassengerInput,
} from '@veetracer/shared';
import { api } from '@/lib/api';

export const PASSENGERS_ENDPOINT = '/transport/passengers';
export const TRANSPORT_VEHICLES_ENDPOINT = '/transport/vehicles';
export const VEHICLE_SEATS_PATH = '/transport/vehicles';
export const CONSENT_NOTICES_ENDPOINT = '/transport/consent-notices';

// ───────────────────────────── Consent notices ─────────────────────────────

/** The company's notices: current / scheduled per purpose and every version. */
export function useConsentNotices(enabled = true) {
  return useQuery({
    queryKey: ['transport-consent-notices'],
    queryFn: ({ signal }) => api.get<ConsentNoticesDto>(CONSENT_NOTICES_ENDPOINT, undefined, signal),
    enabled,
  });
}

/** Publish the next version of a purpose's notice (immutable; the old version stays on record). */
export function usePublishNotice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PublishConsentNoticeInput) => api.post<ConsentNoticeDto>(CONSENT_NOTICES_ENDPOINT, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transport-consent-notices'] }),
  });
}

/** Audit history of a passenger, redacted by the server per view level (audited as a read). */
export function usePassengerHistory(id: string | null | undefined) {
  return useQuery({
    queryKey: ['transport-passenger-history', id],
    queryFn: ({ signal }) => api.get<AuditLogDto[]>(`${PASSENGERS_ENDPOINT}/${id}/history`, undefined, signal),
    enabled: !!id,
  });
}

/** Every cache that shows passengers: the MasterPage list (and its options) and the detail / consent queries. */
export function useInvalidatePassengers() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['master', PASSENGERS_ENDPOINT] });
    qc.invalidateQueries({ queryKey: ['transport-passenger'] });
    qc.invalidateQueries({ queryKey: ['transport-passenger-consents'] });
    qc.invalidateQueries({ queryKey: ['transport-passenger-history'] });
  };
}

/** Detail (contacts in clear for FULL / STANDARD): the server audits it as a sensitive read. */
export function usePassenger(id: string | null | undefined) {
  return useQuery({
    queryKey: ['transport-passenger', id],
    queryFn: ({ signal }) => api.get<PassengerDto>(`${PASSENGERS_ENDPOINT}/${id}`, undefined, signal),
    enabled: !!id,
  });
}

export function useSavePassenger(id: string | null) {
  const invalidate = useInvalidatePassengers();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreatePassengerInput | UpdatePassengerInput) =>
      id ? api.patch<PassengerDto>(`${PASSENGERS_ENDPOINT}/${id}`, body) : api.post<PassengerDto>(PASSENGERS_ENDPOINT, body),
    onSuccess: (row) => {
      qc.setQueryData(['transport-passenger', row.id], row);
      invalidate();
    },
  });
}

/** DELETE = archive (isActive false, login disabled); PATCH isActive true restores. */
export function useArchivePassenger() {
  const invalidate = useInvalidatePassengers();
  return useMutation({
    mutationFn: ({ id, restore }: { id: string; restore?: boolean }) =>
      restore ? api.patch<PassengerDto>(`${PASSENGERS_ENDPOINT}/${id}`, { isActive: true }) : api.delete<PassengerDto>(`${PASSENGERS_ENDPOINT}/${id}`),
    onSuccess: invalidate,
  });
}

/** Photon candidates through the API (self-hosted only; [] when no geocoder is configured). */
export function useGeocode(q: string, enabled: boolean) {
  return useQuery({
    queryKey: ['transport-passenger-geocode', q],
    queryFn: ({ signal }) => api.get<GeocodeCandidate[]>(`${PASSENGERS_ENDPOINT}/geocode`, { q }, signal),
    enabled: enabled && q.length >= 3,
    staleTime: 60_000,
    retry: false,
  });
}

/** Consent current state + history: corporate admin (FULL) only, audited. */
export function usePassengerConsents(id: string | null | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['transport-passenger-consents', id],
    queryFn: ({ signal }) => api.get<PassengerConsentsDto>(`${PASSENGERS_ENDPOINT}/${id}/consents`, undefined, signal),
    enabled: !!id && enabled,
  });
}

export function useRecordConsent(id: string) {
  const qc = useQueryClient();
  const invalidate = useInvalidatePassengers();
  return useMutation({
    mutationFn: (input: RecordConsentInput) => api.post<PassengerConsentsDto>(`${PASSENGERS_ENDPOINT}/${id}/consents`, input),
    onSuccess: (dto) => {
      qc.setQueryData(['transport-passenger-consents', id], dto);
      invalidate();
    },
  });
}

export function useAppAccess(id: string) {
  const qc = useQueryClient();
  const invalidate = useInvalidatePassengers();
  return useMutation({
    mutationFn: (cmd: { kind: 'grant'; input: PassengerAppAccessInput } | { kind: 'revoke'; mode: LoginRemovalMode }): Promise<{ passenger: PassengerDto; outcome: PassengerAppAccessResult['outcome'] | null; invite: PassengerAppAccessResult['invite'] | null }> =>
      cmd.kind === 'grant'
        ? api.post<PassengerAppAccessResult>(`${PASSENGERS_ENDPOINT}/${id}/app-access`, cmd.input)
        : api.delete<PassengerDto>(`${PASSENGERS_ENDPOINT}/${id}/app-access?mode=${cmd.mode}`).then((passenger) => ({ passenger, outcome: null, invite: null })),
    onSuccess: (res) => {
      qc.setQueryData(['transport-passenger', id], res.passenger);
      invalidate();
    },
  });
}

/** Import preview (dry run) or commit: multipart `file` + `geocode` (+ `rows` on commit). */
export function usePassengerImport() {
  const invalidate = useInvalidatePassengers();
  return useMutation({
    mutationFn: ({ file, commit, geocode, rows }: { file: File; commit: boolean; geocode: boolean; rows?: string }) => {
      const form = new FormData();
      form.append('file', file);
      form.append('geocode', geocode ? 'true' : 'false');
      if (commit && rows) form.append('rows', rows);
      return api.upload<PassengerImportResult>(`${PASSENGERS_ENDPOINT}/import/${commit ? 'commit' : 'preview'}`, form);
    },
    onSuccess: (res) => {
      if (res.committed) invalidate();
    },
  });
}

// ───────────────────────────── Vehicles (seats) ─────────────────────────────

/** Every own vehicle in scope with its seat profile (null = not set), paged and searched on the server. */
export function useTransportVehicles(query: TransportVehicleListQuery, enabled: boolean) {
  return useQuery({
    queryKey: ['transport-vehicles', query],
    queryFn: ({ signal }) => api.get<Paginated<TransportVehicleRowDto>>(TRANSPORT_VEHICLES_ENDPOINT, { ...query }, signal),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useSaveVehicleProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ objectId, input }: { objectId: string; input: TransportVehicleProfileInput }) =>
      api.put<TransportVehicleProfileDto>(`${TRANSPORT_VEHICLES_ENDPOINT}/${objectId}/profile`, input),
    onSuccess: (profile) => {
      // Patch the row in every cached page, then refetch (a "seats not set" filter may now exclude it).
      qc.setQueriesData<Paginated<TransportVehicleRowDto>>({ queryKey: ['transport-vehicles'] }, (old) =>
        old ? { ...old, items: old.items.map((v) => (v.objectId === profile.objectId ? { ...v, profile } : v)) } : old,
      );
      qc.invalidateQueries({ queryKey: ['transport-vehicles'] });
    },
  });
}

// ───────────────────────────── Driver login ─────────────────────────────

export function useDriverLogin(driverId: string | null) {
  return useQuery({
    queryKey: ['driver-login', driverId],
    queryFn: ({ signal }) => api.get<DriverLoginDto>(`/drivers/${driverId}/login`, undefined, signal),
    enabled: !!driverId,
    retry: false,
  });
}

export function useDriverLoginMutation(driverId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (cmd: { kind: 'grant'; input: DriverLoginInput } | { kind: 'revoke'; mode: LoginRemovalMode }) =>
      cmd.kind === 'grant' ? api.post<DriverLoginDto>(`/drivers/${driverId}/login`, cmd.input) : api.delete<DriverLoginDto>(`/drivers/${driverId}/login?mode=${cmd.mode}`),
    onSuccess: (row) => {
      qc.setQueryData(['driver-login', driverId], row);
    },
  });
}
