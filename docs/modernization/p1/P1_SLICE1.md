# P1 · Slice 1: Design-system foundation

**Branch:** `feature/p1-design-system` (from `feature/s0-safety` @ `a8f8710`) · **Date:** 2026-11-09 · **Status:** ready for review, not merged, not deployed.
**Inputs:** [07-design-system.md](../07-design-system.md) §4, §9 · [08-acceptance-criteria.md](../08-acceptance-criteria.md) P1-1, P1-2, P1-4, G-1 to G-8 · [decision-log.md](../decision-log.md) D-002 · [VISUAL_ASSESSMENT.md](../../discovery/phase2/VISUAL_ASSESSMENT.md).

Product rules followed: logo files byte-identical (no file under `brand/`, `apps/web/public/*.png|svg` or `apps/mobile/assets` changed); Teal, Plum, Sky, Light and Dark palette values unchanged; no new npm dependency; no framework change.

---

## 1. What changed

| # | Change | Gated by `uiRefresh`? | Why |
|---|---|---|---|
| 1 | **UI feature flags** (`apps/web/src/lib/flags.ts`) | — | Lets visual changes ship dark and be switched on per build or per browser |
| 2 | **Inter 4.1 variable self-hosted** (`public/fonts/`, `@font-face`, preload) | **Yes** | Visual change (font), needs owner sign-off before production |
| 3a | **StatusBadge AA text colours** (new `--status-*-fg`, read via `--status-*-text`) | **Yes** | 07 §9.2 marks these as *new colour values* |
| 3b | **Badge success / warning / destructive on existing soft tokens** (+ `info`, `neutral` variants) | No | 07 §9.3 F2: component-level, "Value change: None" |
| 3c | **Solid focus ring** (`ring-2 ring-ring`, global `:focus-visible` outline) | No | 07 §9.3 F4: component-level, "Value change: None" (uses existing `--ring`) |
| 4a | **Hindi / Tamil bundles loaded on demand** | No | Performance, no visual change |
| 4b | **MapLibre loaded on demand by the public share page** | No | Performance, no visual change |

### 1.1 Feature flags

- `UI_FLAGS = ['uiRefresh']`. Each flag is mirrored onto `<html>` as a `data-*` attribute (`data-ui-refresh`), so CSS gates on `:root[data-ui-refresh]` without touching components.
- Resolution order (later wins):
  1. **Defaults:** ON in development (`vite` dev server, `import.meta.env.DEV`), **OFF in production builds**.
  2. **Build time:** `VITE_UI_FLAGS` comma list, `uiRefresh` turns on, `-uiRefresh` turns off. Production build with the refresh on: `VITE_UI_FLAGS=uiRefresh npm run build -w @veetracer/web`.
  3. **Per browser (testing):** `localStorage.setItem('vt.flags', 'uiRefresh')` (or `'-uiRefresh'`) and reload; remove the key to return to the build value.
- Unknown names are ignored. Read once at startup.

### 1.2 Inter

- Files: `apps/web/public/fonts/InterVariable.woff2` (352,240 B, sha256 `693b77d4…29a8e3`), `InterVariable-Italic.woff2` (387,976 B, sha256 `e564f652…7a262a`), `Inter-OFL.txt` (SIL OFL 1.1). Taken unchanged from the official [rsms/inter v4.1 release](https://github.com/rsms/inter/releases/tag/v4.1) (`Inter-4.1.zip`, sha256 `9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e`).
- `@font-face { font-family: 'InterVariable'; font-weight: 100 900; font-display: swap; }` (roman + italic) in `index.css`. The family name differs from the existing `'Inter'` entry on purpose: the file is only requested where it is used, i.e. `:root[data-ui-refresh] body { font-family: 'InterVariable', var(--font-sans) }`. `main.tsx` adds a `<link rel=preload as=font>` only when the flag is on.
- The existing `font-feature-settings: 'cv11', 'ss01'` now takes effect (single-storey *a*, open digits), as the original design intended.
- Manrope (`brand/fonts`) and the logo assets are untouched. Hindi and Tamil glyphs are not in Inter and fall back to the system font (07 §9.4 T2, pending).

**Verification (headless Chrome, dev server, Windows without Inter installed):**

| | Flag on | Flag off |
|---|---|---|
| `getComputedStyle(body).fontFamily` | `InterVariable, Inter, "Inter Variable", ui-sans-serif, …` | `Inter, "Inter Variable", ui-sans-serif, …` (renders Segoe UI) |
| `document.fonts.check('14px InterVariable')` | `true` | — |
| Loaded `FontFace`s | `InterVariable normal` | none |
| Network | `InterVariable.woff2` fetched | no font request |

Visible in the login screenshots: `01-login-after-*` (Inter) vs `01-login-before-*` (Segoe UI).

### 1.3 Contrast fixes

Method as in 07 appendix: WCAG 2.x relative luminance; tints (`color-mix(... 14%, transparent)`, `/12`, Dark `rgb(… / 0.15)`) composited in sRGB over the theme card (`#ffffff` light themes, `#0d1a28` Dark). All four light themes share the same status, semantic and soft values, so one light column covers Teal, Plum, Sky and Light. Script: recomputed for this slice (values agree with 07 §4 to ±0.02).

**StatusBadge text on its 14 % tint (AA 4.5:1), F1, flag `uiRefresh`**

| Status | Light themes before | Light after (`--status-*-fg`) | Dark before | Dark after |
|---|---|---|---|---|
| RUNNING | 2.82 FAIL | **6.09** (`#166534`) | 6.06 | 6.06 (`#22c55e`, unchanged) |
| IDLE | 2.75 FAIL | **4.97** (`#9a5400`) | 7.94 | 7.94 (`#fbbf24`) |
| OFF | 3.89 FAIL | **5.21** (`#b91c1c`, = mobile) | 5.27 | 5.27 (`#f87171`) |
| OVERSPEED | 4.35 FAIL | **5.65** (`#7e22ce`, = mobile) | 5.34 | 5.34 (`#c084fc`) |
| OFFLINE | 4.05 FAIL | **6.34** (`#4b5563`, = mobile) | 5.50 | 5.50 (`#9ca3af`) |
| NO_DATA | 2.29 FAIL | **5.19** (`#5b6676`) | 3.19 FAIL | **5.91** (`#94a3b8`) |

The tint, the dot and every map marker / chart colour keep the `STATUS_META` values. The same text token is used for the coloured status words in the live list (`LivePanel`). Values live in `STATUS_TEXT` in `apps/web/src/lib/status-tokens.ts` (web only for now; 07 §9.3 F9 proposes one shared source for web and mobile).

**`<Badge>` variants (AA 4.5:1), F2, unconditional**

| Variant | Light before (`text-x` on `x/12`) | Light after (`x-fg` on `x-soft`) | Dark before | Dark after |
|---|---|---|---|---|
| success | 4.27 FAIL | **5.98** | 6.28 | 9.61 |
| warning | 4.25 FAIL | **5.74** | 6.73 | 9.45 |
| destructive | 4.01 FAIL | **6.21** | 4.22 FAIL | **8.11** |
| info (new variant) | — | 8.32 | — | 7.55 |
| neutral (new variant) | — | 6.53 | — | 9.18 |

**Focus indicator vs page background (UI 3:1), F4, unconditional**

| | Teal | Plum | Sky | Light | Dark |
|---|---|---|---|---|---|
| Before: `ring-ring/40` | 1.66 FAIL | 1.70 FAIL | 1.61 FAIL | 1.66 FAIL | 2.58 FAIL |
| After: solid `--ring` vs background | **4.00** | **4.41** | **3.68** | **4.00** | **10.12** |
| After: solid `--ring` vs card | 4.28 | 4.76 | 3.95 | 4.28 | 9.44 |
| Header (`--ring` = `--sidebar-primary` on `--sidebar`) | 7.01 | 7.88 | 5.12 | 7.62 | 10.81 |

Buttons, checkbox, switch, tabs, dialog/sheet close buttons and 20 feature-level focus styles now draw `ring-2` in the solid ring colour (destructive buttons: solid `--destructive`). The global `:focus-visible { outline: none }` became `outline: 2px solid var(--ring); outline-offset: 2px`, so elements without their own ring still show focus. Text inputs and selects keep their solid `border-ring` (already passing) plus the soft halo.

**Not changed (pending owner, see §6):** Dark destructive button, white on `#ef4444` = **3.76:1 (still FAIL)**.

### 1.4 Performance

- **Hindi / Tamil:** `lib/i18n.ts` initialises with English only (keys are the English strings). `lib/locale-loader.ts` fetches the `hi` or `ta` bundle when that language is selected and adds it with `addResourceBundle`; concurrent requests share one download, a failed download is retried next time and leaves the current language in place, and only the latest choice is applied if the user switches again mid-download. `main.tsx` waits for the saved language's bundle before the first render, so Hindi and Tamil users never see an English flash. New alias `@veetracer/shared-i18n` → `packages/shared/src/i18n` (vite + tsconfig paths) makes the bundles separate chunks. Mobile still uses the eager `i18nResources()`; the shared package is unchanged.
- **MapLibre:** `PublicSharePage` is routed eagerly, and its static `import maplibregl from 'maplibre-gl'` (plus the MapLibre CSS) was in every first load, including `/login`. It now imports both when it mounts and applies the marker/trail once the map exists. The alert-bell `MiniMap` was already behind `React.lazy` (AlertBell, AlertDetailSheet, DriverEventDetail) and stays off the first load; verified in the build (no `maplibre-gl` chunk or CSS referenced by `index.html`).

**Initial JS (production build, gzip):** method from the brief: `npx vite build --outDir <tmp>` (never `apps/web/dist`), sum of gzip sizes (Node `zlib`, default level) of every script referenced by the built `index.html` (entry + `modulepreload`).

| | Scripts | Raw | **Gzip** | Initial CSS (gzip) |
|---|---|---|---|---|
| Before (`a8f8710`) | 46 | 2,697 KB | **742 KB** (brief baseline: 744 KB) | 15.8 KB + 9.8 KB MapLibre CSS |
| After (this branch) | 46 | 952 KB | **307 KB** (−435 KB, −59 %) | 15.9 KB |

Removed from the first load: `maplibre-gl` (265 KB gz) and the `hi` + `ta` translations (one 171 KB gz chunk; now `hi` 86 KB and `ta` 90 KB, each fetched only when selected). Meets P1-4 (target ≤ 350 KB gz). The script count is unchanged because the removed chunks were replaced in the preload list by nothing new; the 46 are small shared vendor chunks.

The Inter roman file (344 KB, already compressed woff2) is fetched once and cached when `uiRefresh` is on; it is not JS and not counted above. Subsetting to Latin would cut it to roughly a third but needs a font tool; left for a later slice.

---

## 2. Files

| File | Change |
|---|---|
| `apps/web/src/lib/flags.ts` · `flags.test.ts` | New: flag module + tests |
| `apps/web/src/lib/locale-loader.ts` · `locale-loader.test.ts` | New: on-demand bundle loader + language switcher + tests |
| `apps/web/src/lib/i18n.ts` | English-only init, on-demand hi/ta, `i18nReady` |
| `apps/web/src/main.tsx` | Applies flags, preloads Inter when on, waits for `i18nReady` |
| `apps/web/src/vite-env.d.ts` | `VITE_UI_FLAGS` typed |
| `apps/web/vite.config.ts` · `tsconfig.app.json` | `@veetracer/shared-i18n` alias |
| `apps/web/src/features/live-share/PublicSharePage.tsx` | MapLibre imported on demand |
| `apps/web/public/fonts/InterVariable.woff2`, `InterVariable-Italic.woff2`, `Inter-OFL.txt` | New: vendored Inter 4.1 (OFL) |
| `apps/web/src/index.css` | `@font-face`, flag-gated font, solid default focus outline |
| `apps/web/src/lib/status-tokens.ts` | `STATUS_TEXT`, `--status-*-fg`, flag-gated `--status-*-text`, `statusTextColor()` |
| `apps/web/src/components/status-badge.tsx` · `features/live/LivePanel.tsx` | Status text reads `statusTextColor()` |
| `apps/web/src/components/ui/badge.tsx` | Soft-token variants, `info`, `neutral` |
| `components/ui/{button,checkbox,switch,tabs,dialog,sheet}.tsx` + 20 feature files | Focus ring solid (`ring-2 ring-ring`) |
| `.gitattributes` | `*.woff2 binary` |

---

## 3. Tests

| Check | Result |
|---|---|
| `npm test` (apps/web, node:test) | **108 / 108 pass** (95 existing + 6 flag + 7 locale-loader) |
| `npx tsc -b --noEmit` (apps/web) | clean |
| `npx vite build` (temp outDir) | succeeds |
| Logo / brand files | unchanged vs `feature/s0-safety` (`git diff --stat` on `brand/`, `apps/web/public/*.png`, `favicon.svg`, `apps/mobile/assets` is empty) |
| Inter loads | verified (§1.2) |

New unit tests: flag defaults (dev on / prod off), `VITE_UI_FLAGS` on/off syntax, localStorage override precedence, unknown names ignored, module value under node, attribute mirroring; locale loader: English needs nothing, one request per language even when concurrent, only the requested language fetched, failed download rejects and retries, switcher applies only the latest choice, failed switch keeps the current language.

---

## 4. Screenshots

`docs/modernization/p1/screenshots/` — isolated API on port 4100 with synthetic data only (G-7). Naming `NN-page-{before|after}-{teal|dark}-{1440|390}.png`; **before = `uiRefresh` off, after = on**, both from this branch.

| Page | Files |
|---|---|
| Login | `01-login-*` |
| Dashboard | `02-dashboard-*` |
| Live map | `03-live-*` |
| Reports, Summary result | `04-reports-summary-*` |
| DMS | `05-dms-*` |
| Driver scorecard | `06-driver-scores-*` |

Live data is synthetic and moving, so counts differ slightly between the before and after captures. Note: the two unconditional fixes (Badge soft tokens, solid focus ring) are present in both columns, because they are not behind the flag. The flag difference shows the font (all pages) and the status-badge text colours (live list, dashboard, driver scorecard where status badges appear).

---

## 5. Acceptance criteria covered

| Criterion | Status |
|---|---|
| P1-1 Inter loads, computed font resolves to Inter | Met with `uiRefresh` on (production needs `VITE_UI_FLAGS=uiRefresh` once approved) |
| P1-2 Palette values preserved except approved contrast adjustments | Met: no palette value changed; new status text tokens are additive and gated |
| P1-4 `/login` initial JS without MapLibre or non-active locales, ≤ 350 KB gz | **Met: 307 KB gz** |
| G-1 Existing tests pass, new tests added | Met |
| G-3 Teal + Dark at 1440 / 390 | Screenshots; 768 px and Plum/Sky spot-checks not in this slice |
| G-4 Visible focus, AA contrast | Focus and badges fixed; Dark destructive pending (below); axe run not in this slice |
| G-8 Logo unchanged | Met |

---

## 6. Pending owner decisions

| Item | Detail | Ref |
|---|---|---|
| **Dark destructive button** | White on `#ef4444` = 3.76:1 (fails AA). Option A: Dark `--destructive: #dc2626` (4.83). Option B: keep the colour, dark text `#1f0505` (5.16). **Not changed** — palette value. | 07 §9.3 F3 |
| Enable `uiRefresh` in production | Turns on Inter and the status text colours. Build with `VITE_UI_FLAGS=uiRefresh` after review of the screenshots. | this doc §1.1 |
| Status text colour values | `#166534`, `#9a5400`, `#5b6676` are new (the other three equal mobile). Approve, then later move to a shared token source for web + mobile. | 07 §9.2, F9 |
| Badge soft tokens and solid focus ring shipped unflagged | Component-level, no value change, as the brief allows for 07 §9 component fixes; 07 lists every §9 item as "requires product-owner approval", so please confirm. Revert = the two commits. | 07 §9.3 F2, F4 |
| Devanagari / Tamil UI font | Inter has no Hindi/Tamil glyphs; optional Noto Sans Devanagari / Tamil after Inter | 07 §9.4 T2 |
| In-app wordmark in Manrope 800 | Optional, a rendering change to a logo element | 07 §9.4 T5 |
| Remaining 07 items | NO_DATA dot ring (F5), input border strength (F6), chart / DMS colours (F7), severity tokens (F8), "System (follow OS)" theme (Q-24) | 07 §9.3, §9.5 |

---

## 7. Rollback

All changes are frontend only. Visual changes: build without `VITE_UI_FLAGS` (default off) or set `localStorage['vt.flags'] = '-uiRefresh'`. Any single item: revert its commit (one commit per item, see `git log feature/s0-safety..feature/p1-design-system`).
