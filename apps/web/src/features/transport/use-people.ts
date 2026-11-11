import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreatePassengerInput,
  DriverLoginDto,
  DriverLoginInput,
  GeocodeCandidate,
  PassengerAppAccessInput,
  PassengerAppAccessResult,
  PassengerConsentsDto,
  PassengerDto,
  PassengerImportResult,
  RecordConsentInput,
  TransportVehicleProfileDto,
  TransportVehicleProfileInput,
  UpdatePassengerInput,
} from '@veetracer/shared';
import { api } from '@/lib/api';

export const PASSENGERS_ENDPOINT = '/transport/passengers';
export const TRANSPORT_VEHICLES_ENDPOINT = '/transport/vehicles';
export const VEHICLE_SEATS_PATH = '/transport/vehicles';

/** Every cache that shows passengers: the MasterPage list (and its options) and the detail / consent queries. */
export function useInvalidatePassengers() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['master', PASSENGERS_ENDPOINT] });
    qc.invalidateQueries({ queryKey: ['transport-passenger'] });
    qc.invalidateQueries({ queryKey: ['transport-passenger-consents'] });
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
    mutationFn: (cmd: { kind: 'grant'; input: PassengerAppAccessInput } | { kind: 'revoke' }): Promise<{ passenger: PassengerDto; outcome: PassengerAppAccessResult['outcome'] | null; invite: PassengerAppAccessResult['invite'] | null }> =>
      cmd.kind === 'grant'
        ? api.post<PassengerAppAccessResult>(`${PASSENGERS_ENDPOINT}/${id}/app-access`, cmd.input)
        : api.delete<PassengerDto>(`${PASSENGERS_ENDPOINT}/${id}/app-access`).then((passenger) => ({ passenger, outcome: null, invite: null })),
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

export function useVehicleProfiles(enabled: boolean) {
  return useQuery({
    queryKey: ['transport-vehicle-profiles'],
    queryFn: ({ signal }) => api.get<TransportVehicleProfileDto[]>(TRANSPORT_VEHICLES_ENDPOINT, undefined, signal),
    enabled,
  });
}

export function useSaveVehicleProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ objectId, input }: { objectId: string; input: TransportVehicleProfileInput }) =>
      api.put<TransportVehicleProfileDto>(`${TRANSPORT_VEHICLES_ENDPOINT}/${objectId}/profile`, input),
    onSuccess: (row) => {
      qc.setQueryData<TransportVehicleProfileDto[]>(['transport-vehicle-profiles'], (old) => {
        if (!old) return old;
        const rest = old.filter((p) => p.objectId !== row.objectId);
        return [...rest, row];
      });
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
    mutationFn: (cmd: { kind: 'grant'; input: DriverLoginInput } | { kind: 'revoke' }) =>
      cmd.kind === 'grant' ? api.post<DriverLoginDto>(`/drivers/${driverId}/login`, cmd.input) : api.delete<DriverLoginDto>(`/drivers/${driverId}/login`),
    onSuccess: (row) => {
      qc.setQueryData(['driver-login', driverId], row);
    },
  });
}
