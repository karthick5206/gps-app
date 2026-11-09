# Risk Register (summary)

Canonical, detailed register: [docs/modernization/05-technical-risk-register.md](docs/modernization/05-technical-risk-register.md). This page lists open items by priority. _Updated 2026-11-09._

| ID | Risk | Severity | Status |
|---|---|---|---|
| R-01 | Queued engine stop executed late without a re-check | Critical | Mitigated in code (S0.1); **awaiting deployment** |
| R-02 | Production without `NODE_ENV=production` (SSRF, assertions) | Critical | Validated in staging; config set; **awaiting deployment** |
| R-36 | Company purge / account deletion deletes legal GST invoices and payment history | High | Confirmed by code reading; design for review; stop-gap proposed |
| R-03 | Backups did not cover files; no tested restore | High | Encrypted full backup + verified restore done; S3 off-site awaits cost approval and key pair |
| R-37 | No SMS / mail provider in production | Medium | 503 + admin-assisted reset demonstrated; providers needed |
| R-12/13/14/15 | Permission ceiling, API key scope, socket after logout, template test-send | High | Planned P4 |
| R-05…R-11 | GPS pipeline and DB durability and scale | High | Planned P7 |
| R-22…R-24 | Mobile session wipe, tracker re-pair, tracker queue block | High | Planned P6 |
| R-38 | Credit-note number exceeds 16 characters (GST rule) | Medium | CA to confirm |
| Closed | R-04 (seed password), R-17 (UPI double fulfilment), R-28 (stored mail copies) | — | Mitigated (R-04/R-17 await deployment) |
