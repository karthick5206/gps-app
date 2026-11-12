import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ApiError } from '@/lib/api';
import { DutyHome } from '../driver/DutyHome';
import * as driverApi from '../driver-api';
import { queueDriverEvent, useDriverQueue } from '../queue-store';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('../queue-store', () => ({ useDriverQueue: jest.fn(), queueDriverEvent: jest.fn() }));
jest.mock('../driver-api', () => ({
  ...jest.requireActual('../driver-api'),
  useDriverMe: jest.fn(),
  useDriverDuty: jest.fn(),
  useDutyCommand: jest.fn(),
}));

const q = (data: unknown, extra: object = {}) => ({ data, error: null, isPending: false, isRefetching: false, refetch: jest.fn(), ...extra });
const me = { driver: { firstName: 'Ravi' }, documents: { licenseValid: true }, company: { timeZone: 'Asia/Kolkata' }, dispatcherPhone: null };
const trip = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Login 09:00',
  direction: 'IN',
  plannedStart: '2026-11-12T03:00:00Z',
  plannedEnd: '2026-11-12T04:00:00Z',
  stopCount: 4,
  passengerCount: 3,
  vehicle: { name: 'Van 1', plateNumber: null },
  derivedState: 'PUBLISHED',
  plannedTripStatus: 'SCHEDULED',
  acknowledgedAt: null,
  allowedActions: ['acknowledge', 'start'],
};

describe('DutyHome (driver "Today")', () => {
  const mutate = jest.fn();
  beforeEach(() => {
    jest.clearAllMocks();
    (useDriverQueue as jest.Mock).mockReturnValue({ pending: 0, rejected: 0, paused: null, syncRequired: false, syncing: false, events: [] });
    (driverApi.useDutyCommand as jest.Mock).mockReturnValue({ mutate, isPending: false, isError: false, error: null });
  });

  it('a login without a driver profile sees "No driver profile" and no duty button', async () => {
    const err = new ApiError(403, ['This login is not linked to a driver'], 'NOT_A_DRIVER');
    (driverApi.useDriverMe as jest.Mock).mockReturnValue(q(undefined, { error: err }));
    (driverApi.useDriverDuty as jest.Mock).mockReturnValue(q(undefined, { error: err }));
    await render(<DutyHome />);
    expect(screen.getByText('No driver profile')).toBeTruthy();
    expect(screen.queryByText('Start duty')).toBeNull();
  });

  it('off duty: Start duty sends the online duty command', async () => {
    (driverApi.useDriverMe as jest.Mock).mockReturnValue(q(me));
    (driverApi.useDriverDuty as jest.Mock).mockReturnValue(q({ duty: null, trips: [], timeZone: 'Asia/Kolkata' }));
    await render(<DutyHome />);
    expect(screen.getByText('Hello, Ravi')).toBeTruthy();
    expect(screen.getByText('Off duty')).toBeTruthy();
    expect(screen.getByText('No trips today')).toBeTruthy();
    fireEvent.press(screen.getByText('Start duty'));
    expect(mutate).toHaveBeenCalledWith({ kind: 'start' });
  });

  it('today\'s trip: Acknowledge is queued on the phone (offline-capable), not sent directly', async () => {
    (driverApi.useDriverMe as jest.Mock).mockReturnValue(q(me));
    (driverApi.useDriverDuty as jest.Mock).mockReturnValue(q({ duty: null, trips: [trip], timeZone: 'Asia/Kolkata' }));
    await render(<DutyHome />);
    expect(screen.getByText('Login 09:00')).toBeTruthy();
    fireEvent.press(screen.getByText('Acknowledge trip'));
    await waitFor(() => expect(queueDriverEvent).toHaveBeenCalledWith({ tripId: trip.id, type: 'ACKNOWLEDGE' }));
  });

  it('a queued (unconfirmed) acknowledge is not shown as "Acknowledged"', async () => {
    (useDriverQueue as jest.Mock).mockReturnValue({ pending: 1, rejected: 0, paused: null, syncRequired: false, syncing: false, events: [{ tripId: trip.id, type: 'ACKNOWLEDGE', state: 'PENDING', code: null }] });
    (driverApi.useDriverMe as jest.Mock).mockReturnValue(q(me));
    (driverApi.useDriverDuty as jest.Mock).mockReturnValue(q({ duty: null, trips: [trip], timeZone: 'Asia/Kolkata' }));
    await render(<DutyHome />);
    expect(screen.queryByText('Acknowledged')).toBeNull();
    expect(screen.getByText('1 waiting to sync')).toBeTruthy();
  });

  it('an expired licence is shown on the home card', async () => {
    (driverApi.useDriverMe as jest.Mock).mockReturnValue(q({ ...me, documents: { licenseValid: false } }));
    (driverApi.useDriverDuty as jest.Mock).mockReturnValue(q({ duty: null, trips: [], timeZone: 'Asia/Kolkata' }));
    await render(<DutyHome />);
    expect(screen.getByText('Your licence has expired. Trips cannot be started.')).toBeTruthy();
  });
});
