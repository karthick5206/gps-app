# Database backups

Runs on the production server as the scheduled task **"VeeTrax nightly backup"** (SYSTEM) at 02:30, 10:30 and 18:30.

| Kind | When | Contents |
|---|---|---|
| **Full** | Sunday 02:30 (or when the last full is 7+ days old) | `pg_dump` of the whole database |
| **Diff** | every other run (every 8 h) | all tables except the data of `Position` / `RawPacket`, plus their rows received since the last full (CSV) |

Each file is encrypted with [age](https://github.com/FiloSottile/age) using the **public** key only and uploaded as a GitHub Release asset to the private repo `veetrax/dailydbbackup`. Releases older than **100 days** are deleted; a full is kept while a kept diff still needs it. Failures are e-mailed to `config.alertTo` and logged.

## On the server (`C:\apps\veetracer`)

- `scripts\nightly-backup.ps1` (this folder's copy): `-Mode auto|full|diff`
- `backup\config.json`: `{ repo, recipient (age public key), alertTo, keepDays, keepLocal }`
- `backup\state.json`: last full tag and the time its rows start from
- `secrets\github-backup-token.txt`: fine-grained token, **Contents: read & write** on `veetrax/dailydbbackup` only
- `tools\age\age.exe`, `logs\backup.log`, `backup\last-status.json`

## Restore

The private key never goes on the server. On the owner's PC (`C:\VeeTrax-Backup-Key`, with `age.exe` and `veetrax-backup-key.txt`):

1. Download the full (`full-….dump.age`) and the latest diff after it (`diff-….zip.age`; its release text names the base full).
2. Create an empty database.
3. `.\restore.ps1 -Full full-….dump.age -Diff diff-….zip.age -Target "postgresql://user:pass@host:5432/newdb"` (omit `-Diff` to restore the full only).

Tested 2026-10-23: full + diff restored into a scratch database matched the live counts at the diff time.
