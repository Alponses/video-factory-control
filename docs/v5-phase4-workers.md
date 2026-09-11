# Video Factory V5 — Phase 4 distributed workers

Phase 4 adds authenticated outbound-only Mac workers, transactional job leasing, local rendering through the existing `short-video-maker` renderer, ffprobe QA, idempotent finalization, Admin worker operations, and queue/re-render controls. Phase 4 deliberately does **not** add R2, publishing, scheduler execution, cloud OAuth, or Hostinger deployment.

## Architecture

The control plane remains the source of truth in MariaDB. Admin browsers talk only to same-origin `/api/admin/*`. A worker talks outbound to the control plane over HTTPS and to its renderer over loopback HTTP. The worker never accepts inbound Internet traffic.

```text
Admin browser
  -> Cloudflare Access (Admin policy / Admin AUD)
  -> factory origin
  -> /api/admin/*
  -> MariaDB

Mac worker
  -> Cloudflare Access Service Auth (worker-specific Service Token)
  -> factory origin
  -> /api/worker/*
       1. validate Cf-Access-Jwt-Assertion against worker AUD
       2. validate X-Worker-Id + internal Bearer worker secret
  -> MariaDB

Mac worker
  -> http://127.0.0.1:3123
  -> existing short-video-maker renderer
  -> local MP4
  -> ffprobe QA
```

The renderer is **not** exposed publicly and is not started or stopped by the worker.

## Trust boundaries and authentication

Admin and worker traffic have separate trust boundaries.

### Admin

`/api/admin/*` uses the existing Cloudflare Access Admin application/audience plus the exact Admin email allowlist. Phase 4 does not add a second application login, session, cookie, or custom Admin JWT.

### Worker

`/api/worker/*` requires both layers:

1. a cryptographically valid Cloudflare Access JWT in `Cf-Access-Jwt-Assertion`, signed by the configured Cloudflare account, with the configured issuer and `CLOUDFLARE_WORKER_ACCESS_AUD`;
2. `X-Worker-Id` plus `Authorization: Bearer <internal worker secret>`.

Admin AUD is rejected by worker routes and worker AUD is rejected by Admin routes. Test/development mode does not bypass either verification layer.

## Cloudflare Service Auth production plan

No real Cloudflare credential is created in Phase 4. For production, create one Service Token **per machine** in Zero Trust:

- `video-factory-imac-01`
- `video-factory-macbook-01`

Cloudflare dashboard path:

`Zero Trust -> Access controls -> Service credentials -> Service Tokens`

Protect:

`factory.norvian.io/api/worker/*`

Use a policy with action **Service Auth**. Each worker stores its own Cloudflare Service Token only on that local machine and sends:

- `CF-Access-Client-Id`
- `CF-Access-Client-Secret`

Cloudflare Access authenticates those credentials at the edge and forwards a signed `Cf-Access-Jwt-Assertion` to the origin. The origin still validates signature, issuer and the worker application AUD using the account JWKS. A normal production worker therefore does not need to manufacture or self-sign the Access JWT.

Cloudflare documents that a Service Token Client Secret is displayed only at creation/rotation time. Treat it as a one-time credential and never commit it to Git.

## Internal worker secret

The internal credential is separate from the Cloudflare Service Token.

Creation produces a secret with the form:

`vfws_<base64url random bytes>`

The server uses 32 cryptographically random bytes (256 bits). Only a domain-separated SHA-256 digest is stored in MariaDB. Authentication hashes the presented secret and compares the fixed-length digest using `timingSafeEqual`.

The plaintext internal secret is returned only by:

- worker creation;
- explicit secret rotation.

`GET /api/admin/workers` never returns plaintext secret or `secretHash`.

Rotation increments `secretVersion` and immediately makes the previous internal secret invalid. Revoke sets the worker to `DISABLED`; enable returns it to `OFFLINE` without changing the current internal secret.

## Worker provisioning

1. Admin opens `/workers`.
2. Create `imac-01` or another lowercase/hyphen worker ID.
3. Copy the one-time secret immediately.
4. Store it only in the worker's local protected environment/secret store.
5. Configure the worker ID and control-plane URL.
6. In future production, also configure that machine's Cloudflare Service Token ID/secret.

The React Admin keeps the displayed one-time secret only in component memory. It is not written to URL, localStorage, sessionStorage, IndexedDB, MariaDB plaintext, or AuditLog.

## Worker environment

Representative local values:

```bash
VIDEO_FACTORY_URL=http://127.0.0.1:3000
WORKER_ID=imac-01
WORKER_SECRET=<one-time internal secret>
RENDERER_URL=http://127.0.0.1:3123
OUTPUT_DIR=./output
```

Future production adds:

```bash
VIDEO_FACTORY_URL=https://factory.norvian.io
CF_ACCESS_CLIENT_ID=<worker-specific Service Token client ID>
CF_ACCESS_CLIENT_SECRET=<worker-specific Service Token client secret>
```

`CF_ACCESS_JWT_ASSERTION` exists only for controlled direct-origin/test scenarios. In the normal Cloudflare production path, Access supplies the assertion to the origin after Service Auth.

## Heartbeat and effective status

The worker sends heartbeat independently of job claiming. Heartbeat records agent version, renderer version, current job context, progress and a safe last error.

Effective worker state is computed centrally by the backend using `WORKER_OFFLINE_THRESHOLD_SECONDS`:

- `DISABLED`: explicitly revoked;
- `BUSY`: worker has a server-owned current video;
- `OFFLINE`: no heartbeat or heartbeat older than the threshold;
- `ONLINE`: recent heartbeat and no current job.

The Admin consumes this effective state. React does not duplicate the offline threshold.

Renderer health and worker liveness are intentionally different. If the renderer is down, heartbeat continues with `lastError=RENDERER_OFFLINE`; the worker remains visible but does not claim work. When renderer health returns, claiming resumes.

## Queue and re-render

Admin operations are versioned and transactional.

Initial Queue Render is allowed only from `DRAFT` or `READY`.

Re-render is allowed initially only from:

- `FAILED`;
- `APPROVED`.

`PUBLISHED` is rejected by default. Active valid leases and active `RUNNING`/`QA` attempts reject a new queue operation. Stale `expectedVersion` returns 409 rather than overwriting newer state.

Both operations write a JobEvent and AuditLog in the same transaction as the Video status/version update.

## Claim algorithm and MariaDB transaction

Claims run inside a Prisma transaction using MariaDB/InnoDB `READ COMMITTED`.

High-level algorithm:

1. expire one abandoned lease if necessary;
2. lock the requesting worker using `SELECT ... FOR UPDATE`;
3. ensure the worker is enabled and not already busy;
4. select the oldest `QUEUED` video with `SELECT ... FOR UPDATE` **inside the same transaction**;
5. verify no still-valid unreleased lease owns that video;
6. allocate the next immutable RenderAttempt number;
7. generate a random lease token;
8. store only the lease token hash;
9. create WorkerLease;
10. move Video to `RENDERING`;
11. write `RENDER_CLAIMED` JobEvent;
12. mark the worker `BUSY` with `currentVideoId`.

The transaction boundary is essential. The locked SELECT is not issued in autocommit and followed by unrelated updates.

## Lease token and renewal

A lease token uses at least 32 random bytes and is returned only to the claiming worker. MariaDB stores only a domain-separated SHA-256 hash.

Progress, renew, complete and fail require:

- current worker identity;
- matching current worker;
- matching lease-token hash;
- non-expired unreleased lease;
- latest RenderAttempt owned by that worker and still active.

Renew extends `leaseExpiresAt` only for a valid non-expired lease. Expired leases cannot be resurrected by renew.

## Lease expiration, reclaim and stale-worker protection

When a lease is expired and still unreleased, the next claim transaction finalizes the abandoned attempt as `FAILED` with `LEASE_EXPIRED`, releases that lease, requeues the Video, writes `LEASE_EXPIRED_REQUEUED`, and clears the old worker's job context.

The historical attempt remains intact. A new worker creates attempt `N+1`; it never overwrites attempt `N`.

After reclaim, the old worker cannot progress, renew, complete or fail the job because it no longer owns the current lease. This protects the control plane from a delayed or partitioned old agent.

## RenderAttempt lifecycle

A normal successful lifecycle is:

`RUNNING -> QA -> SUCCEEDED`

A worker/renderer failure ends at `FAILED`. An expired lease also ends the abandoned attempt at `FAILED` with error `LEASE_EXPIRED` because the current enum has no separate TIMED_OUT/ABANDONED state.

Every attempt has its own `(videoId, attempt)` identity and remains visible in Admin history.

## Renderer contract

Phase 4 uses the already verified `short-video-maker` REST contract only:

- `GET /health`
- `POST /api/short-video`
- `GET /api/short-video/:id/status`
- `GET /api/short-video/:id`

No new renderer endpoint is invented. The renderer repository is not modified.

Local renderer startup already validated for this project:

```bash
cd ~/video-factory/renderer
pnpm dev
```

The worker checks renderer health before claiming but never starts or kills the renderer process.

## Renderer timeouts

The renderer client applies an AbortController timeout to the **whole operation**, not just receipt of HTTP headers. The timeout remains active while parsing health/create/status response bodies and while consuming the MP4 body stream. A server that sends headers and then stalls cannot keep the worker blocked indefinitely.

## QA with ffprobe

The worker downloads the finished MP4 locally and runs `ffprobe`.

Minimum Phase 4 acceptance:

- duration `>= 61.0` seconds;
- exact `1080x1920` video resolution;
- at least one audio stream.

Boundary behavior:

- `60.9s` -> duration fail;
- `61.0s` -> duration pass;
- `75s` -> duration pass;
- `1079x1920` -> resolution fail;
- `1080x1919` -> resolution fail;
- `1080x1920` -> resolution pass;
- no audio -> audio fail;
- audio stream present -> audio pass.

Caption correctness cannot currently be proven reliably from the output container, so `captionsPassed=null` means **unknown**, not failure. Overall pass requires duration, exact resolution and audio; unknown captions do not force failure.

## Idempotent complete/fail

Complete and fail require `Idempotency-Key`.

The control plane scopes a key to worker + video + operation and stores a canonical request hash plus the logical response. Repeating the same key with the same payload returns the same logical result without creating a second QA row, JobEvent, release, transition or RenderAttempt. Reusing the same key with a different payload returns `409 IDEMPOTENCY_CONFLICT`.

The worker performs a bounded retry for transient/network/timeout failure and reuses the **same** Idempotency-Key for every retry. It does not generate a new key after an uncertain response.

## Complete/fail transactions

Complete atomically updates:

- RenderAttempt;
- QaResult;
- WorkerLease;
- Video;
- JobEvent;
- Worker;
- IdempotencyKey.

Fail atomically updates the corresponding failure state, releases the lease, changes Video, writes JobEvent, clears Worker job context, and stores idempotency result.

If any write fails, MariaDB rolls the transaction back. Phase 4 integration tests force a failure at the final IdempotencyKey insert to prove that earlier attempt/QA/lease/video/event/worker changes do not leak out as a partial state.

## Graceful shutdown

SIGINT/SIGTERM stop new claims and heartbeat timers. The worker stops renewing once its current execution unwinds and exits without starting or killing the renderer. Server-side lease expiry/reclaim is the safety mechanism for a worker that disappears mid-job.

## Local MP4 and why R2 is Phase 5

The MP4 remains on the Mac filesystem in Phase 4. The worker reports only a logical local reference such as:

`worker-output/religion-000011-attempt-1.mp4`

This is **not** treated as a public URL. No AWS SDK, S3-compatible client, presigned URL or R2 upload is part of Phase 4. Durable object storage and upload authorization belong to Phase 5.

## Reproducible local demo

This demo keeps both authentication layers; there is no auth bypass.

1. Start MariaDB-backed V5 control plane with test/local Cloudflare-signed JWT fixture or an actual Access-protected environment.
2. In Admin `/workers`, create `imac-01` and copy the one-time internal secret.
3. Configure `WORKER_ID=imac-01` and `WORKER_SECRET` locally.
4. Start the existing renderer with `pnpm dev` in `~/video-factory/renderer`.
5. Confirm `GET http://127.0.0.1:3123/health` succeeds.
6. Start the Node 22 worker.
7. Heartbeat appears and Admin shows `imac-01` ONLINE.
8. Queue an eligible video from Admin.
9. Worker sees healthy renderer and claims the job.
10. MariaDB records lease + RenderAttempt #1 and Admin shows BUSY/progress.
11. Renderer creates the video through the verified REST contract.
12. Worker downloads MP4 locally.
13. `ffprobe` validates duration/resolution/audio.
14. Worker reports QA and complete with an idempotency key.
15. MariaDB atomically moves the video to `APPROVED` on QA pass.
16. Admin Render / QA shows the completed attempt and QA values.

Offline path:

1. Stop the local renderer manually.
2. Worker heartbeat continues.
3. Admin shows `lastError=RENDERER_OFFLINE`.
4. Worker performs no claim.
5. Restart renderer manually.
6. Health becomes good and normal claim flow resumes.

## Real iMac setup

On the real iMac, keep credentials outside Git and readable only by the local account running the worker. The intended shape is:

```bash
cd ~/video-factory/renderer
pnpm dev

# second terminal/service
cd <video-factory-control>/worker
npm ci
npm run build
node dist/src/index.js
```

For future Cloudflare production, add only the Service Token belonging to that iMac. Do not share the MacBook Service Token with the iMac or vice versa.

## Secret and log redaction

Server logging recursively redacts secret/token/authorization/password/database URL fields. The local worker logger uses a strict allowlist of operational fields instead of serializing arbitrary request/config objects.

Logs and AuditLog must never contain:

- `WORKER_SECRET` or plaintext internal worker secret;
- worker `secretHash`;
- Authorization Bearer value;
- `CF-Access-Client-Secret`;
- `Cf-Access-Jwt-Assertion`;
- lease token or lease-token hash;
- `DATABASE_URL`.

Worker create/rotate/revoke AuditLog records only safe status/version information.

## Known Phase 4 limitations

- MP4 durability is local-machine only until Phase 5.
- Caption verification is unknown (`null`) rather than proven.
- Renderer process supervision remains external/manual.
- There is no scheduler/cron execution in Phase 4.
- There is no social publishing or platform OAuth in Phase 4.
- No production Cloudflare tokens, DNS or Hostinger deployment are created in Phase 4.
- Lease expiry maps to existing `RenderAttemptStatus.FAILED` because the current schema does not introduce a dedicated TIMED_OUT/ABANDONED enum.
