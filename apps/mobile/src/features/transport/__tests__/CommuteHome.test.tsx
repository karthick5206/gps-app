import { render, screen } from '@testing-library/react-native';
import { ApiError } from '@/lib/api';
import * as passengerApi from '../passenger-api';
import { CommuteHome } from '../passenger/CommuteHome';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/features/notifications/push', () => ({ pushStatus: null }));
jest.mock('../passenger-api', () => ({
  ...jest.requireActual('../passenger-api'),
  useMyTrips: jest.fn(),
  useMyConsent: jest.fn(),
  useMyNotices: jest.fn(),
  useMyBookings: jest.fn(),
  useNow: () => Date.parse('2026-11-12T02:00:00Z'),
}));
// WP 5.3 self-service policy (react-query) and the WP 5.4 SOS store (SecureStore) are outside this shell test.
jest.mock('../self-service-api', () => ({ useMyPolicy: () => ({ data: { selfBooking: false, sos: true, deskPhone: null }, error: null, isPending: false, isError: false, isSuccess: true, refetch: jest.fn() }) }));
jest.mock('../sos-store', () => ({ passengerSos: { setContext: jest.fn() } }));
jest.mock('../passenger/SosPanel', () => ({ SosPanel: () => null }));

const q = (data: unknown, extra: object = {}) => ({ data, error: null, isPending: false, isError: false, isSuccess: data !== undefined, isRefetching: false, refetch: jest.fn(), ...extra });

describe('CommuteHome (passenger shell)', () => {
  beforeEach(() => {
    (passengerApi.useMyNotices as jest.Mock).mockReturnValue(q([]));
    (passengerApi.useMyBookings as jest.Mock).mockReturnValue(q([]));
  });

  it('a login without a passenger profile sees only "No passenger profile"', async () => {
    const err = new ApiError(403, ['Not a passenger'], 'NOT_A_PASSENGER');
    (passengerApi.useMyTrips as jest.Mock).mockReturnValue(q(undefined, { error: err, isError: true }));
    (passengerApi.useMyConsent as jest.Mock).mockReturnValue(q(undefined, { error: err, isError: true }));
    await render(<CommuteHome />);
    expect(screen.getByText('No passenger profile')).toBeTruthy();
    expect(screen.queryByText('Next trip')).toBeNull();
  });

  it('asks for consent when the routing consent is not active, and states the privacy rule', async () => {
    (passengerApi.useMyTrips as jest.Mock).mockReturnValue(q([]));
    (passengerApi.useMyConsent as jest.Mock).mockReturnValue(q([{ purpose: 'TRANSPORT_PROFILE', active: false }]));
    await render(<CommuteHome />);
    expect(screen.getByText('Your consent is needed')).toBeTruthy();
    expect(screen.getByText('No trips in the next days')).toBeTruthy();
    expect(screen.getByText('VeeTrax does not track your phone. The vehicle is shown only around your trip.')).toBeTruthy();
  });

  it('no consent card once the consent is active', async () => {
    (passengerApi.useMyTrips as jest.Mock).mockReturnValue(q([]));
    (passengerApi.useMyConsent as jest.Mock).mockReturnValue(q([{ purpose: 'TRANSPORT_PROFILE', active: true }]));
    await render(<CommuteHome />);
    expect(screen.queryByText('Your consent is needed')).toBeNull();
  });

  // WP 3.9: rides the transport desk booked for me (not on a trip yet).
  const booking = {
    id: '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01',
    status: 'PENDING_ASSIGNMENT',
    source: 'ADHOC',
    serviceDate: '2026-11-14',
    direction: 'IN',
    timeZone: 'Asia/Kolkata',
    windowStart: '2026-11-14T04:30:00Z',
    windowEnd: '2026-11-14T05:00:00Z',
    pickupLabel: 'Tech Park Gate 2',
    dropLabel: 'Central Station',
    tripId: null,
    cutoffAt: null,
  };

  it('shows a point-to-point ride the desk booked for me under "Booked for you"', async () => {
    (passengerApi.useMyTrips as jest.Mock).mockReturnValue(q([]));
    (passengerApi.useMyConsent as jest.Mock).mockReturnValue(q([{ purpose: 'TRANSPORT_PROFILE', active: true }]));
    (passengerApi.useMyBookings as jest.Mock).mockReturnValue(q([{ ...booking, journey: 'POINT_TO_POINT', arrangedByDesk: true }]));
    await render(<CommuteHome />);
    expect(screen.getByText('Booked for you')).toBeTruthy();
    expect(screen.getByText('Point-to-point · Tech Park Gate 2 → Central Station')).toBeTruthy();
    expect(screen.getByText('Arranged by the transport desk')).toBeTruthy();
  });

  it('an older server (no arrangedByDesk) or a failed bookings call shows no "Booked for you" and no crash', async () => {
    (passengerApi.useMyTrips as jest.Mock).mockReturnValue(q([]));
    (passengerApi.useMyConsent as jest.Mock).mockReturnValue(q([{ purpose: 'TRANSPORT_PROFILE', active: true }]));
    (passengerApi.useMyBookings as jest.Mock).mockReturnValue(q([booking]));
    await render(<CommuteHome />);
    expect(screen.queryByText('Booked for you')).toBeNull();
    (passengerApi.useMyBookings as jest.Mock).mockReturnValue(q(undefined, { isError: true, error: new Error('404') }));
    await render(<CommuteHome />);
    expect(screen.queryByText('Booked for you')).toBeNull();
    expect(screen.getByText('No trips in the next days')).toBeTruthy();
  });
});
