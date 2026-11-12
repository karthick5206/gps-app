import type { MeTripDto } from '@veetracer/shared';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { TripCard } from '../passenger/TripCard';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

const base = {
  id: '00000000-0000-4000-8000-0000000000aa',
  passengerTripId: '00000000-0000-4000-8000-0000000000bb',
  serviceDate: '2026-11-12',
  direction: 'IN',
  timeZone: 'Asia/Kolkata',
  window: { start: '2026-11-12T02:30:00Z', end: '2026-11-12T04:00:00Z' },
  derivedState: 'PUBLISHED',
  myStatus: 'PENDING',
  vehicle: { name: 'Van 1', plate: null },
  driverFirstName: 'Ravi',
  myStop: { seq: 0, label: 'Stop 1', plannedAt: '2026-11-12T03:00:00Z', status: null, eta: null },
  myDrop: { seq: 3, label: 'Office', plannedAt: '2026-11-12T03:40:00Z' },
  plannedStart: '2026-11-12T03:00:00Z',
  plannedEnd: '2026-11-12T03:40:00Z',
  myPickupPoint: null,
  myDropPoint: null,
  pointsHidden: null,
  coRiders: 2,
  liveVisible: false,
  deskPhone: null,
} as unknown as MeTripDto;

describe('TripCard (passenger shell)', () => {
  it('shows my pickup, the vehicle and the driver first name; opens the trip', async () => {
    await render(<TripCard trip={base} />);
    expect(screen.getByText(/My pickup: .*Stop 1/)).toBeTruthy();
    expect(screen.getByText(/Van 1 · Driver Ravi/)).toBeTruthy();
    fireEvent.press(screen.getByRole('button'));
    expect(router.push).toHaveBeenCalledWith(`/commute/trip/${base.id}`);
  });

  it('without a pickup or vehicle it says "to be confirmed", never a guess', async () => {
    await render(<TripCard trip={{ ...base, myStop: null, vehicle: null, driverFirstName: null }} />);
    expect(screen.getByText('My pickup: Pickup to be confirmed')).toBeTruthy();
    expect(screen.getByText('Vehicle to be confirmed')).toBeTruthy();
    expect(screen.queryByText(/Driver /)).toBeNull();
  });
});
