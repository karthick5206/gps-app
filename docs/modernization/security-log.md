# Security Operations Log

Chronological record of security-relevant operations on VeeTrax environments. **Never include secret values or message contents here.**

## 2026-11-09 — Removal of stored e-mail copies (R-28; owner approval item 3)
| Step | Result |
|---|---|
| Background | The mailer wrote a full copy of every e-mail to `apps/api/var/mail` (password-reset links, invoices, alert mails). In production this is now disabled by S0.2 (`keepMailCopies`), effective once S0 is deployed |
| Invalidate outstanding reset links and login codes | `PasswordReset` (unused, unexpired) and `OtpCode` (unconsumed, unexpired) were set to expire now in **both** DBs on the host (`veetracer` = live, `veetrax_assess` = isolated). Outstanding before: **0 reset links, 0 OTP codes** in each. The links in the copies were already unusable |
| Other copies checked (by name / pattern only, contents not read) | `docs/discovery.zip`, `docs/discovery (2).zip`: no mail entries. Git history: none (`var/` is git-ignored). WSL: no backup folders, no `.eml` files. PM2 logs: no reset URLs. Assessment logs: no reset URLs |
| Future backups | `ops/backup/veetrax-backup.sh` excludes `var/mail` and `var/sms` (in addition to `var/logs`) |
| Deletion | **18** files (17 reported earlier + 1 created during S0 testing) overwritten and deleted with `shred -u -z`. `var/mail` is empty; `var/sms` does not exist |
| Residual | NTFS/SSD may retain blocks despite overwrite (best effort). No further copies known |

## 2026-11-09 — Production configuration
- `ops/run/ecosystem.config.cjs`: `NODE_ENV=production` for api, gateway, processor, notifier and summarizer (decision Q-02, validated on staging). Not started.
