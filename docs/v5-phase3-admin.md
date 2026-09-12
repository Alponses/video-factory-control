# Video Factory V5 — Phase 3 Admin

Phase 3 adds a real React + TypeScript + Vite administrative application in `admin/` while preserving `dashboard/` unchanged as the V4.2 fallback.

## Architecture

Browser → same-origin `/api/admin/*` → Express → MariaDB.

The Admin V5 browser never receives GitHub PATs, database credentials, platform refresh tokens, client secrets, Cloudflare secrets or R2 credentials. There is no application login, application session cookie or custom admin JWT. Cloudflare Access remains the authentication boundary and the Phase 2 backend continues validating `Cf-Access-Jwt-Assertion` cryptographically.

## Frontend routes

- `/` — MariaDB-backed dashboard.
- `/videos` — server-side search, status/category filters and pagination. Filter state remains in query parameters.
- `/videos/:videoId` — full video detail with summary, content editing, scenes, assets, Render/QA, publication metadata, metrics and history tabs.

The production Express SPA fallback applies only to non-API GET routes. `/api/*` always keeps API semantics and never returns `index.html`.

## New Phase 3 API

- `GET /api/admin/me` derives the displayed email from the already verified Access JWT.
- `GET /api/admin/videos/:id/history` combines redacted AuditLog entries and JobEvent lifecycle entries.
- `PATCH /api/admin/publications/:id` edits only editorial fields: title, caption, description, hashtags, CTA and pinned comment. Platform IDs, URLs, published timestamps and status are not writable.

Publication edits use `expectedVersion`, atomic optimistic concurrency and transactional AuditLog writes. Conflicts return `409 PUBLICATION_VERSION_CONFLICT`.

## Development

Install both dependency sets:

```bash
npm ci
npm --prefix admin install --no-audit --no-fund --package-lock=false
```

Run the API and UI in separate terminals:

```bash
npm run dev:server
npm run dev:admin
```

Vite proxies `/api` to the local Express process so browser requests remain same-origin to the dev UI. Phase 3 intentionally adds no auth bypass. A direct local browser will still receive 401 unless its request reaches the backend with a valid Cloudflare Access JWT (for example through an Access-protected development route/tunnel). Test JWTs remain cryptographic test fixtures only.

## Production build

```bash
npm run build
NODE_ENV=production node dist/src/index.js
```

`npm run build` runs `build:server` and `build:admin`. The Admin bundle is emitted to `admin/dist`. In production Express requires that build and serves it as static assets plus history-API SPA fallback.

Production CSP:

```text
default-src 'self';
script-src 'self';
style-src 'self';
img-src 'self' data:;
connect-src 'self';
font-src 'self';
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'none'
```

No production `unsafe-inline` or `unsafe-eval` is used. Vite development alone permits inline styles because HMR injects CSS during development.

## UX and safety

- Natural document scroll; no global `overflow: hidden`.
- Sticky desktop navigation; mobile drawer without locking document scroll.
- Explicit loading, empty, error and success states.
- StatusBadge and LifecycleProgress use text/symbols in addition to color.
- Video, scene and publication edits use View → Edit → Save/Cancel; no autosave.
- 409 conflicts never auto-retry or overwrite newer data. The UI offers reload latest, cancel and copy unsaved changes.
- SPA navigation and hard reloads warn when unsaved edits exist.
- `religion-000001` remains legacy incomplete and displays zero scenes.
- Legacy assets are read-only; cloud assets remain Phase 5.
- Render/QA is read-only; worker and re-render controls remain Phase 4.
- Metrics render only stored values; empty state is `No metrics collected yet.`

## Responsive/accessibility

Semantic headings, labels and buttons are used. Keyboard focus has a visible outline, the shell includes a skip link, status does not rely only on color, tables have explicit horizontal handling and switch to cards on smaller displays. Primary content uses routes instead of modal-only navigation, so no application modal focus trap is required in Phase 3.

## Deferred

No workers, leases, R2, uploads, scheduler/cron, external publishing, platform OAuth, Hostinger deployment or production Cloudflare configuration are implemented here. `trust proxy = 1` remains an explicit production blocker for Phase 8 validation and is not used for authorization.

ESLint 9.39.x is in maintenance/out-of-support territory while ESLint 10 is current. Because that is a major-version tooling migration and Phase 3 does not require it, the upgrade is intentionally deferred rather than mixed into the Admin V5 implementation.
