# Video Factory V5 — Phase 2 Security Foundation

## Scope

Phase 2 adds the secure HTTP/API foundation on top of the Phase 1 MariaDB model. It does not implement the full Admin V5 UI, worker protocol/leasing, R2/uploads, scheduler, publishing, cloud OAuth, Facebook integration, DNS, Cloudflare production configuration, or Hostinger deployment.

The historical JSON directories remain read-only. Phase 2 reads and writes operational data only through Prisma/MariaDB.

## Request lifecycle

For API traffic the application applies, in order:

1. Generate a random `requestId` and return it as `X-Request-Id`.
2. Add security headers.
3. Enforce same-origin CORS policy when an `Origin` header is present.
4. Start structured request logging.
5. Parse JSON with an explicit 1 MB limit.
6. `/api/health/*` is handled without admin authentication.
7. `/api/admin/*` validates the Cloudflare Access JWT cryptographically.
8. Enforce the exact administrator email allowlist.
9. Apply application-side rate limits.
10. For POST/PUT/PATCH/DELETE, apply the browser mutation/CSRF guard.
11. Validate params/query/body with Zod and execute Prisma operations.
12. Return errors through the common API error model.

## Cloudflare Access validation

Production mode expects `Cf-Access-Jwt-Assertion` and validates it with `jose` using the team JWKS endpoint:

`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`

Validation includes:

- cryptographic signature;
- expected issuer;
- expected audience;
- token expiration.

The administrator identity is taken only from the verified JWT `email` claim. Email authorization uses exact, lower-cased comparison against `ADMIN_ALLOWED_EMAILS`. Wildcards, suffix matching and substring matching are not supported.

Production fails closed if the Cloudflare team domain or audience is missing, if `APP_BASE_URL` is not HTTPS, or if test auth mode is selected.

### Local/CI strategy

Tests do not bypass authentication based on `NODE_ENV`. `CLOUDFLARE_AUTH_MODE=test` requires an explicitly injected key resolver. The test suite generates an RSA key pair, exposes only the public JWK to the middleware, signs test JWTs with the private key, and verifies missing, malformed, forged, expired, wrong-issuer, wrong-audience, forbidden-email and allowed-email cases.

No real Cloudflare credentials are required in Phase 2.

## CORS

The Admin API is designed to be same-origin with the future frontend. There is no wildcard CORS.

- No `Origin`: acceptable for non-browser/server health/read clients, subject to route auth.
- Exact `Origin == APP_BASE_URL.origin`: accepted.
- Any other origin: `403 CORS_ORIGIN_FORBIDDEN`.
- Preflight responses only echo the exact configured origin.

## CSRF / browser mutation protection

Cloudflare Access is authentication, not CSRF protection.

For `POST`, `PUT`, `PATCH` and `DELETE`, Phase 2 requires:

- exact `Origin == APP_BASE_URL.origin`;
- when `Sec-Fetch-Site` is present, it must be `same-origin`;
- `Content-Type: application/json`.

GET endpoints have no side effects.

Phase 2 does not introduce an application session cookie, so a synchronizer-token lifecycle would add state without protecting an additional application session. If Phase 3 introduces an application-owned browser session/cookie, CSRF must be reviewed again and a synchronizer-token or cookie-to-header design added before that session is used for mutations.

## Security headers

Every response receives:

- `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
- `X-Content-Type-Options: nosniff`;
- `Referrer-Policy: no-referrer`;
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`;
- `X-Frame-Options: DENY` as compatibility defense in depth.

HSTS is emitted only when running in production with an HTTPS `APP_BASE_URL`, avoiding accidental HSTS behavior during local HTTP development.

## Request body limits

Normal JSON bodies are capped at 1 MB. Video/audio/assets are intentionally not accepted through this API. Large binary transfers remain deferred to Phase 5 R2 presigned URLs.

## Validation

Zod validates IDs, pagination, search/filter input, optimistic-concurrency versions, mutable video fields, scene text and scene search terms. Request bodies use strict allowlists; unknown fields are rejected.

## Optimistic concurrency

Video and scene writes require `expectedVersion`.

The mutation itself uses one atomic conditional update:

`WHERE id = ? AND version = expectedVersion`

(or `videoId + position + version` for scenes) and increments the version in that same write. A zero-row update becomes `409 VIDEO_VERSION_CONFLICT` or `409 SCENE_VERSION_CONFLICT`.

The implementation never performs a version read followed by an unconditional update.

## Audit logging

Successful video and scene edits insert an `AuditLog` row containing:

- `actorType=ADMIN`;
- verified administrator email;
- action;
- entity/entityId;
- before snapshot;
- after snapshot;
- requestId;
- timestamp from MariaDB/Prisma.

Mutation and audit insert are part of the same Prisma transaction. If audit creation fails, the mutation rolls back. JWTs, authorization headers and secrets are never included in audit data.

## Structured logging and redaction

HTTP completion logs are one-line JSON containing timestamp, level, requestId, method, route/path, statusCode, durationMs and verified actor information when available.

The redactor removes values for keys matching authorization, cookies, Cloudflare Access JWTs, tokens, access/refresh tokens, client secrets and database URLs. MySQL/MariaDB URL-shaped string values are also redacted. Environment objects, request bodies and request headers are not dumped.

## Rate limiting and proxy trust

The admin read limit is 120 requests/minute per authenticated administrator and the mutation limit is 60 requests/minute per authenticated administrator. This Phase 2 implementation is process-local; distributed rate limiting can be evaluated only if the production topology later requires multiple application instances.

Express currently uses `trust proxy = 1`, representing one immediate hosting reverse-proxy hop. This is not used as an authorization primitive: administrator rate limits key from the verified email. Before production deployment, Phase 8 must verify Hostinger's actual proxy path and confirm that the trusted hop overwrites untrusted `X-Forwarded-*` values. Do not change this setting to `true` without that verification.

## Error model

All API errors use:

```json
{
  "error": {
    "code": "VIDEO_NOT_FOUND",
    "message": "Video was not found",
    "requestId": "..."
  }
}
```

Production responses do not include stack traces.

## Implemented endpoints

- `GET /api/health/live`
- `GET /api/health/ready`
- `GET /api/admin/dashboard`
- `GET /api/admin/videos`
- `GET /api/admin/videos/:id`
- `PATCH /api/admin/videos/:id`
- `PATCH /api/admin/videos/:id/scenes/:position`

No `/api/worker/*`, `/api/assets/*` or `/api/oauth/*` routes exist in Phase 2.

## Health semantics

`live` proves that the process can answer HTTP.

`ready` executes a MariaDB `SELECT 1`. Critical configuration is validated before the Express app can start, so an instance with invalid production configuration never reaches a state where `ready` can return success.

## Scheduler note for Phase 6

No scheduler is implemented in Phase 2. Hostinger Web/Cloud Hosting documents hPanel Cron Jobs and allows unlimited cron jobs on Premium and higher plans. Phase 6 must still test the exact interaction with a Hostinger Node.js Web App and choose between invoking a Node script and calling a protected HTTP endpoint. Critical scheduling must not use `setInterval`/`setTimeout` as a substitute for that verified mechanism.

## Phase 2 CI

CI continues to run all Phase 1 legacy checks and adds the Phase 2 unit/auth/security and MariaDB Admin API integration tests. Cloudflare tests use local cryptographic fixtures; MariaDB tests run against a real MariaDB service container, never SQLite.
