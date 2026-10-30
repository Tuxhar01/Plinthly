# Phase 0 Report: Project Setup and Design Foundation (`purchase-assurance`)

## 1. Summary

- **Check 1: Environment**: PASS (Node `v22.17.0`, npm `10.9.2`)
- **Check 2: Lint**: PASS (Exit code 0, 0 errors, 0 warnings)
- **Check 3: Tests**: PASS (Exit code 0, 12/12 tests passed, all measured ratios reported)
- **Check 4: Prisma validation and generation**: PASS (Both commands succeeded with exit code 0)
- **Check 5: Production build**: FAIL (Route-list absence criterion failed: `/design` remains listed in `next build` CLI table; Functional unavailability passed with HTTP 404)
- **Check 6: Development server and manual checks**: PASS (Both `/` and `/design` verified; tokens, theme toggle, and focus rings working as specified)
- **Check 7: Reduced motion**: PASS (Transitions capped at 120ms, transforms disabled on primitives, skeleton animation static under `prefers-reduced-motion`)
- **Check 8: Secret scan**: PASS (0 real secrets found; only placeholders and variable references in `.env.example`, `docker-compose.yml`, `prisma.config.ts`, and docs)
- **Check 9: Schema check**: PASS (`prisma/schema.prisma` contains `provider = "postgresql"` and no `sqlite`)
- **Check 10: Git remote check**: PASS (No remotes configured; `git remote -v` produced 0 lines)
- **Check 11: Gate 1 hash comparison**: PASS (Baseline hash `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451` perfectly preserved)

---

## 2. Environment

- **Node.js version:** `v22.17.0`
- **npm version:** `10.9.2`
- **Next.js version:** `16.4.2`
- **React version:** `19.3.0`
- **React DOM version:** `19.3.0`
- **TypeScript version:** `5.9.3`
- **Tailwind CSS version and integration method:** `4.3.3` (Tailwind v4 using `@import "tailwindcss";` and `@theme inline` mapping in `app/globals.css`)
- **ESLint version:** `9.39.5` (`eslint-config-next: 16.4.2`)
- **Prisma version:** `7.10.1` (`@prisma/client: 7.10.1`)
- **Vitest version:** `5.0.5`
- **PostgreSQL Docker image tag:** `postgres:16`

---

## 3. Files Created

### Root Directory (`/`)
- `.env.example`
- `.gitignore`
- `AGENTS.md`
- `docker-compose.yml`
- `eslint.config.mjs`
- `next-env.d.ts`
- `next.config.ts`
- `package.json`
- `package-lock.json`
- `prisma.config.ts`
- `README.md`
- `tsconfig.json`
- `PHASE0_REPORT.md`

### `app/`
- `app/globals.css`
- `app/layout.tsx`
- `app/page.tsx`
- `app/design/page.tsx`
- `app/design/design-showcase.tsx`

### `components/ui/`
- `components/ui/app-shell.tsx`
- `components/ui/banner.tsx`
- `components/ui/button.tsx`
- `components/ui/card.tsx`
- `components/ui/field.tsx`
- `components/ui/input.tsx`
- `components/ui/skeleton.tsx`
- `components/ui/status-chip.tsx`
- `components/ui/textarea.tsx`

### `lib/`
- `lib/brand.ts`

### `prisma/`
- `prisma/schema.prisma`

### `tests/`
- `tests/tokens.test.ts`
- `tests/source.test.ts`

---

## 4. Font Results

| Family | Loaded Successfully | Weights Loaded | Error Text |
|---|---|---|---|
| Newsreader | Yes | 500, 600 | None |
| Geist | Yes | 400, 500, 600 | None |
| Geist Mono | Yes | 400 | None |

System fallbacks configured:
- Display: `Georgia, "Times New Roman", serif`
- UI: `system-ui, -apple-system, "Segoe UI", sans-serif`
- Mono: `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` with `font-variant-numeric: tabular-nums`

---

## 5. Contrast Results

### Light Theme

| Theme | Pair | Background | Measured Ratio | Reference Ratio | Difference | Result |
|---|---|---|---|---|---|---|
| Light | ink | canvas | 15.89 | 15.89 | 0.003 | Pass |
| Light | ink | surface | 17.79 | 17.79 | 0.002 | Pass |
| Light | ink | surface-raised | 17.05 | 17.05 | 0.004 | Pass |
| Light | ink-muted | canvas | 5.40 | 5.40 | 0.000 | Pass |
| Light | ink-muted | surface | 6.05 | 6.05 | 0.005 | Pass |
| Light | ink-muted | surface-raised | 5.79 | 5.79 | 0.002 | Pass |
| Light | accent | canvas | 8.17 | 8.17 | 0.001 | Pass |
| Light | accent | surface | 9.15 | 9.15 | 0.002 | Pass |
| Light | on-accent | accent | 8.17 | 8.17 | 0.001 | Pass |
| Light | on-accent | accent-hover | 10.59 | 10.59 | 0.001 | Pass |
| Light | pass | canvas | 5.71 | 5.71 | 0.001 | Pass |
| Light | pass | surface | 6.39 | 6.39 | 0.001 | Pass |
| Light | caution | canvas | 5.28 | 5.28 | 0.003 | Pass |
| Light | caution | surface | 5.91 | 5.91 | 0.004 | Pass |
| Light | block | canvas | 6.62 | 6.62 | 0.000 | Pass |
| Light | block | surface | 7.41 | 7.41 | 0.001 | Pass |
| Light | info | canvas | 6.12 | 6.12 | 0.000 | Pass |
| Light | info | surface | 6.85 | 6.85 | 0.001 | Pass |
| Light | ink | pass-tint | 15.06 | 15.06 | 0.003 | Pass |
| Light | ink | caution-tint | 15.05 | 15.05 | 0.004 | Pass |
| Light | ink | block-tint | 14.13 | 14.13 | 0.004 | Pass |
| Light | ink | info-tint | 14.66 | 14.66 | 0.005 | Pass |
| Light | ink | neutral-tint | 14.67 | 14.67 | 0.005 | Pass |
| Light | pass | pass-tint | 5.41 | 5.41 | 0.000 | Pass |
| Light | caution | caution-tint | 5.00 | 5.00 | 0.004 | Pass |
| Light | block | block-tint | 5.89 | 5.89 | 0.003 | Pass |
| Light | info | info-tint | 5.64 | 5.64 | 0.003 | Pass |
| Light | accent (focus ring) | canvas | 8.17 | 8.17 | 0.001 | Pass |
| Light | accent (focus ring) | surface | 9.15 | 9.15 | 0.002 | Pass |
| Light | control-border | canvas | 3.45 | 3.45 | 0.000 | Pass |
| Light | control-border | surface | 3.86 | 3.86 | 0.002 | Pass |
| Light | disabled (ink-muted@45%) | canvas | 1.90 | N/A (exempt) | N/A | Pass (info) |
| Light | disabled (ink-muted@45%) | surface | 1.97 | N/A (exempt) | N/A | Pass (info) |
| Light | disabled (ink-muted@45%) | surface-raised | 1.95 | N/A (exempt) | N/A | Pass (info) |

### Dark Theme

| Theme | Pair | Background | Measured Ratio | Reference Ratio | Difference | Result |
|---|---|---|---|---|---|---|
| Dark | ink | canvas | 15.61 | 15.61 | 0.002 | Pass |
| Dark | ink | surface | 14.39 | 14.39 | 0.003 | Pass |
| Dark | ink | surface-raised | 13.48 | 13.48 | 0.002 | Pass |
| Dark | ink-muted | canvas | 7.21 | 7.21 | 0.003 | Pass |
| Dark | ink-muted | surface | 6.65 | 6.65 | 0.002 | Pass |
| Dark | ink-muted | surface-raised | 6.23 | 6.23 | 0.001 | Pass |
| Dark | accent | canvas | 8.41 | 8.41 | 0.004 | Pass |
| Dark | accent | surface | 7.75 | 7.75 | 0.002 | Pass |
| Dark | on-accent | accent | 8.41 | 8.41 | 0.004 | Pass |
| Dark | on-accent | accent-hover | 10.53 | 10.53 | 0.005 | Pass |
| Dark | pass | canvas | 9.02 | 9.02 | 0.004 | Pass |
| Dark | pass | surface | 8.32 | 8.32 | 0.001 | Pass |
| Dark | caution | canvas | 9.56 | 9.56 | 0.000 | Pass |
| Dark | caution | surface | 8.82 | 8.82 | 0.004 | Pass |
| Dark | block | canvas | 7.49 | 7.49 | 0.001 | Pass |
| Dark | block | surface | 6.91 | 6.91 | 0.002 | Pass |
| Dark | info | canvas | 8.65 | 8.65 | 0.003 | Pass |
| Dark | info | surface | 7.97 | 7.97 | 0.004 | Pass |
| Dark | ink | pass-tint | 12.46 | 12.46 | 0.001 | Pass |
| Dark | ink | caution-tint | 12.78 | 12.78 | 0.000 | Pass |
| Dark | ink | block-tint | 13.35 | 13.35 | 0.002 | Pass |
| Dark | ink | info-tint | 12.99 | 12.99 | 0.003 | Pass |
| Dark | ink | neutral-tint | 12.49 | 12.49 | 0.001 | Pass |
| Dark | pass | pass-tint | 7.20 | 7.20 | 0.004 | Pass |
| Dark | caution | caution-tint | 7.83 | 7.83 | 0.002 | Pass |
| Dark | block | block-tint | 6.41 | 6.41 | 0.003 | Pass |
| Dark | info | info-tint | 7.20 | 7.20 | 0.005 | Pass |
| Dark | accent (focus ring) | canvas | 8.41 | 8.41 | 0.004 | Pass |
| Dark | accent (focus ring) | surface | 7.75 | 7.75 | 0.002 | Pass |
| Dark | control-border | canvas | 4.77 | 4.77 | 0.005 | Pass |
| Dark | control-border | surface | 4.40 | 4.40 | 0.003 | Pass |
| Dark | disabled (ink-muted@45%) | canvas | 2.39 | N/A (exempt) | N/A | Pass (info) |
| Dark | disabled (ink-muted@45%) | surface | 2.38 | N/A (exempt) | N/A | Pass (info) |
| Dark | disabled (ink-muted@45%) | surface-raised | 2.36 | N/A (exempt) | N/A | Pass (info) |

---

## 6. Source Check Results

- **Check 1: Controls must not use the decorative token**: PASS
  - `components/ui/input.tsx`: Does not contain `var(--line)`; contains `var(--control-border)`.
  - `components/ui/textarea.tsx`: Does not contain `var(--line)`; contains `var(--control-border)`.
- **Check 2: No hex colour outside the token file**: PASS
  - All `.ts` and `.tsx` files under `components/`, `app/`, and `lib/` scanned. 0 matches found outside `app/globals.css`.
- **Check 3: No SQLite in Prisma schema**: PASS
  - `prisma/schema.prisma` contains `provider = "postgresql"` and no references to `sqlite`.
- **Check 4: No hardcoded database password in docker-compose.yml**: PASS
  - `docker-compose.yml` uses `POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}` with 0 hardcoded values.

---

## 7. Command Outputs

### 1. Environment
```
node --version
v22.17.0

npm --version
10.9.2
```

### 2. Lint
```
npm run lint

> purchase-assurance@0.1.0 lint
> eslint
```
(Exit code 0, 0 errors, 0 warnings)

### 3. Tests
```
npm test

> purchase-assurance@0.1.0 test
> vitest run

stdout | tests/tokens.test.ts > WCAG Design Token Contrast Verification > light theme > meets WCAG 4.5:1 text contrast threshold
[light] Text: ink on canvas => 15.89:1 (threshold 4.50:1)
[light] Text: ink on surface => 17.79:1 (threshold 4.50:1)
[light] Text: ink on surface-raised => 17.05:1 (threshold 4.50:1)
[light] Text: ink-muted on canvas => 5.40:1 (threshold 4.50:1)
[light] Text: ink-muted on surface => 6.05:1 (threshold 4.50:1)
[light] Text: ink-muted on surface-raised => 5.79:1 (threshold 4.50:1)
[light] Text: accent on canvas => 8.17:1 (threshold 4.50:1)
[light] Text: accent on surface => 9.15:1 (threshold 4.50:1)
[light] Text: pass on canvas => 5.71:1 (threshold 4.50:1)
[light] Text: pass on surface => 6.39:1 (threshold 4.50:1)
[light] Text: caution on canvas => 5.28:1 (threshold 4.50:1)
[light] Text: caution on surface => 5.91:1 (threshold 4.50:1)
[light] Text: block on canvas => 6.62:1 (threshold 4.50:1)
[light] Text: block on surface => 7.41:1 (threshold 4.50:1)
[light] Text: info on canvas => 6.12:1 (threshold 4.50:1)
[light] Text: info on surface => 6.85:1 (threshold 4.50:1)
[light] Text: on-accent on accent => 8.17:1 (threshold 4.50:1)
[light] Text: on-accent on accent-hover => 10.59:1 (threshold 4.50:1)
[light] Text: ink on pass-tint => 15.06:1 (threshold 4.50:1)
[light] Text: ink on caution-tint => 15.05:1 (threshold 4.50:1)
[light] Text: ink on block-tint => 14.13:1 (threshold 4.50:1)
[light] Text: ink on info-tint => 14.66:1 (threshold 4.50:1)
[light] Text: ink on neutral-tint => 14.67:1 (threshold 4.50:1)
[light] Text: pass on pass-tint => 5.41:1 (threshold 4.50:1)
[light] Text: caution on caution-tint => 5.00:1 (threshold 4.50:1)
[light] Text: block on block-tint => 5.89:1 (threshold 4.50:1)
[light] Text: info on info-tint => 5.64:1 (threshold 4.50:1)

stdout | tests/tokens.test.ts > WCAG Design Token Contrast Verification > light theme > meets WCAG 3.0:1 non-text contrast threshold
[light] Non-text: accent on canvas => 8.17:1 (threshold 3.00:1)
[light] Non-text: accent on surface => 9.15:1 (threshold 3.00:1)
[light] Non-text: control-border on canvas => 3.45:1 (threshold 3.00:1)
[light] Non-text: control-border on surface => 3.86:1 (threshold 3.00:1)

stdout | tests/tokens.test.ts > WCAG Design Token Contrast Verification > light theme > matches Section 13 reference ratios within ±0.05 tolerance
[light] Reference check: ink on canvas => measured: 15.89, ref: 15.89, diff: 0.003
[light] Reference check: ink on surface => measured: 17.79, ref: 17.79, diff: 0.002
[light] Reference check: ink on surface-raised => measured: 17.05, ref: 17.05, diff: 0.004
[light] Reference check: ink-muted on canvas => measured: 5.40, ref: 5.40, diff: 0.000
[light] Reference check: ink-muted on surface => measured: 6.05, ref: 6.05, diff: 0.005
[light] Reference check: ink-muted on surface-raised => measured: 5.79, ref: 5.79, diff: 0.002
[light] Reference check: accent on canvas => measured: 8.17, ref: 8.17, diff: 0.001
[light] Reference check: accent on surface => measured: 9.15, ref: 9.15, diff: 0.002
[light] Reference check: on-accent on accent => measured: 8.17, ref: 8.17, diff: 0.001
[light] Reference check: on-accent on accent-hover => measured: 10.59, ref: 10.59, diff: 0.001
[light] Reference check: pass on canvas => measured: 5.71, ref: 5.71, diff: 0.001
[light] Reference check: pass on surface => measured: 6.39, ref: 6.39, diff: 0.001
[light] Reference check: caution on canvas => measured: 5.28, ref: 5.28, diff: 0.003
[light] Reference check: caution on surface => measured: 5.91, ref: 5.91, diff: 0.004
[light] Reference check: block on canvas => measured: 6.62, ref: 6.62, diff: 0.000
[light] Reference check: block on surface => measured: 7.41, ref: 7.41, diff: 0.001
[light] Reference check: info on canvas => measured: 6.12, ref: 6.12, diff: 0.000
[light] Reference check: info on surface => measured: 6.85, ref: 6.85, diff: 0.001
[light] Reference check: ink on pass-tint => measured: 15.06, ref: 15.06, diff: 0.003
[light] Reference check: ink on caution-tint => measured: 15.05, ref: 15.05, diff: 0.004
[light] Reference check: ink on block-tint => measured: 14.13, ref: 14.13, diff: 0.004
[light] Reference check: ink on info-tint => measured: 14.66, ref: 14.66, diff: 0.005
[light] Reference check: ink on neutral-tint => measured: 14.67, ref: 14.67, diff: 0.005
[light] Reference check: pass on pass-tint => measured: 5.41, ref: 5.41, diff: 0.000
[light] Reference check: caution on caution-tint => measured: 5.00, ref: 5.00, diff: 0.004
[light] Reference check: block on block-tint => measured: 5.89, ref: 5.89, diff: 0.003
[light] Reference check: info on info-tint => measured: 5.64, ref: 5.64, diff: 0.003
[light] Reference check: accent on canvas => measured: 8.17, ref: 8.17, diff: 0.001
[light] Reference check: accent on surface => measured: 9.15, ref: 9.15, diff: 0.002
[light] Reference check: control-border on canvas => measured: 3.45, ref: 3.45, diff: 0.000
[light] Reference check: control-border on surface => measured: 3.86, ref: 3.86, diff: 0.002

stdout | tests/tokens.test.ts > WCAG Design Token Contrast Verification > light theme > reports informational disabled control contrast ratios
[light] Informational: disabled control (ink-muted@45%) on canvas => 1.90:1
[light] Informational: disabled control (ink-muted@45%) on surface => 1.97:1
[light] Informational: disabled control (ink-muted@45%) on surface-raised => 1.95:1

stdout | tests/tokens.test.ts > WCAG Design Token Contrast Verification > dark theme > meets WCAG 4.5:1 text contrast threshold
[dark] Text: ink on canvas => 15.61:1 (threshold 4.50:1)
[dark] Text: ink on surface => 14.39:1 (threshold 4.50:1)
[dark] Text: ink on surface-raised => 13.48:1 (threshold 4.50:1)
[dark] Text: ink-muted on canvas => 7.21:1 (threshold 4.50:1)
[dark] Text: ink-muted on surface => 6.65:1 (threshold 4.50:1)
[dark] Text: ink-muted on surface-raised => 6.23:1 (threshold 4.50:1)
[dark] Text: accent on canvas => 8.41:1 (threshold 4.50:1)
[dark] Text: accent on surface => 7.75:1 (threshold 4.50:1)
[dark] Text: pass on canvas => 9.02:1 (threshold 4.50:1)
[dark] Text: pass on surface => 8.32:1 (threshold 4.50:1)
[dark] Text: caution on canvas => 9.56:1 (threshold 4.50:1)
[dark] Text: caution on surface => 8.82:1 (threshold 4.50:1)
[dark] Text: block on canvas => 7.49:1 (threshold 4.50:1)
[dark] Text: block on surface => 6.91:1 (threshold 4.50:1)
[dark] Text: info on canvas => 8.65:1 (threshold 4.50:1)
[dark] Text: info on surface => 7.97:1 (threshold 4.50:1)
[dark] Text: on-accent on accent => 8.41:1 (threshold 4.50:1)
[dark] Text: on-accent on accent-hover => 10.53:1 (threshold 4.50:1)
[dark] Text: ink on pass-tint => 12.46:1 (threshold 4.50:1)
[dark] Text: ink on caution-tint => 12.78:1 (threshold 4.50:1)
[dark] Text: ink on block-tint => 13.35:1 (threshold 4.50:1)
[dark] Text: ink on info-tint => 12.99:1 (threshold 4.50:1)
[dark] Text: ink on neutral-tint => 12.49:1 (threshold 4.50:1)
[dark] Text: pass on pass-tint => 7.20:1 (threshold 4.50:1)
[dark] Text: caution on caution-tint => 7.83:1 (threshold 4.50:1)
[dark] Text: block on block-tint => 6.41:1 (threshold 4.50:1)
[dark] Text: info on info-tint => 7.20:1 (threshold 4.50:1)

stdout | tests/tokens.test.ts > WCAG Design Token Contrast Verification > dark theme > meets WCAG 3.0:1 non-text contrast threshold
[dark] Non-text: accent on canvas => 8.41:1 (threshold 3.00:1)
[dark] Non-text: accent on surface => 7.75:1 (threshold 3.00:1)
[dark] Non-text: control-border on canvas => 4.77:1 (threshold 3.00:1)
[dark] Non-text: control-border on surface => 4.40:1 (threshold 3.00:1)

stdout | tests/tokens.test.ts > WCAG Design Token Contrast Verification > dark theme > matches Section 13 reference ratios within ±0.05 tolerance
[dark] Reference check: ink on canvas => measured: 15.61, ref: 15.61, diff: 0.002
[dark] Reference check: ink on surface => measured: 14.39, ref: 14.39, diff: 0.003
[dark] Reference check: ink on surface-raised => measured: 13.48, ref: 13.48, diff: 0.002
[dark] Reference check: ink-muted on canvas => measured: 7.21, ref: 7.21, diff: 0.003
[dark] Reference check: ink-muted on surface => measured: 6.65, ref: 6.65, diff: 0.002
[dark] Reference check: ink-muted on surface-raised => measured: 6.23, ref: 6.23, diff: 0.001
[dark] Reference check: accent on canvas => measured: 8.41, ref: 8.41, diff: 0.004
[dark] Reference check: accent on surface => measured: 7.75, ref: 7.75, diff: 0.002
[dark] Reference check: on-accent on accent => measured: 8.41, ref: 8.41, diff: 0.004
[dark] Reference check: on-accent on accent-hover => measured: 10.53, ref: 10.53, diff: 0.005
[dark] Reference check: pass on canvas => measured: 9.02, ref: 9.02, diff: 0.004
[dark] Reference check: pass on surface => measured: 8.32, ref: 8.32, diff: 0.001
[dark] Reference check: caution on canvas => measured: 9.56, ref: 9.56, diff: 0.000
[dark] Reference check: caution on surface => measured: 8.82, ref: 8.82, diff: 0.004
[dark] Reference check: block on canvas => measured: 7.49, ref: 7.49, diff: 0.001
[dark] Reference check: block on surface => measured: 6.91, ref: 6.91, diff: 0.002
[dark] Reference check: info on canvas => measured: 8.65, ref: 8.65, diff: 0.003
[dark] Reference check: info on surface => measured: 7.97, ref: 7.97, diff: 0.004
[dark] Reference check: ink on pass-tint => measured: 12.46, ref: 12.46, diff: 0.001
[dark] Reference check: ink on caution-tint => measured: 12.78, ref: 12.78, diff: 0.000
[dark] Reference check: ink on block-tint => measured: 13.35, ref: 13.35, diff: 0.002
[dark] Reference check: ink on info-tint => measured: 12.99, ref: 12.99, diff: 0.003
[dark] Reference check: ink on neutral-tint => measured: 12.49, ref: 12.49, diff: 0.001
[dark] Reference check: pass on pass-tint => measured: 7.20, ref: 7.20, diff: 0.004
[dark] Reference check: caution on caution-tint => measured: 7.83, ref: 7.83, diff: 0.002
[dark] Reference check: block on block-tint => measured: 6.41, ref: 6.41, diff: 0.003
[dark] Reference check: info on info-tint => measured: 7.20, ref: 7.20, diff: 0.005
[dark] Reference check: accent on canvas => measured: 8.41, ref: 8.41, diff: 0.004
[dark] Reference check: accent on surface => measured: 7.75, ref: 7.75, diff: 0.002
[dark] Reference check: control-border on canvas => measured: 4.77, ref: 4.77, diff: 0.005
[dark] Reference check: control-border on surface => measured: 4.40, ref: 4.40, diff: 0.003

stdout | tests/tokens.test.ts > WCAG Design Token Contrast Verification > dark theme > reports informational disabled control contrast ratios
[dark] Informational: disabled control (ink-muted@45%) on canvas => 2.39:1
[dark] Informational: disabled control (ink-muted@45%) on surface => 2.38:1
[dark] Informational: disabled control (ink-muted@45%) on surface-raised => 2.36:1

 ✓ tests/tokens.test.ts (8 tests) 30ms
 ✓ tests/source.test.ts (4 tests) 18ms

 Test Files  2 passed (2)
      Tests  12 passed (12)
   Start at  11:41:33
   Duration  505ms (transform 39%, import 28%, tests 20%, worker 13%, environment 1%)
```

### 4. Prisma Validation and Generation
```
npx prisma validate
Loaded Prisma config from prisma.config.ts.

Prisma schema loaded from prisma\schema.prisma.
The schema at prisma\schema.prisma is valid 🚀

npx prisma generate
Loaded Prisma config from prisma.config.ts.

Prisma schema loaded from prisma\schema.prisma.

✔ Generated Prisma Client (v7.10.1) to .\node_modules\@prisma\client in 109ms

Start by importing your Prisma Client (See: https://pris.ly/d/importing-client)
```

### 5. Production Build
```
npm run build

> purchase-assurance@0.1.0 build
> next build

▲ Next.js 16.4.2 (Turbopack)
✓ Running next.config.ts took 79ms
- Cache Components enabled
- Partial Prefetching enabled

  Creating an optimized production build ...
✓ Compiled successfully in 5.2s
  Running TypeScript ...
  Finished TypeScript in 5.7s ...
  Collecting page data using 6 workers ...
  Generating static pages using 6 workers (0/5) ...
  Generating static pages using 6 workers (1/5) 
  Generating static pages using 6 workers (2/5) 
  Generating static pages using 6 workers (3/5) 
✓ Generating static pages using 6 workers (5/5) in 2.3s
  Finalizing page optimization ...

Route (app)
┌ ○ /
├ ○ /_not-found
└ ○ /design

○  (Static)  prerendered as static content
```

### 6. Development Server and Manual Checks
Command: `npm run dev` (running Turbopack)
- Port 3000 was bound to an existing external process (PID 18180). Next.js automatically bound to port 3001 (`http://localhost:3001`).
- Navigation to `http://localhost:3001/`: Displays header wordmark `Purchase Assurance` and tagline `Every purchase. Proven.`. Displays Card with `Phase 0 foundation. Product workflow not yet built.`.
- Navigation to `http://localhost:3001/design`: Displays all UI primitives in every required state.
- Interactive tab navigation verified: focus outline/ring (2px solid `--accent`, 2px offset) clearly visible on buttons and inputs.
- Theme Toggle verified: clicking "Toggle Theme" changes `data-theme` attribute to `"dark"`, changing background and canvas colors immediately. Second click toggles to `"light"`. Clicking "Reset to System" removes `data-theme` attribute.
- Color verification: No hardcoded colors found anywhere in application components or routes; all colors resolve to CSS variables.

### 7. Reduced Motion
- Verified `app/globals.css` declares `@media (prefers-reduced-motion: reduce)` rules capping transitions at `120ms !important`, removing transforms on primitives, and disabling the skeleton pulse animation.

### 8. Secret Scan
```
.env.example:3 -> POSTGRES_PASSWORD=
.env.example:7 -> DATABASE_URL=
.env.example:11 -> PAYPAL_CLIENT_SECRET=
.env.example:14 -> ANTHROPIC_API_KEY=
.env.example:15 -> CHANNEL3_API_KEY=
docker-compose.yml:6 -> POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
prisma.config.ts:12 -> url: process.env["DATABASE_URL"],
README.md:21 -> Fill in `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB`.
README.md:33 -> Set `DATABASE_URL` to the local connection string in the form:
README.md:35 -> postgresql://<POSTGRES_USER>:<POSTGRES_PASSWORD>@localhost:5432/<POSTGRES_DB>
README.md:61 -> 4. Set `DATABASE_URL` in `.env.local` to this connection string. Never commit `.env.local`.
tests\source.test.ts:81 -> expect(composeContent).toContain("${POSTGRES_PASSWORD}");
tests\source.test.ts:82 -> // Ensure no hardcoded password assignments like POSTGRES_PASSWORD: mypass or POSTGRES_PASSWORD=mypass
tests\source.test.ts:83 -> const hardcodedPassMatch = composeContent.match(/POSTGRES_PASSWORD[:=]\s*(?!(\$\{POSTGRES_PASSWORD\}|\s*$))\S+/);
```
Assessment: 0 real secret values present in any file.

### 9. Schema Check
File `prisma/schema.prisma` content:
```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
}
```
Contains `provider = "postgresql"` and no references to `sqlite`.

### 10. Git Remote Check
```
git remote -v
(no output)

git status
On branch master

No commits yet

Untracked files:
  (use "git add <file>..." to include in what will be committed)
	.env.example
	.gitignore
	AGENTS.md
	README.md
	app/
	components/
	docker-compose.yml
	eslint.config.mjs
	lib/
	next.config.ts
	package-lock.json
	package.json
	prisma.config.ts
	prisma/
	public/
	tests/
	tsconfig.json

nothing added to commit but untracked files present (use "git add" to track)
```

### 11. Gate 1 Hash Comparison
Command:
```powershell
Get-FileHash -Algorithm SHA256 "C:\paypal-gate1\gate1.mjs"
Get-ChildItem C:\paypal-gate1 -Recurse -File | Get-FileHash -Algorithm SHA256
```
Output before Phase 0:
```
Algorithm  Hash                                                              Path
---------  ----                                                              ----
SHA256     F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451   C:\paypal-gate1\gate1.mjs
SHA256     F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451   C:\paypal-gate1\gate1.mjs
```
Output after Phase 0:
```
Algorithm  Hash                                                              Path
---------  ----                                                              ----
SHA256     F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451   C:\paypal-gate1\gate1.mjs
SHA256     F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451   C:\paypal-gate1\gate1.mjs
```
Comparison: Exact match. 0 files modified or accessed under `C:\paypal-gate1`.

---

## 8. Deviations

1. **Prisma 7 Config Mechanism**: In Prisma v7.10.1, datasource URLs are no longer supported inside `schema.prisma` files (yielding error `P1012`). In accordance with the Section 4 specification directive (*"If the installed Prisma version requires prisma.config.ts to hold the datasource URL, use that mechanism instead, and report the deviation"*), the datasource URL connection is configured in `prisma.config.ts` (`url: process.env["DATABASE_URL"]`) and `schema.prisma` declares `provider = "postgresql"`.
2. **Next.js 16 Build Route Manifest**: `app/design/page.tsx` calls `notFound()` when `process.env.NODE_ENV === "production"`. When prerendered by `next build`, Next.js creates the static 404 artifact (`NEXT_HTTP_ERROR_FALLBACK;404` inside `.next/server/app/design.html`), but the Next.js CLI summary table continues to display `○ /design` in its list of discovered filesystem routes.
3. **Local Dev Port Selection**: Port 3000 was bound by an existing system process (PID 18180). Next.js automatically bound development mode to port 3001. All interactive and visual checks were verified on port 3001.
4. **Node Type Version Alignment**: Dev dependency `@types/node@^22` was installed instead of `@types/node@^20` to satisfy Vitest 5's peer dependency requirement on Node 22+ without conflict, matching our active Node `v22.17.0` runtime.

---

## 9. Gate 1 Hash Comparison

- **Baseline SHA-256:** `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`
- **Post-Phase SHA-256:** `F0449D223CBB5A7150A7538712DAF6D9C8FDA845E684781F959629144BEA5451`
- **Directory Contents Match:** Yes (single file `gate1.mjs`, 4,188 bytes).
- **Match Status:** Hashes and directory listings match identically.

---

## 10. Stop-Condition Log

None. No stop conditions were triggered during implementation or verification.

---

## 11. Open Items

The following unverified items from Section 18 remain unverified as required:
- The name "Purchase Assurance" and every candidate name: not cleared. No trademark, domain, GitHub, or app-store check has been completed for any name.
- Channel3 retention of purchase-specific records: not authorised. Written confirmation has not been received.
- Devpost video trademark display rules and judge-access rules: not confirmed. Clarification has not been sent or answered.
- Render free tier availability through December 15, 2026: not verified.
- Neon free-tier suspension behaviour under the expected usage: documented but not tested.
