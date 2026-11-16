import type { PhotoNoteDto } from '@veetracer/shared';
import type { Map as MlMap } from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import { PhotoNoteLayer } from '@/features/live/map/layers/photo-note-layer';
import { useAuth } from '@/features/auth/auth-context';
import { useObjectPhotoNotes, useRecentPhotoNotes } from './api';
import { PhotoNoteLightbox } from './PhotoNoteLightbox';

/**
 * Camera pins of `notes` on a MapLibre map; a click opens the lightbox. The layer lives as long as the map.
 * `fit` frames the pins whenever the list changes (the Photos & notes map view).
 */
export function PhotoNotePins({ map, notes, visible = true, onTop = false, fit = false }: { map: MlMap | null; notes: PhotoNoteDto[] | undefined; visible?: boolean; onTop?: boolean; fit?: boolean }) {
  const layer = useRef<PhotoNoteLayer | null>(null);
  const [ready, setReady] = useState(0);
  const [open, setOpen] = useState<PhotoNoteDto | null>(null);

  useEffect(() => {
    if (!map) return;
    const l = new PhotoNoteLayer(map, { onOpen: setOpen, onTop });
    layer.current = l;
    setReady((n) => n + 1);
    return () => {
      l.destroy();
      layer.current = null;
    };
  }, [map, onTop]);

  useEffect(() => {
    const l = layer.current;
    if (!l) return;
    l.setNotes(notes ?? []);
    if (!fit || !map || !notes?.length) return;
    const b = l.bounds();
    if (!b) return;
    try {
      if (b[0][0] === b[1][0] && b[0][1] === b[1][1]) map.easeTo({ center: b[0], zoom: Math.max(map.getZoom(), 15), duration: 400 });
      else map.fitBounds(b, { padding: 60, maxZoom: 16, duration: 400 });
    } catch {
      /* map removed */
    }
  }, [notes, ready, fit, map]);

  useEffect(() => {
    layer.current?.setVisible(visible);
    if (!visible) setOpen(null);
  }, [visible, ready]);

  return open ? <PhotoNoteLightbox note={open} onClose={() => setOpen(null)} /> : null;
}

/** Live map: notes of the last 24 hours while the "Photo notes" layer is on. */
export function LivePhotoNotePins({ map, enabled }: { map: MlMap | null; enabled: boolean }) {
  const { can } = useAuth();
  const on = enabled && can('photo_notes');
  const recent = useRecentPhotoNotes(on);
  if (!can('photo_notes')) return null;
  return <PhotoNotePins map={map} notes={recent.data?.items} visible={on} />;
}

/** History playback: the replayed object's notes in the chosen period. */
export function HistoryPhotoNotePins({ map, objectId, from, to }: { map: MlMap | null; objectId: string | null; from: Date; to: Date }) {
  const { can } = useAuth();
  const allowed = can('photo_notes');
  const notes = useObjectPhotoNotes(objectId, from, to, allowed);
  if (!allowed) return null;
  return <PhotoNotePins map={map} notes={objectId ? notes.data?.items : []} visible={!!objectId} onTop />;
}
