import { DISPLAY_SIZES, MAP_ICON_SCALE, TEXT_SCALE, type DisplaySize } from '@veetracer/shared';
import { storage } from '@/lib/storage';

/**
 * Readability settings outside React (the map subscribes too): text size scales the whole UI through the root
 * font size (Tailwind sizes are rem); map icon size scales vehicle markers. Saved locally and in the profile.
 */
type Listener = () => void;
const listeners = new Set<Listener>();
const KEYS = { text: 'vt.textSize', icons: 'vt.mapIconSize' } as const;
const read = (key: string): DisplaySize => {
  const v = storage.get(key) as DisplaySize | null;
  return v && DISPLAY_SIZES.includes(v) ? v : 'normal';
};

let textSize = read(KEYS.text);
let mapIconSize = read(KEYS.icons);

function applyText() {
  document.documentElement.style.fontSize = `${TEXT_SCALE[textSize] * 100}%`;
}
applyText();

export const displayStore = {
  getTextSize: () => textSize,
  getMapIconSize: () => mapIconSize,
  /** Multiplier for vehicle icon sizes on maps. */
  iconScale: () => MAP_ICON_SCALE[mapIconSize],
  set(next: { textSize?: DisplaySize; mapIconSize?: DisplaySize }) {
    let changed = false;
    if (next.textSize && next.textSize !== textSize) {
      textSize = next.textSize;
      storage.set(KEYS.text, textSize);
      applyText();
      changed = true;
    }
    if (next.mapIconSize && next.mapIconSize !== mapIconSize) {
      mapIconSize = next.mapIconSize;
      storage.set(KEYS.icons, mapIconSize);
      changed = true;
    }
    if (changed) listeners.forEach((l) => l());
  },
  subscribe(listener: Listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
