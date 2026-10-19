// Generates the SOS siren used by the mobile app's 'sos' notification channel and full-screen alarm.
// Two-tone (960 Hz / 770 Hz, 0.3 s each) for 3 s, 16-bit PCM mono 44.1 kHz WAV, phase-continuous
// with short fades at the ends so it loops without clicks. Run: node scripts/brand/gen-sos-sound.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RATE = 44100;
const SECONDS = 3;
const TONES = [960, 770];
const SEGMENT_S = 0.3;
const FADE_S = 0.02;
const PEAK = 0.9; // of full scale: loud but never clipping

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../../apps/mobile/assets/sounds/sos_siren.wav');
const n = RATE * SECONDS;
const samples = new Float64Array(n);
let phase = 0;
for (let i = 0; i < n; i++) {
  const t = i / RATE;
  const f = TONES[Math.floor(t / SEGMENT_S) % TONES.length];
  phase += (2 * Math.PI * f) / RATE;
  // Sine plus a little 3rd harmonic: harsher, more audible on small phone speakers.
  samples[i] = Math.sin(phase) + Math.sin(3 * phase) / 4;
}
let max = 0;
for (const s of samples) max = Math.max(max, Math.abs(s));
const fadeN = Math.round(FADE_S * RATE);
const pcm = Buffer.alloc(n * 2);
for (let i = 0; i < n; i++) {
  const env = Math.min(1, i / fadeN, (n - 1 - i) / fadeN);
  const v = Math.round((samples[i] / max) * PEAK * env * 32767);
  pcm.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
}
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + pcm.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16); // PCM chunk size
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(1, 22); // mono
header.writeUInt32LE(RATE, 24);
header.writeUInt32LE(RATE * 2, 28); // byte rate
header.writeUInt16LE(2, 32); // block align
header.writeUInt16LE(16, 34); // bits per sample
header.write('data', 36);
header.writeUInt32LE(pcm.length, 40);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([header, pcm]));
console.log(`Wrote ${out} (${header.length + pcm.length} bytes)`);
