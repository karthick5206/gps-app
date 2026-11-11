# Running VeeTrax on the Windows host (PM2)

Files in this folder (reviewed 2026-11-09: **no secrets**; only paths, process names and the tunnel name. Secrets stay in `apps/api/.env`, which is git-ignored):

| File | What it does |
|---|---|
| `ecosystem.config.cjs` | PM2 process list: `wsl-db` (keeps WSL PostgreSQL/Valkey alive), `api`, `gateway`, `processor`, `notifier`, `summarizer` (all from `apps/api/dist`, **`NODE_ENV=production`**), `web` (`vite preview` :4173), `tunnel` (cloudflared, config `%USERPROFILE%\.cloudflared\veetrax.yml`) |
| `watchdog.ps1` | When PM2 has **no processes** → `pm2 resurrect` (restores the **saved** list). When a process is `errored` → `pm2 restart <name>`. Processes stopped on purpose (`stopped`) are left alone. Log: `apps/api/var/logs/watchdog.log` |
| `install-autostart.ps1` | One-time (Administrator): registers the scheduled task **"VeeTrax watchdog"** (at logon + every 5 min) and disables sleep/hibernate |

**Watchdog and autostart: what to know**
- The task is **not installed** on this PC as of 2026-11-09, so nothing restarts VeeTrax automatically.
- Once installed, the watchdog **resurrects the saved PM2 list** after a reboot. It runs whatever is currently in `apps/api/dist` and `apps/web`. A rebuilt `dist` therefore goes live at the next resurrect or restart. **Rebuilding `dist` is effectively a deployment**: only build `dist` from an approved release. Use `apps/api/dist-*` (git-ignored) for side builds and testing.
- Committing these files does not start, restart or deploy anything.

## Release runbook (PM2)

**Before (all required):**
1. An approved release commit/tag. No uncommitted changes on the host.
2. A fresh backup: `ops/backup/veetrax-backup.sh` (DB snapshot + uploads + Valkey + config). `last-status.json` shows `ok: true`; for off-site, the bundle is uploaded.
3. Note the currently running build: `git rev-parse HEAD > apps/api/var/release-previous.txt`.

**Deploy:**
```powershell
cd D:\Vibhav\gps-app
git fetch; git checkout <release-tag>
npm ci
npm run build:shared
npm run build -w @veetracer/api          # -> apps/api/dist
npm run build -w @veetracer/web          # -> apps/web/dist
cd apps/api; npx prisma migrate deploy; cd ../..
pm2 start ops/run/ecosystem.config.cjs --update-env   # first time / env change; otherwise:
pm2 reload api gateway processor notifier summarizer web --update-env
pm2 save
```

**Verify (within 5 minutes):**
- `curl https://<host>/api/health` → 200.
- `pm2 ls`: all online, restart count stable.
- `pm2 logs api --lines 50`: no `Error`. `[env] WARNING` lines are expected while providers are missing.
- Log in on the web app.
- A live vehicle updates within 10 s.
- Run one report.
- Watch for 30 minutes: error rate, `pm2 ls` restarts, stream lag (System Health page).

**Rollback:**
| Situation | Action |
|---|---|
| Code problem, no migration in the release | `git checkout $(cat apps/api/var/release-previous.txt)`, rebuild (steps above, skip migrate), `pm2 reload … --update-env` |
| Release had additive migrations | Same as above; additive schema stays (harmless to the older code) |
| Release had a destructive migration (needs prior approval) | Stop api/processor/notifier/summarizer (`pm2 stop`), restore DB from the pre-release backup with `ops/backup/veetrax-restore.sh` into a new DB, point `DATABASE_URL` to it, start, verify |
| `NODE_ENV=production` causes a startup failure | Read the `assertProductionSafe` message in `pm2 logs api` and fix the env value. Emergency only: remove `env: { NODE_ENV }` from the ecosystem, `pm2 start ops/run/ecosystem.config.cjs --update-env`, record it in the decision log |

## Tunnel
`tunnel` is currently **stopped** at the owner's request (`pm2 stop tunnel`, saved). Start it only on instruction: `pm2 start tunnel && pm2 save`.

With `NODE_ENV=production` the API listens on 127.0.0.1 only (`API_HOST` unset, see `apps/api/.env.example`). The tunnel (`service: http://localhost:4000`), `vite preview` (proxy default `http://127.0.0.1:4000`) and the watchdog / deploy health checks (`http://127.0.0.1:…`) all run on this machine, so they still reach it; cloudflared tries `::1` first and falls back to 127.0.0.1. If a client on the LAN needs the API directly, set `API_HOST=0.0.0.0` in `apps/api/.env`.
