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
| Off-site retention | see §4.3 (S3 lifecycle: Standard 30 d → Glacier IR, expire 400 d); **object lock / versioning on** so a compromised host cannot delete backups |
| Restore test | Monthly, documented (the script prints the verification table) |
| Alerting | Status in `last-status.json`; wire into System Health once off-site upload is active |
| Target RTO | < 1 hour at today's data size (restore measured at 4 s for this dataset) |

The schedule is **not yet installed on the live host**. Creating the Windows/WSL scheduled task changes production operations, so it comes with the provider decision.

## 4. Off-site destination: AWS S3 Mumbai (ap-south-1). Owner decision 2026-11-09; **not created yet**

### 4.1 Verified prices
**Source:** the official **AWS Price List API** offer files for `AmazonS3` and `AWSDataTransfer`, region `ap-south-1`, **publication 2026-11-04** (fetched 2026-11-09). This is the same data the AWS Pricing Calculator uses.

| Item | Price (USD) |
|---|---|
| S3 Standard storage | $0.025 per GB-month (first 50 TB) |
| S3 Standard-IA storage / retrieval | $0.0138 per GB-month / $0.01 per GB |
| S3 Glacier Instant Retrieval storage / retrieval | $0.005 per GB-month / $0.03 per GB |
| S3 Glacier Flexible Retrieval storage / standard retrieval | $0.0045 per GB-month / $0.012 per GB |
| Glacier Deep Archive | storage rate **not found in the offer file**; retrieval $0.024/GB (standard), $0.005/GB (bulk). Verify in the calculator if used (not proposed) |
| PUT / COPY / LIST requests | $0.005 per 1,000 |
| GET requests | $0.004 per 10,000 |
| Data transfer out to the internet | $0.1093 per GB (first 10 TB), **beyond the account-wide free allowance** |
| SSE-S3 encryption, versioning, Object Lock, Block Public Access | no charge (versions are billed as storage) |

### 4.2 Cost estimate (INR at ≈ ₹85/USD, indicative)
| Scenario | Assumptions | Monthly cost |
|---|---|---|
| **Today** | Bundle ≤ 6 MB; 4 backups/day; 30 days in Standard, then Glacier IR; kept 400 days → ≈ 0.7 GB Standard + ≈ 9 GB Glacier IR; ≈ 120 PUTs; 1 monthly restore test (6 MB download) | **< $0.10 (≈ ₹8)** |
| 2,000 vehicles (growth) | DB ≈ 150 GB compressed. Full dump nightly instead of every 6 h, plus incremental/WAL later (see note). ≈ 1 TB retained (≈ 200 GB Standard + 800 GB Glacier IR) | ≈ $5 + $4 = **≈ $9 (≈ ₹770)** |
| Full restore at that size | 150 GB download (egress) + Glacier IR retrieval of an old bundle | ≈ $16 + $4.5 one-off (**≈ ₹1,750**) |

Note: at 2,000-vehicle scale, 6-hourly full dumps become too large. Move to nightly full backups plus PostgreSQL WAL archiving (point-in-time recovery). That is a later change; costs scale linearly with the table above.

### 4.3 Recommended retention policy
| Rule | Value | Why |
|---|---|---|
| Frequency | Every 6 h (RPO ≤ 6 h) | Today's data is tiny; one bundle ≈ 3 s |
| Storage class | Standard for 30 days, then **Glacier Instant Retrieval** | Recent backups are restored most; GIR keeps millisecond access at one-fifth the price (90-day minimum duration is met) |
| Expiry | 400 days | ≥ 12 months of history (covers year-end disputes). Legal *financial* retention is handled in the database (see [company-retention-design.md](company-retention-design.md)), not by backups |
| Object Lock | **Governance mode, 35 days** | A compromised host or key cannot delete or overwrite recent backups (ransomware protection) |
| Versioning | On (required for Object Lock); non-current versions expire after 7 days | — |
| Local copies | 14 days on the host | Fast local restore |
| Restore test | Monthly, from S3 into a scratch DB, recorded here | "A backup is not reliable until a restore succeeded" |

### 4.4 Security design
- **Client-side encryption:** a GPG public key is used on the host. **You keep the private key offline.** AWS never sees plaintext.
- **Server-side encryption:** SSE-S3 (AES-256) is enforced by the bucket policy ([bucket-policy.json](../../ops/backup/aws/bucket-policy.json)). SSE-KMS isn't needed on top of client-side encryption ($1/key/month + request costs).
- **Bucket access:** Block Public Access on, and TLS-only access enforced by the bucket policy.
- **IAM:** a dedicated user `veetrax-backup-writer` with **only `s3:PutObject` on `veetrax-backups/prod/*`** ([iam-backup-writer.json](../../ops/backup/aws/iam-backup-writer.json)). It can't list, read or delete. Restores use a separate read role that you hold.
- **Key handling:** the access key lives only in the root-only `backup.conf` on the host. Rotate it every 90 days.
- **Lifecycle:** [lifecycle.json](../../ops/backup/aws/lifecycle.json).
- **Upload:** [s3-put.sh](../../ops/backup/s3-put.sh) uses plain `curl --aws-sigv4` (curl 8.18 is already in WSL), with a `Content-MD5` integrity check. **No AWS CLI or other software to install.**

## 5. To activate (needs your approval; no AWS resources exist yet)
1. **You approve the cost (§4.2).** Then you, or I with credentials you place in the host config yourself, create bucket `veetrax-backups` in ap-south-1 with versioning, Object Lock (Governance, 35 d), Block Public Access, the bucket policy and the lifecycle rule.
2. Create the IAM user with the write-only policy and put its key in `/etc/veetrax/backup.conf` (chmod 600) with `UPLOAD_CMD='bash /mnt/d/Vibhav/gps-app/ops/backup/s3-put.sh {file}'`.
3. You generate the backup key pair on your own PC and keep the private key offline; only the public key goes on the host. I'll provide the commands.
4. **Off-site test:** run one backup → it appears in S3 → download it with the read role → `veetrax-restore.sh` into a scratch DB → record the verification table here.
5. Install the 6-hourly schedule (WSL cron or a Windows scheduled task). This is a production operations change.
