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
 * The person marker (64 px canvas, drawn @2x): a cartoon figure (dark hair, skin, teal top, navy trousers, dark shoes,
 * dark outline) in a white round badge whose ring carries the movement-status colour. Poses: standing, two walking
 * steps and two running steps; the map swaps the two steps of a moving person to animate it.
 * The figure is described once as drawing operations (`personDrawOps`) that the web canvas and the mobile map's PNG
 * generator (apps/mobile/scripts/gen-person-icons.mjs, SVG) both render, so both apps draw the same marker.
 */
export type PersonPose = 'stand' | 'walkA' | 'walkB' | 'runA' | 'runB';
type Pt = [number, number];
/** A limb: joint points (shoulder → elbow → hand, or hip → knee → ankle). */
type Limb = Pt[];
export interface PersonPoseDef {
  head: Pt;
  /** Neck → hip. */
  torso: [Pt, Pt];
  backArm: Limb;
  frontArm: Limb;
  backLeg: Limb;
  frontLeg: Limb;
  /** Shoe direction from the ankle (dx, dy) for the back and the front foot. */
  shoes: [Pt, Pt];
  /** Frontal (standing) figure: hair cap instead of profile hair. */
  frontal?: boolean;
}

// Side view facing right, figure inside the badge (x 15–49, y 9–53).
export const PERSON_POSES: Record<PersonPose, PersonPoseDef> = {
  stand: {
    head: [32, 15.5],
    torso: [[32, 22], [32, 34]],
    backArm: [[27.6, 23.6], [25.4, 29.8], [25.2, 35.4]],
    frontArm: [[36.4, 23.6], [38.6, 29.8], [38.8, 35.4]],
    backLeg: [[29.8, 34], [29.5, 42.5], [29.5, 50.5]],
    frontLeg: [[34.2, 34], [34.5, 42.5], [34.5, 50.5]],
    shoes: [[-2.4, 0.4], [2.4, 0.4]],
    frontal: true,
  },
  walkA: {
    head: [33.5, 15.5],
    torso: [[32.8, 22], [31.6, 34]],
    backArm: [[32.4, 23.8], [29.2, 29.6], [27.4, 35]],
    frontArm: [[32.4, 23.8], [35.4, 29.4], [38.6, 33.2]],
    backLeg: [[31, 34], [27.8, 42], [24.6, 49.8]],
    frontLeg: [[32.2, 34], [35.6, 41.8], [38.6, 49.6]],
    shoes: [[3, 0.9], [3.4, 0.5]],
  },
  walkB: {
    head: [33.5, 15.5],
    torso: [[32.8, 22], [31.8, 34]],
    backArm: [[32.4, 23.8], [31, 29.8], [30.6, 35.4]],
    frontArm: [[32.4, 23.8], [34, 29.6], [35.2, 35]],
    backLeg: [[31.4, 34], [30.4, 42.2], [31.2, 50.2]],
    frontLeg: [[32.2, 34], [35, 40.8], [32, 46.6]],
    shoes: [[3, 0.6], [2.8, 1.2]],
  },
  // Running: leaning forward, bent arms, long stride (A: legs apart, back foot kicked up; B: knee forward).
  runA: {
    head: [36.6, 15],
    torso: [[34.6, 21.6], [30.8, 33]],
    backArm: [[33.8, 23.6], [28.4, 28.8], [24.6, 25.4]],
    frontArm: [[33.8, 23.6], [38.6, 28.8], [43.6, 25.2]],
    backLeg: [[30.6, 33], [23.8, 38.8], [17.4, 37.4]],
    frontLeg: [[31.4, 33], [38.4, 39.8], [37.8, 49.8]],
    shoes: [[-0.6, 2.8], [3.6, 0.6]],
  },
  runB: {
    head: [36, 15],
    torso: [[34, 21.6], [30.8, 33]],
    backArm: [[33.4, 23.6], [30.4, 30], [33.6, 34]],
    frontArm: [[33.4, 23.6], [37.2, 29.4], [41.6, 27]],
    backLeg: [[30.8, 33], [32.2, 41.8], [30, 50]],
    frontLeg: [[31.4, 33], [38.4, 37], [35.4, 44]],
    shoes: [[3.4, 0.6], [2.6, 1]],
  },
};

/** Fixed palette of the figure (the status colour is the badge ring). */
export const PERSON_COLORS = {
  outline: '#1f2a37',
  hair: '#1f2a37',
  skin: '#f4b886',
  shirt: '#1f9488',
  shirtBack: '#187a70',
  trousers: '#4b587a',
  trousersBack: '#3d4866',
  badge: '#ffffff',
} as const;

/** One drawing operation: an SVG path, stroked (round caps and joins) and/or filled. */
export interface DrawOp {
  d: string;
  stroke?: string;
  width?: number;
  fill?: string;
}

const n2 = (v: number) => +v.toFixed(2);
const polyline = (l: Pt[]) => l.map(([x, y], i) => `${i ? 'L' : 'M'}${n2(x)} ${n2(y)}`).join(' ');
const circle = (cx: number, cy: number, r: number) => `M${n2(cx - r)} ${n2(cy)} a${r} ${r} 0 1 0 ${2 * r} 0 a${r} ${r} 0 1 0 ${-2 * r} 0 Z`;

/** Badge (first op) + figure, back to front. */
export function personDrawOps(pose: PersonPose, ringColor: string): DrawOp[] {
  const f = PERSON_POSES[pose];
  const C = PERSON_COLORS;
  const ops: DrawOp[] = [{ d: circle(32, 32, 28.5), fill: C.badge, stroke: ringColor, width: 4 }];
  const OUT = 2.6; // outline added around every limb
  const limb = (l: Limb, width: number, color: string) => {
    ops.push({ d: polyline(l), stroke: C.outline, width: width + OUT });
    ops.push({ d: polyline(l), stroke: color, width });
  };
  const hand = (l: Limb) => {
    const [x, y] = l[l.length - 1];
    ops.push({ d: circle(x, y, 2.2), fill: C.skin, stroke: C.outline, width: 1.3 });
  };
  const shoe = (l: Limb, [dx, dy]: Pt) => {
    const [x, y] = l[l.length - 1];
    ops.push({ d: polyline([[x, y], [x + dx, y + dy]]), stroke: C.outline, width: 4.6 });
  };
  // Back limbs first (a shade darker), then the torso, the front limbs and the head. A frontal figure shows both arms
  // beside the body, so its "back" arm is drawn after the torso in the normal shirt colour.
  if (!f.frontal) {
    limb(f.backArm, 4.4, C.shirtBack);
    hand(f.backArm);
  }
  limb(f.backLeg, 5.6, f.frontal ? C.trousers : C.trousersBack);
  shoe(f.backLeg, f.shoes[0]);
  limb(f.torso, 9.5, C.shirt);
  if (f.frontal) {
    limb(f.backArm, 4.4, C.shirt);
    hand(f.backArm);
  }
  limb(f.frontLeg, 5.6, C.trousers);
  shoe(f.frontLeg, f.shoes[1]);
  limb(f.frontArm, 4.4, C.shirt);
  hand(f.frontArm);
  const [hx, hy] = f.head;
  const r = 5.6;
  ops.push({ d: circle(hx, hy, r), fill: C.skin, stroke: C.outline, width: 1.4 });
  const p = (x: number, y: number) => `${n2(x)} ${n2(y)}`;
  const hair = f.frontal
    ? // Frontal: hair cap over the top of the head.
      `M${p(hx - r, hy - 0.4)} C${p(hx - r, hy - r * 1.55)} ${p(hx + r, hy - r * 1.55)} ${p(hx + r, hy - 0.4)} C${p(hx + r * 0.5, hy - r * 0.75)} ${p(hx - r * 0.5, hy - r * 0.75)} ${p(hx - r, hy - 0.4)} Z`
    : // Profile facing right: hair over the top and the back of the head, the face open to the right.
      `M${p(hx - r * 1.05, hy + r * 0.35)} C${p(hx - r * 1.25, hy - r * 1.2)} ${p(hx + r * 0.7, hy - r * 1.6)} ${p(hx + r * 0.95, hy - r * 0.35)} C${p(hx + r * 0.3, hy - r * 0.6)} ${p(hx - r * 0.1, hy - r * 0.3)} ${p(hx - r * 0.25, hy + r * 0.25)} C${p(hx - r * 0.5, hy + r * 0.5)} ${p(hx - r * 0.8, hy + r * 0.6)} ${p(hx - r * 1.05, hy + r * 0.35)} Z`;
  ops.push({ d: hair, fill: C.hair, stroke: C.outline, width: 1 });
  return ops;
}

/** Moving people walk; everyone else stands. */
export const personPose = (status: MovementStatus, running = false): PersonPose => (status === 'RUNNING' || status === 'OVERSPEED' ? (running ? 'runA' : 'walkA') : 'stand');

export function createPersonFigure(status: MovementStatus, theme: ResolvedTheme, _outline: string, pose: PersonPose = personPose(status)): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D unavailable');
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  personDrawOps(pose, STATUS_META[status][theme]).forEach((op, i) => {
    const path = new Path2D(op.d);
    if (op.fill) {
      ctx.save();
      // The badge casts a soft shadow so it reads on any basemap.
      if (i === 0) Object.assign(ctx, { shadowColor: 'rgba(0,0,0,0.35)', shadowBlur: 4, shadowOffsetY: 1 });
      ctx.fillStyle = op.fill;
      ctx.fill(path);
      ctx.restore();
    }
    if (op.stroke) {
      ctx.strokeStyle = op.stroke;
      ctx.lineWidth = op.width ?? 1;
      ctx.stroke(path);
    }
  });
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

// ───────────── photo markers (people / pets / assets with a photo) ─────────────

const PHOTO_PREFIX = 'ava:';

/**
 * Image id of a photo marker: `ava:<objectId>:<photoVersion>:<status>:<theme>`. The feature carries `<objectId>:<version>`
 * (property `photo`), the layer expression adds status and theme, so a status change only switches images.
 */
export function photoIconId(photo: string, status: MovementStatus, theme: ResolvedTheme): string {
  return `${PHOTO_PREFIX}${photo}:${status}:${theme}`;
}

export function parsePhotoIconId(id: string): { objectId: string; version: number; status: MovementStatus; theme: ResolvedTheme } | null {
  if (!id.startsWith(PHOTO_PREFIX)) return null;
  const [objectId, v, status, theme] = id.slice(PHOTO_PREFIX.length).split(':');
  const version = Number(v);
  if (!objectId || !Number.isFinite(version) || version <= 0 || !(MOVEMENT_STATUSES as readonly string[]).includes(status) || (theme !== 'light' && theme !== 'dark')) return null;
  return { objectId, version, status: status as MovementStatus, theme };
}

/**
 * The photo marker: the same 64 px badge geometry as the cartoon person (white badge with a soft shadow, status-coloured
 * ring of width 4 at radius 28.5) with the photo clipped to a circle inside the ring. No walking animation.
 */
export function createPhotoMarker(photo: CanvasImageSource, status: MovementStatus, theme: ResolvedTheme): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D unavailable');
  const c = SIZE / 2;
  ctx.save();
  Object.assign(ctx, { shadowColor: 'rgba(0,0,0,0.35)', shadowBlur: 4, shadowOffsetY: 1 });
  ctx.beginPath();
  ctx.arc(c, c, 28.5, 0, Math.PI * 2);
  ctx.fillStyle = PERSON_COLORS.badge;
  ctx.fill();
  ctx.restore();
  // Photo inside the ring (inner edge of the ring at 26.5; 1 px of white between them).
  ctx.save();
  ctx.beginPath();
  ctx.arc(c, c, 25.5, 0, Math.PI * 2);
  ctx.clip();
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(photo, c - 25.5, c - 25.5, 51, 51);
  ctx.restore();
  ctx.beginPath();
  ctx.arc(c, c, 28.5, 0, Math.PI * 2);
  ctx.strokeStyle = STATUS_META[status][theme];
  ctx.lineWidth = 4;
  ctx.stroke();
  return ctx.getImageData(0, 0, SIZE, SIZE);
}
