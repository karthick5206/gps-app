# VeeTrax

GPS tracking SaaS: web dashboard, mobile apps (later milestones), Concox/GT06 device support.
**Status, setup on a new machine and pending work: [docs/HANDOFF.md](docs/HANDOFF.md).**

Product and system design: [docs/VeeTrax_Design_Document_v2.0.pdf](docs/VeeTrax_Design_Document_v2.0.pdf) · current milestone spec: [docs/m1/M1_SPEC.md](docs/m1/M1_SPEC.md)

## Structure
| Path | What |
|---|---|
| `packages/shared` | Types and constants shared by backend and web (menus/permissions, statuses, DTOs) |
| `apps/api` | NestJS API + Socket.IO, GT06 TCP gateway, stream processor, device simulator (Prisma + PostgreSQL, Valkey) |
| `apps/web` | React + Vite + Tailwind CSS web app (live map with MapLibre) |
| `docs/design` | Source of the design document (`python3 docs/design/build.py` regenerates the PDF) |

## Prerequisites
Node 22+, PostgreSQL 16 with a `veetracer` database, Valkey (`brew install valkey && brew services start valkey`).
Copy `apps/api/.env.example` → `apps/api/.env` and `apps/web/.env.example` → `apps/web/.env` (defaults work locally).

```bash
npm install
npm run build:shared
cd apps/api && npm run db:migrate && npm run db:seed && cd ../..
```

## Run
```bash
scripts/dev-start.sh 20     # API :4000, GT06 gateway :5023, processor, web :5173, 20 simulated vehicles
scripts/dev-stop.sh         # stops only what dev-start started
```
Open http://localhost:5173. Logs: `apps/api/var/logs/`. Dev emails (password reset): `apps/api/var/mail/`.

| Account | Password | Role |
|---|---|---|
| admin@veetracer.local | Admin@12345 | Super Admin (use the company switcher) |
| demo.admin@veetracer.local | Demo@12345 | Demo Logistics — Admin |
| chennai.manager@veetracer.local | Demo@12345 | Manager, Chennai branch only |
| viewer@veetracer.local | Demo@12345 | Viewer, 3 vehicles only |

Mobile OTP login works with `+919999900001` (demo admin); in development the code is shown on screen.

## Simulator and load testing
```bash
cd apps/api
npm run sim -- --count 20 --interval 5                 # IMEIs 868120000000001…
npm run sim:register -- --count 2000                   # register more simulated devices ("Load Test" branch)
npm run sim -- --count 2000 --interval 2               # ~1,000 positions/s
```
A real Concox device: point it at this machine's IP, port 5023, and register its IMEI under Masters → Devices.

## Tests
```bash
npm test -w @veetracer/api      # GT06 codec, filters/status machine, permissions
npm test -w @veetracer/web      # map/geo and formatting helpers
npm run build -w @veetracer/web
```
