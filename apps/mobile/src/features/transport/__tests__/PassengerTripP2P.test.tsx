import type { MeTripDto } from '@veetracer/shared';
import { render, screen } from '@testing-library/react-native';
import * as passengerApi from '../passenger-api';
import { PassengerTripScreen } from '../passenger/TripScreen';

/** r115 B2: the passenger trip screen heads a point-to-point trip (stored as IN) "Point-to-point". Synthetic data only. */
jest.mock('expo-router', () => ({ router: { push: jest.fn() }, Stack: { Screen: () => null } }));
jest.mock('@/lib/motion', () => ({ useAppActive: () => true }));
jest.mock('../passenger/SosPanel', () => ({ SosPanel: () => null }));
jest.mock('../sos-store', () => ({ passengerSos: { setContext: jest.fn() }, useSosContext: () => ({ deskPhone: null }) }));
jest.mock('../self-service-api', () => ({
  ...jest.requireActual('../self-service-api'),
  useMyPolicy: () => ({ data: { selfBooking: false, sos: true, deskPhone: null } }),
  useConfirmRide: () => ({ mutate: jest.fn(), isPending: false, isError: false, data: null }),
  useAttemptKey: () => ['k', jest.fn()],
}));
jest.mock('../ui', () => ({ ...jest.requireActual('../ui'), TransportMap: () => null, useTransportMapStyle: () => null }));
jest.mock('../passenger-api', () => ({
  ...jest.requireActual('../passenger-api'),
  useMyTrip: jest.fn(),
  useMyVehicle: () => ({ data: undefined, isPending: false, isError: false }),
  useNow: () => Date.parse('2026-11-12T00:00:00Z'),
}));

const base = {
  id: '00000000-0000-4000-8000-0000000000aa',
  passengerTripId: '00000000-0000-4000-8000-0000000000bb',
  serviceDate: '2026-11-12',
  direction: 'IN',
  journey: 'COMMUTE',
  timeZone: 'Asia/Kolkata',
  window: { start: '2026-11-12T02:30:00Z', end: '2026-11-12T04:00:00Z' },
  derivedState: 'PUBLISHED',
  myStatus: 'PENDING',
  vehicle: { name: 'Van 1', plate: null },
  driverFirstName: 'Ravi',
  myStop: { seq: 0, label: 'Passenger pickup', plannedAt: '2026-11-12T03:00:00Z', status: null, eta: null },
  myDrop: { seq: 3, label: 'Passenger drop', plannedAt: '2026-11-12T03:40:00Z' },
  plannedStart: '2026-11-12T03:00:00Z',
  plannedEnd: '2026-11-12T03:40:00Z',
  myPickupPoint: null,
  myDropPoint: null,
  pointsHidden: null,
  coRiders: 0,
  liveVisible: false,
  deskPhone: null,
} as unknown as MeTripDto;

const q = (data: unknown) => ({ data, error: null, isPending: false, isError: false, refetch: jest.fn() });

describe('PassengerTripScreen header (r115 B2)', () => {
  it('a P2P trip is headed "Point-to-point", never "To site (login)"', async () => {
    (passengerApi.useMyTrip as jest.Mock).mockReturnValue(q({ ...base, journey: 'POINT_TO_POINT' }));
    await render(<PassengerTripScreen id={base.id} />);
    expect(screen.getByText('2026-11-12 · Point-to-point')).toBeTruthy();
    expect(screen.queryByText(/To site \(login\)/)).toBeNull();
  });

  it('a commute trip keeps "To site (login)"', async () => {
    (passengerApi.useMyTrip as jest.Mock).mockReturnValue(q(base));
    await render(<PassengerTripScreen id={base.id} />);
    expect(screen.getByText('2026-11-12 · To site (login)')).toBeTruthy();
  });
});
