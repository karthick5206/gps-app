import { fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { SyncBanner } from '../driver/SyncBanner';
import { useDriverQueue } from '../queue-store';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('../queue-store', () => ({ useDriverQueue: jest.fn() }));

const queue = (q: Partial<{ pending: number; rejected: number; paused: 'AUTH' | 'INACTIVE' | null; syncRequired: boolean; syncing: boolean }>) =>
  (useDriverQueue as jest.Mock).mockReturnValue({ pending: 0, rejected: 0, paused: null, syncRequired: false, syncing: false, events: [], ...q });

describe('SyncBanner (driver shell, doc 09 §5)', () => {
  it('says all synced when nothing waits', async () => {
    queue({});
    await render(<SyncBanner />);
    expect(screen.getByText('All actions synced')).toBeTruthy();
  });

  it('never shows waiting or rejected actions as synced', async () => {
    queue({ pending: 2, rejected: 1, syncing: true });
    await render(<SyncBanner />);
    expect(screen.getByText('2 waiting to sync · 1 rejected')).toBeTruthy();
    expect(screen.queryByText('All actions synced')).toBeNull();
    expect(screen.getByLabelText('Syncing')).toBeTruthy();
  });

  it('D1b: actions received too late (trip closed) are reported, never "All actions synced"', async () => {
    (useDriverQueue as jest.Mock).mockReturnValue({ pending: 0, rejected: 0, late: 2, paused: null, syncRequired: false, syncing: false, events: [] });
    await render(<SyncBanner />);
    expect(screen.getByText('2 not applied: trip closed')).toBeTruthy();
    expect(screen.queryByText('All actions synced')).toBeNull();
  });

  it('shows the sign-in pause and opens the sync list', async () => {
    queue({ pending: 1, paused: 'AUTH' });
    await render(<SyncBanner />);
    expect(screen.getByText('1 waiting to sync · Sign in again to sync')).toBeTruthy();
    fireEvent.press(screen.getByRole('button'));
    expect(router.push).toHaveBeenCalledWith('/duty/sync');
  });
});
