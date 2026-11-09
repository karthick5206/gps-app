# Deployment scripts

| Folder | What | Status |
|---|---|---|
| `windows/` | Current production (Windows Server, NSSM services): `deploy-release.ps1` full release, `update-web-only.ps1` web only, `deploy-veetracer.ps1` first install, `deploy-veetrax-domain.ps1` adds a domain to Caddy. They ask for the server password. | In use |
| `linux/` | Ubuntu: `install-ubuntu.sh` (packages, database, user, firewall, services), `release.sh` (update + build + migrate + restart; `--web-only`), five systemd units. | Example – test on staging first |
| `docker/` | `Dockerfile` (one image for all server processes + built web), `docker-compose.yml` (db, redis, migrate, api, gateway, processor, notifier, summarizer, proxy), `Caddyfile`, `.dockerignore.example`. | Example – test on staging first |

Full steps: `docs/DEVELOPER_GUIDE.md`, section 9. A copy of these scripts is kept in `C:\Build\Scripts` on the owner's PC.
