import { displayStatus, displayStatusLabel, hasPhotoType, STATUS_META, type LiveObject } from '@veetracer/shared';
import i18n from 'i18next';
import maplibregl, { type Map as MlMap, type MapGeoJSONFeature } from 'maplibre-gl';
import { photoObjectUrl } from '@/features/objects/object-photo';
import { reverseGeocode } from '@/features/history/use-history';
import { formatDateTime, relativeTime } from '@/lib/format';

const addresses = new Map<string, string | null>();

/**
 * Hover card of a person (or pet / asset) with a photo on the live map: the 256 px photo, name, status, speed, last
 * update and the address when the geocoder has one. Built with DOM nodes (text only, never HTML from data).
 */
export class PhotoHoverCard {
  private popup: maplibregl.Popup | null = null;
  private currentId: string | null = null;

  constructor(
    private readonly map: MlMap,
    private readonly get: (objectId: string) => LiveObject | undefined,
  ) {}

  show(f: MapGeoJSONFeature | undefined) {
    const id = f?.properties?.id;
    const o = typeof id === 'string' ? this.get(id) : undefined;
    if (!o || !o.photoVersion || !hasPhotoType(o.type) || o.lat === null || o.lng === null) return this.hide();
    if (this.currentId === o.objectId && this.popup?.isOpen()) {
      this.popup.setLngLat([o.lng, o.lat]);
      return;
    }
    this.currentId = o.objectId;
    const popup = (this.popup ??= new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 20, maxWidth: '240px', className: 'vt-hover-popup' }));
    popup.setLngLat([o.lng, o.lat]).setDOMContent(this.render(o)).addTo(this.map);
  }

  hide() {
    this.currentId = null;
    this.popup?.remove();
  }

  remove() {
    this.hide();
    this.popup = null;
  }

  private render(o: LiveObject): HTMLElement {
    const t = (k: string, v?: Record<string, unknown>) => i18n.t(k, v);
    const root = el('div', 'display:flex;gap:10px;align-items:flex-start;font-size:12px;line-height:1.45;min-width:200px');
    const status = displayStatus(o);
    const img = document.createElement('img');
    img.alt = o.name;
    img.width = 72;
    img.height = 72;
    img.style.cssText = `width:72px;height:72px;border-radius:9999px;object-fit:cover;flex:none;border:3px solid ${STATUS_META[status].light};background:#fff`;
    void photoObjectUrl(o.objectId, o.photoVersion!, 'full').then((url) => {
      if (url) img.src = url;
    });
    root.append(img);
    const text = el('div', 'min-width:0');
    text.append(el('div', 'font-weight:600;font-size:13px;overflow-wrap:anywhere', o.name));
    text.append(el('div', `font-weight:600;color:${STATUS_META[status].light}`, t(displayStatusLabel(o))));
    text.append(el('div', '', `${t('Speed')}: ${Math.round(o.speedKph)} km/h`));
    if (o.fixTime) text.append(el('div', '', `${t('Last update')}: ${relativeTime(o.fixTime)}`), el('div', 'opacity:.7', formatDateTime(o.fixTime)));
    const address = el('div', 'opacity:.8;overflow-wrap:anywhere');
    text.append(address);
    root.append(text);
    const key = `${o.lat!.toFixed(4)},${o.lng!.toFixed(4)}`;
    if (addresses.has(key)) address.textContent = addresses.get(key) ?? '';
    else {
      address.textContent = '…';
      void reverseGeocode(o.lat!, o.lng!)
        .catch(() => null)
        .then((a) => {
          addresses.set(key, a);
          if (addresses.size > 500) addresses.delete(addresses.keys().next().value!);
          address.textContent = a ?? '';
        });
    }
    return root;
  }
}

function el(tag: string, css: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text !== undefined) e.textContent = text;
  return e;
}
