import { render, screen } from '@testing-library/react-native';
import * as passengerApi from '../passenger-api';
import { BookingsScreen } from '../passenger/BookingsScreen';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('../passenger-api', () => ({
  ...jest.requireActual('../passenger-api'),
  useMyBookings: jest.fn(),
  useCancelBooking: () => ({ mutate: jest.fn(), isPending: false, isError: false, error: null }),
  useNow: () => Date.parse('2026-11-12T02:00:00Z'),
}));
jest.mock('../self-service-api', () => ({ useMyPolicy: () => ({ data: { selfBooking: false } }) }));

const q = (data: unknown, extra: object = {}) => ({ data, error: null, isPending: false, isError: false, isSuccess: data !== undefined, isRefetching: false, refetch: jest.fn(), ...extra });

const B1 = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01';
const B2 = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a02';
const base = {
  status: 'PENDING_ASSIGNMENT',
  source: 'ADHOC',
  serviceDate: '2026-11-14',
  direction: 'IN',
  timeZone: 'Asia/Kolkata',
  windowStart: '2026-11-14T04:30:00Z',
  windowEnd: '2026-11-14T05:00:00Z',
  tripId: null,
  cutoffAt: null,
};
// Synthetic labels only.
const p2p = { ...base, id: B1, journey: 'POINT_TO_POINT', arrangedByDesk: true, pickupLabel: 'Tech Park Gate 2', dropLabel: 'Central Station' };
// An older server: no journey / arrangedByDesk fields at all.
const oldCommute = { ...base, id: B2, direction: 'OUT', serviceDate: '2026-11-13', pickupLabel: 'Office', dropLabel: 'Home' };

describe('BookingsScreen (WP 3.9)', () => {
  it('a point-to-point booking by the desk: "Point-to-point", pickup → destination, "Arranged by the transport desk"', async () => {
    (passengerApi.useMyBookings as jest.Mock).mockReturnValue(q([p2p]));
    await render(<BookingsScreen />);
    expect(screen.getByText('Point-to-point · Tech Park Gate 2 → Central Station')).toBeTruthy();
    expect(screen.getByText('Arranged by the transport desk')).toBeTruthy();
    expect(screen.queryByText(/To site|From site/)).toBeNull();
  });

  it('an older server without the new fields still renders the commute wording, without the desk line', async () => {
    (passengerApi.useMyBookings as jest.Mock).mockReturnValue(q([oldCommute]));
    await render(<BookingsScreen />);
    expect(screen.getByText('From site (logout) · Office → Home')).toBeTruthy();
    expect(screen.queryByText('Arranged by the transport desk')).toBeNull();
    expect(screen.queryByText('Point-to-point', { exact: false })).toBeNull();
  });

  it('never shows a coordinate pair as a place', async () => {
    (passengerApi.useMyBookings as jest.Mock).mockReturnValue(q([{ ...p2p, pickupLabel: '12.9716, 77.5946' }]));
    await render(<BookingsScreen />);
    expect(screen.getByText('Point-to-point · Map point → Central Station')).toBeTruthy();
    expect(screen.queryByText(/77\.59/)).toBeNull();
  });

  it('opened from the notification: the booking is listed first and highlighted', async () => {
    (passengerApi.useMyBookings as jest.Mock).mockReturnValue(q([oldCommute, p2p]));
    await render(<BookingsScreen focusId={B1} />);
    const rows = screen.getAllByText(/ · .* → /);
    expect(rows[0].props.children).toContain('Point-to-point');
    expect(screen.queryByText(/no longer in your list/)).toBeNull();
  });

  it('opened for a booking that is not in the list: says so, shows the rest', async () => {
    (passengerApi.useMyBookings as jest.Mock).mockReturnValue(q([oldCommute]));
    await render(<BookingsScreen focusId={B1} />);
    expect(screen.getByText('This booking is no longer in your list. It may have been cancelled or already taken place.')).toBeTruthy();
    expect(screen.getByText('From site (logout) · Office → Home')).toBeTruthy();
  });
});
