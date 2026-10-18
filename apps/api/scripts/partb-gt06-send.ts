/**
 * Part B test helper: sends a short GT06 drive for one IMEI to a gateway (e.g. to inject late fixes).
 *   npx tsx scripts/partb-gt06-send.ts --imei 868120000000500 --at 2026-10-18T02:10:00Z --count 60 --interval 10 --speed 40 [--port 5023]
 */
import { Socket } from 'node:net';
import { encodeGps22, encodeLogin } from '../src/gateway/gt06/codec';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback === undefined) throw new Error(`--${name} is required`);
  return fallback;
}

async function main(): Promise<void> {
  const imei = arg('imei');
  const start = Date.parse(arg('at'));
  const count = Number(arg('count', '1'));
  const interval = Number(arg('interval', '10'));
  const speed = Number(arg('speed', '40'));
  let lat = Number(arg('lat', '13.06'));
  const lng = Number(arg('lng', '80.21'));
  const socket = new Socket();
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.connect(Number(arg('port', '5023')), arg('host', '127.0.0.1'), resolve);
  });
  let serial = 1;
  socket.write(encodeLogin(imei, serial++));
  await new Promise((r) => setTimeout(r, 500));
  for (let i = 0; i < count; i++) {
    lat += ((speed / 3.6) * interval) / 111_195;
    socket.write(
      encodeGps22(
        {
          fix: { time: new Date(start + i * interval * 1000), gpsInfoLength: 12, satellites: 9, lat, lng, speedKph: speed, course: 0, positioned: true },
          lbs: { mcc: 404, mnc: 45, lac: 1000, cellId: 2000 },
          acc: speed > 0,
        },
        serial++,
      ),
    );
  }
  await new Promise((r) => setTimeout(r, 1000));
  socket.end();
  console.log(`sent ${count} fixes for ${imei} from ${new Date(start).toISOString()}`);
}

void main();
