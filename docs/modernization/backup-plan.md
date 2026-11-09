# Backup & Restore Plan (S0.3 · risk R-03 · decision Q-03)

Status, 2026-11-09:
- **Implemented and restore-tested** on isolated data.
- **Off-site upload is not active**: it awaits your choice of storage provider (paid service, needs approval).

## 1. What is backed up
| Part | How | Why |
|---|---|---|
| PostgreSQL (application DB) | `pg_dump -Fc` inside an **exported snapshot**; row counts of 11 key tables taken in the same snapshot | Complete, consistent database; counts let the restore prove completeness |
| Valkey | `BGSAVE` → copy of `dump.rdb` | Live state, command queues, summarizer cursor (all rebuildable, but faster recovery) |
| Uploaded files | `apps/api/var` as tar.gz, logs excluded | Documents, selfies, driver media, invoices, report files. **Previously not backed up at all** |
| Configuration | `.env` files, PM2 ecosystem (list configurable) | Rebuild the host quickly. Contains secrets, so encryption is mandatory |

**Encryption:**
- Each run produces **one GPG-encrypted bundle** (`veetrax-<UTC>.tar.gpg`), encrypted to a **public key**.
- The private key is kept **offline by you**. The server and the bucket can't decrypt it, so a compromised host or a leaked bucket exposes nothing.
- The plaintext exists only in a temporary directory during the run.

**Tools:** pg_dump, psql, valkey-cli, tar, gzip, gpg and sha256sum are all already on the host. **Nothing to install** for local backups.

**Scripts:**
- [ops/backup/veetrax-backup.sh](../../ops/backup/veetrax-backup.sh)
- [ops/backup/veetrax-restore.sh](../../ops/backup/veetrax-restore.sh)
- [ops/backup/backup.conf.example](../../ops/backup/backup.conf.example)

The older `nightly-backup.ps1` (GitHub Releases, DB only, for a different host layout) is kept unchanged for reference.

## 2. Restore test (2026-11-09, isolated data only)
Source: DB `veetrax_assess` (seed + synthetic data; live simulator writing during the backup). Synthetic uploads and config. A throw-away Valkey instance with known keys. A test-only GPG key pair.

| Check | Result |
|---|---|
| Bundle readable without the private key | No ✔ (PGP-encrypted) |
| Checksums | ✔ |
| Row counts (Company, User, TrackedObject, Device, **Position 322,508**, Trip, Alert, DriverEvent, Invoice, LicenceSeat, LicenceOrder) | 11/11 equal ✔ |
| Uploads byte-identical; logs excluded | ✔ |
| Config restored | ✔ |
| Valkey keys restored from the snapshot | ✔ |
| Restore into a non-empty DB | Refused ✔ |
| Timing | Backup 3 s, restore + verify 4 s, bundle 5.9 MB |

The first run found a real consistency gap: counts taken after the dump differed under live writes. It was fixed by dumping and counting inside one exported snapshot.

## 3. Schedule and retention (proposal)
| Item | Proposal |
|---|---|
| Frequency | Every 6 hours (RPO ≤ 6 h); reduce later with WAL archiving if needed |
| Local copies | 14 days (`KEEP_LOCAL_DAYS`) |
| Off-site retention | 35 daily + 12 monthly via bucket lifecycle rules; **object lock / versioning on** so a compromised host cannot delete backups |
| Restore test | Monthly, documented (the script prints the verification table) |
| Alerting | Status in `last-status.json`; wire into System Health once off-site upload is active |
| Target RTO | < 1 hour at today's data size (restore measured at 4 s for this dataset) |

The schedule is **not yet installed on the live host**. Creating the Windows/WSL scheduled task changes production operations, so it comes with the provider decision.

## 4. Storage provider options: **approval needed**
Sizes measured today:
- live DB 13 MB, uploads 77 KB, Valkey 12 MB;
- one encrypted bundle ≈ 6 MB for the test dataset; the live one is smaller.

At 2,000 vehicles the position history grows to tens of GB, so the cost below is shown for **today** and for **~1 TB** of retained backups.

Prices are **indicative list prices from memory (late 2026 knowledge); please verify on the provider sites before purchase**.

| Provider | Region options (India data residency) | Free tier | ~Price per GB-month | Egress (restore) | Today's cost | At ~1 TB | Notes |
|---|---|---|---|---|---|---|---|
| **Cloudflare R2** | Automatic / jurisdiction (EU/FedRAMP); no India-pinned region | 10 GB storage | ≈ $0.015 | **Free** | **$0** | ≈ $15/mo | You already have a Cloudflare account; S3-compatible; bucket lock available |
| **AWS S3 (ap-south-1 Mumbai)** | **India** ✔ | 5 GB (12 months) | ≈ $0.025 (Standard); ≈ $0.0045 Glacier Deep Archive | ≈ $0.11/GB | ≈ $0 | ≈ $5–25/mo | Best for data residency (DPDP); object lock; most tooling |
| **Backblaze B2** | US / EU | 10 GB | ≈ $0.006 | Free up to 3× stored | $0 | ≈ $6/mo | Cheapest; no India region |
| **Wasabi** | Includes Singapore/Tokyo, no India | none | ≈ $0.007, **1 TB minimum** | Free | ≈ $7/mo minimum | ≈ $7/mo | 90-day minimum retention |
| GitHub Releases (existing design) | US | Free | — | Free | $0 | not suitable | 2 GiB per file; not meant for backups; repo-token risk |

**Recommendation:**
- **AWS S3 in Mumbai (ap-south-1)** if Indian data residency matters for your customers (likely under the DPDP Act for location data).
- Otherwise **Cloudflare R2**, which is free at today's size and uses your existing account.

Either way: a dedicated bucket, versioning plus object lock, lifecycle retention, and a write-only access key on the host (no delete permission).

**Upload tool:** `rclone` (open source) or the provider CLI. Installing it on the host is part of activation.

## 5. To activate (after your approval)
1. You choose the provider and create the bucket and a write-only key. I can provide the exact settings, but I won't sign up or pay for anything.
2. You generate the backup key pair on your own PC and keep the private key offline. I'll provide the commands.
3. Place `backup.conf` (chmod 600) and the public key on the host, set `UPLOAD_CMD`, and install the scheduled task.
4. Run once, restore that bundle into a scratch DB, and record the verification table here.
