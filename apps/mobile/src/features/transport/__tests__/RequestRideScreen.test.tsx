import { fireEvent, render, screen } from '@testing-library/react-native';
import { ApiError } from '@/lib/api';
import * as selfApi from '../self-service-api';
import { zonedIso } from '../adhoc-request';
import { RequestRideScreen } from '../passenger/RequestRideScreen';

jest.mock('expo-router', () => ({ router: { push: jest.fn(), replace: jest.fn() } }));
const mutate = jest.fn();
jest.mock('../self-service-api', () => ({
  ...jest.requireActual('../self-service-api'),
  useMyPolicy: jest.fn(),
  useMyPlaces: () => ({ data: [], isPending: false, isError: false, isSuccess: true }),
  useRequestPlaces: () => ({ data: [{ id: 'poi-1', name: 'Tech Park Gate 2', category: 'OFFICE' }], isPending: false, isError: false, isSuccess: true, refetch: jest.fn() }),
  searchAddress: jest.fn(async () => []),
  useAttemptKey: () => ['key-1', jest.fn()],
  useRequestRide: jest.fn(),
}));

// Synthetic shift and company data only.
const policy = (over: object = {}) => ({
  data: {
    selfBooking: true,
    adhocRequests: true,
    approvalRequired: true,
    cutoffMin: 60,
    maxDaysAhead: 14,
    shifts: [{ id: 's1', name: 'General', siteName: 'Plant 1', startMin: 540, endMin: 1080, overnight: false, days: [0, 1, 2, 3, 4, 5, 6], timeZone: 'Asia/Kolkata' }],
    stops: [],
    routingConsent: true,
    sos: true,
    deskPhone: null,
    ...over,
  },
  error: null,
  isPending: false,
  isError: false,
  isSuccess: true,
  refetch: jest.fn(),
});
const mutation = (over: object = {}) => ({ mutate, reset: jest.fn(), isPending: false, isError: false, error: null, ...over });

describe('RequestRideScreen (WP 3.9 wave 2, D-A7)', () => {
  beforeEach(() => {
    mutate.mockReset();
    (selfApi.useMyPolicy as jest.Mock).mockReturnValue(policy());
    (selfApi.useRequestRide as jest.Mock).mockReturnValue(mutation());
  });

  it('a server without ride requests (no adhocRequests field) says requests are off', async () => {
    (selfApi.useMyPolicy as jest.Mock).mockReturnValue(policy({ adhocRequests: undefined }));
    await render(<RequestRideScreen />);
    expect(screen.getByText('Ride requests are off')).toBeTruthy();
  });

  it('shows the approval note and both journeys; commute offers the shift site', async () => {
    await render(<RequestRideScreen />);
    expect(screen.getByText('The transport team approves each request before a cab is assigned.')).toBeTruthy();
    expect(screen.getByText('Commute')).toBeTruthy();
    expect(screen.getByText('Point-to-point')).toBeTruthy();
    expect(screen.getAllByText('Shift site').length).toBe(2);
  });

  it('without consent: home / saved / map are disabled with the consent explanation', async () => {
    (selfApi.useMyPolicy as jest.Mock).mockReturnValue(policy({ routingConsent: false }));
    await render(<RequestRideScreen />);
    const homes = screen.getAllByRole('radio', { name: /^Home,/ });
    expect(homes.length).toBe(2);
    for (const h of homes) expect(h.props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getAllByRole('radio', { name: /^Map point,.*transport consent/ }).length).toBe(2);
  });

  it('a point-to-point request without a window is not sent and says why', async () => {
    await render(<RequestRideScreen />);
    await fireEvent.press(screen.getByText('Point-to-point'));
    await fireEvent.press(screen.getByText('Send request'));
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByText('Choose a day.')).toBeTruthy();
  });

  it('a commute with a shift sends home → shift site with the Idempotency key', async () => {
    await render(<RequestRideScreen />);
    await fireEvent.press(screen.getByRole('radio', { name: /^General/ }));
    await fireEvent.press(screen.getAllByText(/^\d{4}-\d{2}-\d{2}$/)[0]);
    await fireEvent.press(screen.getByText('Send request'));
    expect(mutate).toHaveBeenCalledTimes(1);
    const { body, key } = mutate.mock.calls[0][0];
    expect(key).toBe('key-1');
    expect(body).toMatchObject({ journey: 'COMMUTE', direction: 'IN', shiftId: 's1', pickup: { kind: 'HOME' }, destination: { kind: 'SHIFT_SITE' } });
    expect(body.windowStart).toBeUndefined();
  });

  it('server refusals get passenger wording (NOT_ELIGIBLE by reason, BOOKING_OVERLAP)', async () => {
    (selfApi.useRequestRide as jest.Mock).mockReturnValue(mutation({ isError: true, error: new ApiError(422, ['not eligible'], 'NOT_ELIGIBLE', { reason: 'SHIFT_NOT_RUNNING' }) }));
    const { rerender } = await render(<RequestRideScreen />);
    expect(screen.getByText('This shift does not run on the chosen day.')).toBeTruthy();
    (selfApi.useRequestRide as jest.Mock).mockReturnValue(mutation({ isError: true, error: new ApiError(409, ['overlap'], 'BOOKING_OVERLAP') }));
    await rerender(<RequestRideScreen />);
    expect(screen.getByText('You already have a ride at this time. Choose another time or cancel the other ride.')).toBeTruthy();
  });

  it('after a REQUESTED answer: "Waiting for approval" and a way to open the booking', async () => {
    mutate.mockImplementation((_v, o) => o.onSuccess({ id: '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01', status: 'REQUESTED', needsApproval: true }));
    await render(<RequestRideScreen />);
    await fireEvent.press(screen.getByRole('radio', { name: /^General/ }));
    await fireEvent.press(screen.getAllByText(/^\d{4}-\d{2}-\d{2}$/)[0]);
    await fireEvent.press(screen.getByText('Send request'));
    expect(await screen.findByText('Waiting for approval')).toBeTruthy();
    expect(screen.getByText('Open the booking')).toBeTruthy();
  });

  it('after a PENDING_ASSIGNMENT answer (no approval needed): the desk will assign a cab', async () => {
    mutate.mockImplementation((_v, o) => o.onSuccess({ id: '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01', status: 'PENDING_ASSIGNMENT', needsApproval: false }));
    await render(<RequestRideScreen />);
    await fireEvent.press(screen.getByRole('radio', { name: /^General/ }));
    await fireEvent.press(screen.getAllByText(/^\d{4}-\d{2}-\d{2}$/)[0]);
    await fireEvent.press(screen.getByText('Send request'));
    expect(await screen.findByText('Requested — the transport desk will assign a cab')).toBeTruthy();
  });

  it('r115 B8: the time window is read in the company zone (policy.timeZone), not the shift or phone zone', async () => {
    (selfApi.useMyPolicy as jest.Mock).mockReturnValue(policy({ timeZone: 'America/New_York' }));
    await render(<RequestRideScreen />);
    await fireEvent.press(screen.getByRole('radio', { name: /^General/ }));
    const dayChip = screen.getAllByText(/^\d{4}-\d{2}-\d{2}$/)[0];
    await fireEvent.press(dayChip);
    await fireEvent.changeText(screen.getByPlaceholderText('09:30'), '09:30');
    await fireEvent.changeText(screen.getByPlaceholderText('10:00'), '10:00');
    await fireEvent.press(screen.getByText('Send request'));
    expect(mutate).toHaveBeenCalledTimes(1);
    const { body } = mutate.mock.calls[0][0];
    const day = body.serviceDate as string;
    expect(body.windowStart).toBe(zonedIso(day, 570, 'America/New_York'));
    expect(body.windowEnd).toBe(zonedIso(day, 600, 'America/New_York'));
    expect(body.windowStart).not.toBe(zonedIso(day, 570, 'Asia/Kolkata'));
  });
});
