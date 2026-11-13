import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as driverApi from '../driver-api';
import { DriverTripScreen } from '../driver/DriverTripScreen';
import { queueDriverEvent, useDriverQueue } from '../queue-store';

/**
 * WP 3.9: a point-to-point trip (stops = pickups then drops, none a company site) renders stop by stop in the driver
 * trip screen with the normal outcome buttons. Synthetic data only.
 */
jest.mock('expo-router', () => ({ router: { push: jest.fn() }, Stack: { Screen: () => null } }));
jest.mock('expo-screen-capture', () => ({ usePreventScreenCapture: jest.fn() }));
jest.mock('@/lib/motion', () => ({ useAppActive: () => true }));
jest.mock('../queue-store', () => ({ useDriverQueue: jest.fn(), queueDriverEvent: jest.fn(() => Promise.resolve()), driverQueue: { ensureSeqAtLeast: jest.fn(() => Promise.resolve()) } }));
jest.mock('../sos-store', () => ({ driverSos: { setContext: jest.fn() } }));
jest.mock('../SosScreen', () => ({ SosEntryButton: () => null }));
jest.mock('../driver/SyncBanner', () => ({ SyncBanner: () => null }));
jest.mock('../nav-setting', () => ({ useNavHandoff: () => true }));
jest.mock('../passenger-api', () => ({ useNow: () => Date.parse('2026-11-14T04:40:00Z') }));
jest.mock('../driver-api', () => ({
  ...jest.requireActual('../driver-api'),
  useDriverTrip: jest.fn(),
  useDriverMe: jest.fn(),
  useStartTrip: jest.fn(),
  useTripMotion: jest.fn(),
}));

const TRIP = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b01';
const stop = (seq: number, label: string, pickups: number, drops: number, status = 'PENDING') => ({
  seq,
  label,
  lat: 12.9 + seq / 100,
  lng: 77.5 + seq / 100,
  pointHidden: null,
  radiusM: 100,
  plannedArrival: `2026-11-14T04:${30 + seq * 5}:00Z`,
  actualArrival: status === 'ARRIVED' ? '2026-11-14T04:34:00Z' : null,
  actualDeparture: null,
  status,
  pickups,
  drops,
  boarded: 0,
  noShow: 0,
  dropped: 0,
  pending: pickups,
});
const passenger = (n: number, pickupSeq: number, dropSeq: number) => ({
  passengerTripId: `0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c0${n}`,
  number: n,
  displayName: `Rider ${n}`,
  pickupSeq,
  dropSeq,
  seats: 1,
  status: 'PENDING',
  accessibility: false,
  contact: null,
  contactPolicy: 'NONE_R1',
  allowedEvents: ['BOARDED', 'NO_SHOW'],
});
const trip = (first = 'PENDING') => ({
  id: TRIP,
  version: 1,
  serviceDate: '2026-11-14',
  direction: 'IN',
  name: 'Ad-hoc 10:00',
  derivedState: 'IN_PROGRESS',
  plannedTripStatus: 'IN_PROGRESS',
  plannedStart: '2026-11-14T04:30:00Z',
  plannedEnd: '2026-11-14T05:30:00Z',
  actualStart: '2026-11-14T04:30:00Z',
  actualEnd: null,
  vehicle: { id: 'v', name: 'Van 1', plateNumber: null },
  stopCount: 4,
  passengerCount: 2,
  acknowledgedAt: '2026-11-14T04:00:00Z',
  allowedActions: ['report'],
  // Neutral labels for personal points (contract DriverStopDto.label): no company site anywhere on the trip.
  stops: [stop(1, 'Passenger pickup', 1, 0, first), stop(2, 'Passenger pickup', 1, 0), stop(3, 'Passenger drop', 0, 1), stop(4, 'Passenger drop', 0, 1)],
  passengers: [passenger(1, 1, 3), passenger(2, 2, 4)],
  manifestHidden: null,
  counts: { passengers: 2, boarded: 0, noShow: 0, dropped: 0, pending: 2 },
  overlays: [],
  lastSeq: null,
  vehicleMotion: null,
  dispatcherPhone: null,
  serverTime: '2026-11-14T04:40:00Z',
});

const q = (data: unknown) => ({ data, error: null, isPending: false, isError: false, refetch: jest.fn() });

describe('DriverTripScreen: point-to-point trip (WP 3.9)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useDriverQueue as jest.Mock).mockReturnValue({ pending: 0, rejected: 0, paused: null, syncRequired: false, syncing: false, events: [] });
    (driverApi.useDriverMe as jest.Mock).mockReturnValue(q({ driver: { firstName: 'Ravi' }, documents: { licenseValid: true }, company: { timeZone: 'Asia/Kolkata' }, dispatcherPhone: null }));
    (driverApi.useStartTrip as jest.Mock).mockReturnValue({ mutate: jest.fn(), isPending: false, isError: false, error: null });
    (driverApi.useTripMotion as jest.Mock).mockReturnValue({ data: null });
  });

  it('lists every pickup and drop stop in order, with navigation to the current one', async () => {
    (driverApi.useDriverTrip as jest.Mock).mockReturnValue(q(trip()));
    await render(<DriverTripScreen id={TRIP} />);
    expect(screen.getByText('1. Passenger pickup')).toBeTruthy();
    expect(screen.getByText('2. Passenger pickup')).toBeTruthy();
    expect(screen.getByText('3. Passenger drop')).toBeTruthy();
    expect(screen.getByText('4. Passenger drop')).toBeTruthy();
    expect(screen.getByText('Navigate')).toBeTruthy();
    fireEvent.press(screen.getByText('Arrived at stop'));
    await waitFor(() => expect(queueDriverEvent).toHaveBeenCalledWith({ tripId: TRIP, type: 'ARRIVED', stopSeq: 1 }));
  });

  it('at the first pickup (arrived) the rider picked up there gets Boarded / No-show; the drop rider is not offered', async () => {
    (driverApi.useDriverTrip as jest.Mock).mockReturnValue(q(trip('ARRIVED')));
    await render(<DriverTripScreen id={TRIP} />);
    expect(screen.getByText('1. Rider 1')).toBeTruthy();
    expect(screen.queryByText('2. Rider 2')).toBeNull();
    fireEvent.press(screen.getByText('Boarded'));
    await waitFor(() => expect(queueDriverEvent).toHaveBeenCalledWith({ tripId: TRIP, type: 'BOARDED', passengerTripId: passenger(1, 1, 3).passengerTripId }));
  });
});
