# Deployment scripts

| Folder | What | Status |
|---|---|---|
| `windows/` | Current production (Windows Server, NSSM services): `deploy-release.ps1` full release, `update-web-only.ps1` web only, `deploy-veetracer.ps1` first install, `deploy-veetrax-domain.ps1` adds a domain to Caddy. They ask for the server password. | In use |
| `linux/` | **Production (app.veetrax.com, Ubuntu 24.04, since 2026-11-10):** `install-ubuntu.sh` (Node 24, PostgreSQL 18 + TimescaleDB, Valkey, Caddy, Java 21, firewall), `release.sh` (`REF=vX.Y.Z` pins a tag; build + migrate + seed + restart; `--web-only`), five systemd units, `Caddyfile`, `maps/` (self-hosted GraphHopper, Photon, Martin tiles; see `maps/README.md`). | In use |
| `docker/` | `Dockerfile` (one image for all server processes + built web), `docker-compose.yml` (db, redis, migrate, api, gateway, processor, notifier, summarizer, proxy), `Caddyfile`, `.dockerignore.example`. | Example – test on staging first |

Full steps: `docs/DEVELOPER_GUIDE.md`, section 9. A copy of these scripts is kept in `C:\Build\Scripts` on the owner's PC.
