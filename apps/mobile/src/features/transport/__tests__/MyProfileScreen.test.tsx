import { fireEvent, render, screen } from '@testing-library/react-native';
import { ApiError } from '@/lib/api';
import * as selfApi from '../self-service-api';
import { MyProfileScreen } from '../passenger/MyProfileScreen';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
const setHome = jest.fn();
const saveProfile = jest.fn();
jest.mock('../self-service-api', () => ({
  ...jest.requireActual('../self-service-api'),
  useMyProfile: jest.fn(),
  useMyPolicy: () => ({ data: { stops: [{ id: 'stop-1', name: 'Gate 2 stop' }] } }),
  useSaveProfile: jest.fn(),
  useSetHome: jest.fn(),
  searchAddress: jest.fn(async () => []),
}));

// Synthetic person only.
const profile = (over: object = {}) => ({
  displayName: 'Test Passenger',
  employeeCode: 'E-0001',
  branchName: 'North',
  officeName: 'Plant 1',
  defaultStop: null,
  email: 'passenger@example.test',
  mobile: '+91 90000 00000',
  home: { address: 'Sample Street 1', lat: 12.9, lng: 77.6, source: 'PHOTON' },
  emergencyContacts: [],
  accessibility: {},
  routingConsent: true,
  ...over,
});
const q = (data: unknown, extra: object = {}) => ({ data, error: null, isPending: false, isError: false, isSuccess: data !== undefined, refetch: jest.fn(), ...extra });
const mutation = (fn: jest.Mock, over: object = {}) => ({ mutate: fn, isPending: false, isError: false, error: null, ...over });

describe('MyProfileScreen (WP 3.9 wave 2, D-A9)', () => {
  beforeEach(() => {
    setHome.mockReset();
    saveProfile.mockReset();
    (selfApi.useSetHome as jest.Mock).mockReturnValue(mutation(setHome));
    (selfApi.useSaveProfile as jest.Mock).mockReturnValue(mutation(saveProfile));
  });

  it('shows identity read-only, the home address and the edit actions; no coordinates as text', async () => {
    (selfApi.useMyProfile as jest.Mock).mockReturnValue(q(profile()));
    await render(<MyProfileScreen />);
    expect(screen.getByText('Test Passenger')).toBeTruthy();
    expect(screen.getByText('passenger@example.test')).toBeTruthy();
    expect(screen.getByText('Your name, email and mobile are kept by your company. Ask your transport desk to change them.')).toBeTruthy();
    expect(screen.getByText('Sample Street 1')).toBeTruthy();
    expect(screen.getByText('Change home location')).toBeTruthy();
    expect(screen.queryByText(/77\.6/)).toBeNull();
  });

  it('without consent the home editor is disabled with the explanation and a link to consent', async () => {
    (selfApi.useMyProfile as jest.Mock).mockReturnValue(q(profile({ routingConsent: false, home: { address: 'Sample Street 1', lat: null, lng: null, source: null } })));
    await render(<MyProfileScreen />);
    expect(screen.getByText('Your home location is used only with your transport consent. Give it under Privacy & consent first.')).toBeTruthy();
    expect(screen.queryByText('Change home location')).toBeNull();
  });

  it('typed position: sends TYPED, then says how many existing bookings keep their earlier location', async () => {
    (selfApi.useMyProfile as jest.Mock).mockReturnValue(q(profile()));
    setHome.mockImplementation((_body, o) => o.onSuccess({ profile: profile(), openBookingsKept: 2 }));
    await render(<MyProfileScreen />);
    await fireEvent.press(screen.getByText('Change home location'));
    await fireEvent.press(screen.getByText('Type the position'));
    await fireEvent.changeText(screen.getByPlaceholderText('12.9716, 77.5946'), '12.95, 77.61');
    await fireEvent.press(screen.getByText('Save home location'));
    expect(setHome).toHaveBeenCalledWith({ lat: 12.95, lng: 77.61, address: null, source: 'TYPED' }, expect.anything());
    expect(screen.getByText(/2 existing bookings keep their earlier location\./)).toBeTruthy();
  });

  it('a consent refusal from the server (409 CONSENT_REQUIRED) gets the consent wording', async () => {
    (selfApi.useMyProfile as jest.Mock).mockReturnValue(q(profile()));
    (selfApi.useSetHome as jest.Mock).mockReturnValue(mutation(setHome, { isError: true, error: new ApiError(409, ['consent'], 'CONSENT_REQUIRED') }));
    await render(<MyProfileScreen />);
    await fireEvent.press(screen.getByText('Change home location'));
    expect(screen.getByText('Your home location is used only with your transport consent. Give it under Privacy & consent first.')).toBeTruthy();
  });

  it('profile save: default stop, contacts (blank rows dropped) and accessibility in one PATCH', async () => {
    (selfApi.useMyProfile as jest.Mock).mockReturnValue(q(profile({ emergencyContacts: [{ name: 'Contact One', phone: '+91 90000 00001', relation: 'Sister' }] })));
    await render(<MyProfileScreen />);
    await fireEvent.press(screen.getByText('Gate 2 stop'));
    await fireEvent.press(screen.getByText('Save profile'));
    expect(saveProfile).toHaveBeenCalledWith(
      { defaultStopId: 'stop-1', emergencyContacts: [{ name: 'Contact One', phone: '+91 90000 00001', relation: 'Sister' }], accessibility: { wheelchair: false, notes: null } },
      expect.anything(),
    );
  });

  it('an older server without the profile route says it is not available yet', async () => {
    (selfApi.useMyProfile as jest.Mock).mockReturnValue(q(undefined, { isError: true, error: new ApiError(404, ['Cannot GET']) }));
    await render(<MyProfileScreen />);
    expect(screen.getByText('Not available yet')).toBeTruthy();
  });
});
