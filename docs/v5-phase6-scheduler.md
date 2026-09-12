# Video Factory V5 — Phase 6: Calendar, Scheduler and Durable Dispatch

Phase 6 separates **scheduling** from **publishing**. It stops at durable `PublicationDispatch(status=PENDING)`. No TikTok, YouTube or Facebook publishing API is called in this phase.

## Lifecycle boundaries

`Video` remains the production/render/QA aggregate. A failure on one social platform must not turn the whole Video into FAILED once production is approved. Distribution is represented by independent `Publication` rows for TikTok, YouTube and Facebook.

Publication lifecycle remains: `DRAFT -> READY -> SCHEDULED -> (Phase 7: PUBLISHING -> PUBLISHED/FAILED)`, plus explicit `CANCELLED`. Phase 6 never sets `PUBLISHING`.

Schedule lifecycle is now an enum: `SCHEDULED`, `DISPATCHED`, `CANCELLED`, `SUPERSEDED`. Rescheduling preserves history by marking the old schedule `SUPERSEDED` and creating a new `SCHEDULED` row. A dispatched schedule cannot be edited or cancelled by the Phase 6 admin flow.

## Time strategy

- `Schedule.scheduledAt` is an absolute UTC instant in MariaDB.
- `Schedule.timezone` stores the original IANA zone.
- default UI/server zone: `America/Mexico_City`.
- requests send `localDateTime + timezone`; browser timezone is not trusted.
- conversion uses Node 22 ECMA-402 `Intl.DateTimeFormat`/ICU IANA data, never a fixed offset such as `UTC-6`.
- conversion round-trips every candidate instant and explicitly rejects both nonexistent spring-forward times and ambiguous fall-back times. This implements the same safety policy as Temporal `disambiguation: "reject"` without adding another runtime dependency.
- tests include Mexico City, UTC, invalid zones, New York DST gaps and overlaps.

## Admin API

- `GET /api/admin/publications/:id/preflight`
- `POST /api/admin/publications/:id/schedule`
- `PATCH /api/admin/schedules/:id`
- `POST /api/admin/schedules/:id/cancel`
- `POST /api/admin/publications/:id/cancel`
- `GET /api/admin/calendar?start=&end=&platform=&status=&channelId=`

All mutations remain behind the existing Cloudflare Access Admin trust boundary, CSRF/origin guard and optimistic concurrency. Schedule mutations require `expectedVersion`; stale schedules return `409 SCHEDULE_VERSION_CONFLICT`. There is no `/api/admin/run-scheduler` endpoint.

## Publication preflight

Preflight is local/server-side only. It never calls a social network.

Blockers include:

- Video production status not compatible with distribution;
- missing current `READY` + `R2` + `VIDEO` asset;
- latest QA not approved;
- Publication already PUBLISHED/CANCELLED/PUBLISHING;
- another active schedule;
- missing platform editorial metadata;
- Video Factory internal hashtag/CTA rules from `config/publishing-rules.json`;
- for the monetization-oriented TikTok pipeline, measured duration below 61 seconds.

The hashtag counts and TikTok 61-second check are explicitly **Video Factory internal pipeline rules**, not claims about universal official platform upload limits.

Metadata may still be edited while a Schedule is `SCHEDULED`. The immutable dispatch snapshot is captured only when the schedule becomes due.

## One active schedule and audit

Schedule creation locks the Publication row with `SELECT ... FOR UPDATE`, rechecks optimistic version/preflight, verifies there is no other active Schedule, then creates the schedule and updates only that Publication to `SCHEDULED`. TikTok/YouTube/Facebook schedules are therefore independent even for the same Video.

Admin actions write `AuditLog` using actor type `ADMIN`:

- `PUBLICATION_SCHEDULED`
- `PUBLICATION_RESCHEDULED`
- `PUBLICATION_SCHEDULE_CANCELLED`
- explicit Publication cancellation also records its own audit/event.

Technical scheduling/distribution history is stored in `PublicationEvent`, avoiding artificial coupling to render-centric `JobEvent`.

## One-shot scheduler

`npm run scheduler:tick` is a CLI process. It:

1. loads server configuration;
2. connects to MariaDB;
3. generates a random UUID `schedulerRunId`;
4. atomically acquires `SchedulerLease(name="publication-dispatcher")`;
5. queries at most `SCHEDULER_BATCH_SIZE` due schedules ordered by `scheduledAt ASC, createdAt ASC`;
6. processes each schedule in its own transaction boundary;
7. releases the lease when possible;
8. disconnects and exits.

There is no `setInterval`, timer loop, node-cron process, daemon, Express scheduler endpoint or social HTTP client.

Default configuration:

- `SCHEDULER_LEASE_SECONDS=55`
- `SCHEDULER_BATCH_SIZE=50`
- optional `SCHEDULER_MAX_LATENESS_SECONDS`
- `SCHEDULE_PAST_TOLERANCE_SECONDS=60`
- optional small `SCHEDULE_MIN_LEAD_SECONDS`

A late item remains due (`scheduledAt <= now`) and is dispatched; if lateness exceeds the configured threshold, `SCHEDULE_LATE` is recorded rather than silently cancelling content.

## SchedulerLease concurrency

Lease acquisition is one atomic MariaDB `INSERT ... ON DUPLICATE KEY UPDATE` operation. An unexpired lease is not replaced and a competing tick exits cleanly without waiting. `owner` is the random scheduler run UUID, not merely the hostname. Crash safety relies on `leaseExpiresAt`; cleanup/release is helpful but not required for recovery.

## Durable dispatch queue

`PublicationDispatch` contains only operational references and an immutable server-generated snapshot:

- `publicationId`
- unique `scheduleId`
- frozen durable `assetId`
- `status` (`PENDING` in Phase 6)
- `notBefore`
- future claim fields (`claimedAt`, `claimExpiresAt`, `claimedBy`)
- `attemptCount`, `lastError`
- `payloadSnapshot`

It contains no OAuth token, refresh token, R2 signed URL or platform credential.

The unique DB constraint on `scheduleId` is the final exactly-once logical invariant. SchedulerLease reduces duplicate work; `scheduleId UNIQUE` prevents duplicate dispatch even after retries/races/lost responses.

## Dispatch transaction and snapshots

For each due Schedule the scheduler transaction re-locks/revalidates the schedule and Publication, reruns critical preflight, resolves the current durable R2 VIDEO asset, then creates `PublicationDispatch(PENDING)` and changes only `Schedule -> DISPATCHED`.

`payloadSnapshot` freezes the editorial state that will be consumed by Phase 7: platform/profile, title, caption, description, hashtags, CTA, pinned comment, durable video asset, optional cover/thumbnail asset references, schedule UTC instant and original timezone.

Later Publication edits or Video asset replacements do not mutate an existing dispatch. This prevents silent content substitution.

## Failure and crash recovery

One publication-level failure is contained to its transaction and recorded as `SCHEDULE_DISPATCH_FAILED`; safe remaining schedules continue. A single item failure therefore does not make the tick process fail systemically.

CLI exit code is non-zero only for systemic failures such as invalid config/DB/lease machinery. No-work or an acquired tick with contained publication failures can exit successfully.

Crash recovery is lease-expiry based. A dispatch committed before a crash remains protected by `scheduleId UNIQUE`; the next tick skips that logical dispatch and continues remaining due schedules.

## Calendar Admin UI

`/calendar` provides Month and Week views, server-side date-range queries and URL-backed filters for platform/status/channel. Events always display platform text, local time, title, status and timezone; styling never relies on color alone. Keyboard-accessible event buttons open a detail panel with Open Video, Edit Schedule and Cancel Schedule.

On narrow screens the grid becomes an agenda-style single-column layout. Editing date/time/timezone uses the existing unsaved-change protection and explicit 409 conflict UX. There is no Publish Now action.

Video Detail publication cards include preflight, review of the durable video/editorial metadata, Schedule/Reschedule/Cancel Schedule and a visible warning once a dispatch already exists.

## Hostinger Cron — future Phase 8 activation

Hostinger documents Cron Jobs in hPanel for Web/Cloud hosting, including custom commands, and documents cron scheduling in UTC+0. Phase 6 does **not** mutate hPanel or create a real cron job.

The future conceptual invocation is simply:

```text
npm run scheduler:tick
```

No production `/usr/bin/node`, home directory or deployment path is guessed here. Those paths and the exact hPanel command are verified against the real Hostinger environment in Phase 8. Because database schedules are stored as UTC instants, Hostinger cron's UTC+0 scheduler does not change the intended publication instant.

## Security boundary

- scheduler is server-side CLI, not HTTP;
- no Cloudflare Access bypass is needed or added;
- no arbitrary shell parameters are built from Calendar data;
- structured tick logs include run IDs/counts and item identifiers, not captions/tokens/signed URLs;
- server secrets remain server-side and are not printed;
- no social-domain dependency or `fetch()` exists in scheduler code.

## Phase 7 boundary

Phase 6 stops at `PublicationDispatch(PENDING)`. Phase 7 may later claim dispatches, resolve server-side credentials and transition Publication to PUBLISHING/PUBLISHED/FAILED. TikTok Direct Post, YouTube `videos.insert`, Facebook publishing, OAuth refresh and metrics sync are intentionally absent here.
