import { haversineMeters } from '../tracking/geo';

/** Chennai simulation box. */
const BOX = { minLat: 13.0, maxLat: 13.15, minLng: 80.18, maxLng: 80.3 };
const WAYPOINT_REACHED_M = 40;

type Phase = 'DRIVE' | 'IDLE' | 'PARKED';

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const randomPoint = () => ({ lat: rand(BOX.minLat, BOX.maxLat), lng: rand(BOX.minLng, BOX.maxLng) });
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

function bearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Plausible vehicle movement: drive between random waypoints at 20–70 km/h with noise, occasional overspeed bursts
 * (85–100 km/h), idle stops (ignition on, 1–6 min) and parking (ignition off, 5–20 min).
 */
export class VehicleMovement {
  lat: number;
  lng: number;
  course = 0;
  speedKph = 0;
  ignition = true;
  private phase: Phase;
  private phaseUntil: number;
  private waypoint = randomPoint();
  private cruiseKph = rand(20, 70);
  private overspeedUntil = 0;

  constructor(now: number) {
    const start = randomPoint();
    this.lat = start.lat;
    this.lng = start.lng;
    // Start in a random phase part-way through, so a fresh fleet shows mixed statuses immediately.
    const roll = Math.random();
    this.phase = roll < 0.6 ? 'DRIVE' : roll < 0.8 ? 'IDLE' : 'PARKED';
    this.phaseUntil = now + (this.phase === 'IDLE' ? rand(30, 300) : rand(60, 900)) * 1000;
    this.ignition = this.phase !== 'PARKED';
    if (this.phase === 'DRIVE') this.speedKph = this.cruiseKph;
  }

  step(now: number, dtSec: number): void {
    if (this.phase === 'DRIVE') this.drive(now, dtSec);
    else if (now >= this.phaseUntil) this.startDriving();
    else this.jitter();
  }

  private drive(now: number, dtSec: number): void {
    if (now >= this.overspeedUntil && Math.random() < 0.01) this.overspeedUntil = now + rand(30, 90) * 1000;
    if (Math.random() < 0.05) this.cruiseKph = rand(20, 70);
    const target = now < this.overspeedUntil ? rand(85, 100) : this.cruiseKph;
    this.speedKph = Math.max(5, Math.min(110, this.speedKph + Math.sign(target - this.speedKph) * Math.min(Math.abs(target - this.speedKph), 8 * dtSec) + rand(-3, 3)));

    const remaining = haversineMeters(this.lat, this.lng, this.waypoint.lat, this.waypoint.lng);
    const distance = Math.min((this.speedKph / 3.6) * dtSec, remaining);
    this.course = (bearing(this.lat, this.lng, this.waypoint.lat, this.waypoint.lng) + rand(-4, 4) + 360) % 360;
    const dLat = (distance * Math.cos(toRad(this.course))) / 111_320;
    const dLng = (distance * Math.sin(toRad(this.course))) / (111_320 * Math.cos(toRad(this.lat)));
    this.lat = Math.min(BOX.maxLat, Math.max(BOX.minLat, this.lat + dLat));
    this.lng = Math.min(BOX.maxLng, Math.max(BOX.minLng, this.lng + dLng));

    if (remaining - distance < WAYPOINT_REACHED_M) this.arrive(now);
  }

  private arrive(now: number): void {
    const roll = Math.random();
    if (roll < 0.5) {
      this.waypoint = randomPoint();
      return;
    }
    this.phase = roll < 0.75 ? 'IDLE' : 'PARKED';
    this.phaseUntil = now + (this.phase === 'IDLE' ? rand(60, 360) : rand(300, 1200)) * 1000;
    this.ignition = this.phase === 'IDLE';
    this.speedKph = 0;
    this.overspeedUntil = 0;
  }

  private startDriving(): void {
    this.phase = 'DRIVE';
    this.ignition = true;
    this.waypoint = randomPoint();
    this.cruiseKph = rand(20, 70);
    this.speedKph = 10;
  }

  /** A few metres of GPS noise while stationary. */
  private jitter(): void {
    this.speedKph = 0;
    this.lat += rand(-2, 2) / 111_320;
    this.lng += rand(-2, 2) / 111_320;
  }
}
