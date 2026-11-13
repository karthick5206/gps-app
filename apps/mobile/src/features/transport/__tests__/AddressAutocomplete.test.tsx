import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ApiError } from '@/lib/api';
import { AddressAutocomplete } from '../passenger/AddressAutocomplete';

// R1151 (owner request): address suggestions as you type, one reusable field (ride request, home location, places).
describe('AddressAutocomplete', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const type = async (text: string) => {
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('address-search'), text);
    });
  };
  const wait = async (ms: number) => {
    await act(async () => {
      jest.advanceTimersByTime(ms);
    });
    await act(async () => {});
  };

  it('suggests 350 ms after typing stops (min 3 characters), lists under the field, tap picks; no Search button', async () => {
    const search = jest.fn(async (q: string) => [
      { label: `${q} Metro Stop, Synthetic City`, lat: 13.01, lng: 80.21 },
      { label: `${q} Bus Depot, Synthetic City`, lat: 13.02, lng: 80.22 },
    ]);
    const onPick = jest.fn();
    await render(<AddressAutocomplete search={search} onPick={onPick} />);
    expect(screen.queryByText('Search')).toBeNull();
    await type('Gu');
    expect(screen.getByText('Type at least 3 characters to see suggestions.')).toBeTruthy();
    await type('Gui');
    await wait(200);
    await type('Guindy');
    await wait(349);
    expect(search).not.toHaveBeenCalled();
    expect(screen.getByText('Searching…')).toBeTruthy();
    await wait(1);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0][0]).toBe('Guindy');
    expect(screen.getByText('Guindy Metro Stop, Synthetic City')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('address-search-suggestion-1'));
    });
    expect(onPick).toHaveBeenCalledWith({ label: 'Guindy Bus Depot, Synthetic City', lat: 13.02, lng: 80.22 });
    expect(screen.queryByText('Guindy Metro Stop, Synthetic City')).toBeNull();
    expect(screen.getByTestId('address-search').props.value).toBe('Guindy Bus Depot, Synthetic City');
  });

  it('cancels the previous request when typing goes on', async () => {
    const signals: AbortSignal[] = [];
    const search = jest.fn((_q: string, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<{ label: string; lat: number; lng: number }[]>(() => {});
    });
    await render(<AddressAutocomplete search={search} onPick={jest.fn()} />);
    await type('Tidel');
    await wait(350);
    await type('Tidel Park');
    expect(signals[0].aborted).toBe(true);
  });

  it('shows no results, and rate limited on a 429', async () => {
    const search = jest.fn(async () => [] as { label: string; lat: number; lng: number }[]);
    await render(<AddressAutocomplete search={search} onPick={jest.fn()} />);
    await type('Nowhere');
    await wait(350);
    expect(screen.getByText('No places found')).toBeTruthy();
    search.mockRejectedValueOnce(new ApiError(429, ['Too Many Requests']));
    await type('Nowhere else');
    await wait(350);
    expect(screen.getByText('Too many requests. Wait a moment and try again.')).toBeTruthy();
  });
});
