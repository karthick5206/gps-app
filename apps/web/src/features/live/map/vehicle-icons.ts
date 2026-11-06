import { MOVEMENT_STATUSES, STATUS_META, type LiveObject, type MovementStatus } from '@veetracer/shared';
import type { ResolvedTheme } from '@/features/theme/theme-store';

/**
 * Top-down marker icons per vehicle type, drawn on a canvas on demand and coloured by movement status.
 * Vehicle icons point north (heading 0) and are rotated by the map layer; people/assets/pets are round badges.
 * Image id: `veh:<KIND>:<STATUS>:<theme>`, so status and theme changes just switch images.
 */

export const ICON_KINDS = ['CAR', 'BIKE', 'TRUCK', 'BUS', 'SCHOOL_BUS', 'VAN', 'AUTO', 'OTHER', 'PERSON', 'RUNNER', 'ASSET', 'PET'] as const;
export type IconKind = (typeof ICON_KINDS)[number];

const ROTATING: ReadonlySet<IconKind> = new Set(['CAR', 'BIKE', 'TRUCK', 'BUS', 'SCHOOL_BUS', 'VAN', 'AUTO', 'OTHER']);

const PREFIX = 'veh:';
/** Canvas size in device pixels; registered with pixelRatio 2 → 32 CSS px before `icon-size` scaling. */
const SIZE = 64;

/** A person moving faster than this (km/h) is drawn running instead of walking. */
export const PERSON_RUN_KPH = 10;

export function iconKind(o: Pick<LiveObject, 'type' | 'vehicleType'> & { speedKph?: number }): IconKind {
  if (o.type === 'PERSON' && (o.speedKph ?? 0) > PERSON_RUN_KPH) return 'RUNNER';
  if (o.type === 'PERSON' || o.type === 'ASSET' || o.type === 'PET') return o.type;
  return (o.vehicleType as IconKind | null) ?? 'OTHER';
}

export const rotates = (kind: IconKind) => ROTATING.has(kind);

export function iconId(kind: IconKind, status: MovementStatus, theme: ResolvedTheme): string {
  return `${PREFIX}${kind}:${status}:${theme}`;
}

/** Parses an image id requested by the map; null if it isn't one of ours. */
export function parseIconId(id: string): { kind: IconKind; status: MovementStatus; theme: ResolvedTheme } | null {
  if (!id.startsWith(PREFIX)) return null;
  const [kind, status, theme] = id.slice(PREFIX.length).split(':');
  if (!(ICON_KINDS as readonly string[]).includes(kind) || !(MOVEMENT_STATUSES as readonly string[]).includes(status) || (theme !== 'light' && theme !== 'dark')) return null;
  return { kind: kind as IconKind, status: status as MovementStatus, theme };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** Draws the silhouette path(s) for a kind centred in the canvas, nose up. Returns glass shapes to draw on top. */
function body(ctx: CanvasRenderingContext2D, kind: IconKind): (() => void)[] {
  const c = SIZE / 2;
  const glass: (() => void)[] = [];
  switch (kind) {
    case 'CAR':
      roundRect(ctx, c - 11, c - 24, 22, 48, 9);
      glass.push(() => roundRect(ctx, c - 8.5, c - 13, 17, 9, 3)); // windscreen
      glass.push(() => roundRect(ctx, c - 8, c + 9, 16, 6, 2.5)); // rear window
      break;
    case 'VAN':
      roundRect(ctx, c - 12, c - 25, 24, 50, 6);
      glass.push(() => roundRect(ctx, c - 9.5, c - 17, 19, 8, 2.5));
      break;
    case 'TRUCK':
      roundRect(ctx, c - 11, c - 27, 22, 14, 5); // cab
      glass.push(() => roundRect(ctx, c - 8, c - 23, 16, 6, 2));
      ctx.roundRect(c - 13, c - 11, 26, 38, 2.5); // cargo body (same path, filled together)
      break;
    case 'BUS':
    case 'SCHOOL_BUS':
      roundRect(ctx, c - 12, c - 28, 24, 56, 5);
      glass.push(() => roundRect(ctx, c - 9.5, c - 25, 19, 6, 2)); // windscreen
      glass.push(() => roundRect(ctx, c - 9.5, c - 16, 3, 36, 1.5)); // side windows
      glass.push(() => roundRect(ctx, c + 6.5, c - 16, 3, 36, 1.5));
      break;
    case 'AUTO':
      ctx.beginPath(); // auto-rickshaw: narrow nose, wider cabin
      ctx.moveTo(c - 5, c - 20);
      ctx.quadraticCurveTo(c, c - 26, c + 5, c - 20);
      ctx.lineTo(c + 12, c - 4);
      ctx.lineTo(c + 12, c + 18);
      ctx.quadraticCurveTo(c + 12, c + 21, c + 9, c + 21);
      ctx.lineTo(c - 9, c + 21);
      ctx.quadraticCurveTo(c - 12, c + 21, c - 12, c + 18);
      ctx.lineTo(c - 12, c - 4);
      ctx.closePath();
      glass.push(() => roundRect(ctx, c - 8, c - 6, 16, 7, 2.5));
      break;
    case 'BIKE':
      roundRect(ctx, c - 4.5, c - 25, 9, 50, 4.5); // wheels + frame
      ctx.roundRect(c - 10, c - 13, 20, 4, 2); // handlebar
      ctx.moveTo(c + 7, c + 2);
      ctx.ellipse(c, c + 2, 7, 8, 0, 0, Math.PI * 2); // rider
      break;
    case 'OTHER':
      ctx.beginPath(); // rounded heading pointer
      ctx.moveTo(c, c - 24);
      ctx.lineTo(c + 15, c + 18);
      ctx.quadraticCurveTo(c, c + 9, c - 15, c + 18);
      ctx.closePath();
      break;
    case 'PERSON':
      ctx.beginPath();
      ctx.arc(c, c, 18, 0, Math.PI * 2);
      break;
    case 'ASSET':
      roundRect(ctx, c - 17, c - 17, 34, 34, 7);
      break;
    case 'PET':
      ctx.beginPath();
      ctx.arc(c, c, 18, 0, Math.PI * 2);
      break;
  }
  return glass;
}

/** Glyph inside the round badges (white). */
function badgeGlyph(ctx: CanvasRenderingContext2D, kind: IconKind) {
  const c = SIZE / 2;
  ctx.fillStyle = '#fff';
  if (kind === 'PERSON') {
    ctx.beginPath();
    ctx.arc(c, c - 6, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(c, c + 9, 9.5, 7, 0, Math.PI, 0);
    ctx.fill();
  } else if (kind === 'PET') {
    ctx.beginPath();
    ctx.ellipse(c, c + 5, 7, 6, 0, 0, Math.PI * 2);
    for (const [dx, dy] of [[-8, -5], [-3, -10], [3, -10], [8, -5]]) {
      ctx.moveTo(c + dx + 2.8, c + dy);
      ctx.ellipse(c + dx, c + dy, 2.8, 3.4, 0, 0, Math.PI * 2);
    }
    ctx.fill();
  } else if (kind === 'ASSET') {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.strokeRect(c - 8, c - 8, 16, 16);
  }
}

/**
 * A full-body person figure (64 px canvas, drawn @2x): standing, or one of two walking steps. Same geometry as the
 * mobile map's person PNGs (apps/mobile/scripts/gen-person-icons.mjs) — keep them in step.
 */
export type PersonPose = 'stand' | 'walkA' | 'walkB' | 'runA' | 'runB';
type Seg = [number, number, number, number, number]; // x1, y1, x2, y2, width
export const PERSON_POSES: Record<PersonPose, { head: [number, number]; segs: Seg[] }> = {
  stand: { head: [32, 10], segs: [[32, 19, 32, 38, 10], [32, 22, 25, 37, 5], [32, 22, 39, 37, 5], [32, 37, 28, 58, 6.5], [32, 37, 36, 58, 6.5]] },
  walkA: { head: [33, 10], segs: [[32.5, 19, 31.5, 38, 10], [32, 22, 24, 33, 5], [32, 22, 40, 35, 5], [31.5, 37, 23, 57, 6.5], [31.5, 37, 41, 57, 6.5]] },
  walkB: { head: [33, 10], segs: [[32.5, 19, 31.5, 38, 10], [32, 22, 27, 36, 5], [32, 22, 37, 36, 5], [31.5, 37, 29, 58, 6.5], [31.5, 37, 35, 58, 6.5]] },
  // Running: leaning forward, bent arms and knees, long stride (A: legs apart, B: legs passing).
  runA: {
    head: [37, 11],
    segs: [[34.5, 20, 30, 37, 10], [33.5, 23, 26, 28, 5], [26, 28, 23, 35, 4.5], [33.5, 23, 40, 30, 5], [40, 30, 46, 24, 4.5], [30, 36, 23, 45, 6.5], [23, 45, 15, 43, 6], [30, 36, 40, 44, 6.5], [40, 44, 41, 56, 6]],
  },
  runB: {
    head: [36, 10],
    segs: [[33.5, 19, 30.5, 37, 10], [33, 22, 29, 30, 5], [29, 30, 33, 35, 4.5], [33, 22, 37, 29, 5], [37, 29, 42, 26, 4.5], [30.5, 36, 34, 46, 6.5], [34, 46, 30, 57, 6], [30.5, 36, 27, 46, 6.5], [27, 46, 21, 51, 6]],
  },
};
/** Moving people walk; everyone else stands. */
export const personPose = (status: MovementStatus, running = false): PersonPose => (status === 'RUNNING' || status === 'OVERSPEED' ? (running ? 'runA' : 'walkA') : 'stand');

export function createPersonFigure(status: MovementStatus, theme: ResolvedTheme, outline: string, pose: PersonPose = personPose(status)): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D unavailable');
  const color = STATUS_META[status][theme];
  const f = PERSON_POSES[pose];
  ctx.lineCap = 'round';
  // Ground shadow under the feet.
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath();
  ctx.ellipse(32, 60, 11, 2.6, 0, 0, Math.PI * 2);
  ctx.fill();
  const draw = (extra: number, style: string) => {
    ctx.strokeStyle = style;
    ctx.fillStyle = style;
    for (const [x1, y1, x2, y2, w] of f.segs) {
      ctx.lineWidth = w + extra;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(f.head[0], f.head[1], 6.5 + extra / 2, 0, Math.PI * 2);
    ctx.fill();
  };
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.3)';
  ctx.shadowBlur = 3;
  draw(4, outline); // outline so the figure reads on any basemap
  ctx.restore();
  draw(0, color);
  return ctx.getImageData(0, 0, SIZE, SIZE);
}

export function createVehicleIcon(kind: IconKind, status: MovementStatus, theme: ResolvedTheme, outline: string): ImageData {
  if (kind === 'PERSON' || kind === 'RUNNER') return createPersonFigure(status, theme, outline, personPose(status, kind === 'RUNNER'));
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D unavailable');
  const color = STATUS_META[status][theme];
  ctx.lineJoin = 'round';

  // Soft shadow + outline so icons stay readable on any basemap.
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 1;
  const glass = body(ctx, kind);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
  body(ctx, kind);
  ctx.strokeStyle = outline;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fill();

  if (kind === 'SCHOOL_BUS') {
    // Yellow roof band marks a school bus whatever its status colour.
    ctx.fillStyle = '#facc15';
    ctx.fillRect(SIZE / 2 - 4.5, SIZE / 2 - 18, 9, 40);
  }
  ctx.fillStyle = theme === 'dark' ? 'rgba(15,23,42,0.75)' : 'rgba(15,23,42,0.6)';
  for (const g of glass) {
    g();
    ctx.fill();
  }
  if (!rotates(kind)) badgeGlyph(ctx, kind);
  return ctx.getImageData(0, 0, SIZE, SIZE);
}
