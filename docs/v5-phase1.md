# Video Factory V5 — Phase 1

## Scope

Phase 1 creates the TypeScript/MariaDB persistence foundation only. It does **not** implement Cloudflare Access, Admin V5, worker APIs, R2, cloud OAuth, publication execution, scheduling daemons, or deployment automation.

The working branch is `video-factory-v5`. `main` remains untouched until a reviewed pull request is explicitly approved and merged by a human.

## Database

- Runtime target: Node.js 22.x.
- Database target: Hostinger MySQL/MariaDB.
- Prisma datasource: `provider = "mysql"`.
- Phase 1 intentionally avoids advanced locking features that depend on the exact Hostinger MariaDB version.
- Worker leasing semantics are schema-only in Phase 1 and will not be implemented until Phase 4 after `SELECT VERSION()` is collected from production.

## Historical data is read-only

The importer reads, in this exact order:

1. `db/jobs/<id>.json`
2. `db/migrations/v3/<id>.json`
3. `db/migrations/v4/<id>.json`
4. `db/dashboard/<id>.json`

The merge uses the V4.2 deep-merge semantics: plain objects merge recursively; arrays, scalars, `null`, and other non-plain values replace the previous value.

The importer never writes to any of those directories.

Every imported job also receives one `legacy_imports` row containing the original layer JSON, SHA-256 for each present layer, the effective merged JSON, and an effective SHA-256. This is the loss-prevention anchor used by `legacy:verify`.

## Legacy incomplete jobs

Historical data is preserved rather than repaired. In particular, `religion-000001` has zero scenes and remains at zero scenes. It is marked `legacyIncomplete=true`; no synthetic scenes are generated.

Modern content may require exactly 16 scenes, but that invariant is not retroactively applied to historical source records.

## Idempotency

The effective SHA-256 of each merged source job is used as the import idempotency boundary.

- First run: import a job.
- Same hash on later runs: skip it without mutating normalized rows.
- Changed hash: update the same video and relations by stable unique keys; do not create a duplicate video.

Scenes use `(videoId, position)`, publications use `(videoId, platform)`, render attempts use `(videoId, attempt)`, QA results use `(videoId, attempt)`, and legacy imports use unique `videoId` constraints.

## Deferred decisions

- Worker authentication in a later phase will start with Cloudflare Access Service Token + `workerId` + an independent per-worker secret. Only a secure verification representation/hash will be stored in the database. Revoking one worker must not rotate another worker. Master-key-derived worker HMAC is deferred hardening, not the initial design.
- No `production` branch is created in Phase 1.
- No persistent scheduler daemon is implemented. Before Phase 6, Hostinger Business Web Hosting Node.js Web App support for periodic jobs must be verified. Critical scheduling must not depend on `setInterval`/`setTimeout` without lifecycle guarantees.

## Commands

```bash
npm ci
npm run prisma:validate
npm run db:migrate
npm run legacy:import
npm run legacy:verify
npm run test
npm run test:integration
npm run build
```

`legacy:verify` exits non-zero on critical data loss, missing legacy IDs, layer/hash mismatches, scene mismatches, publication mismatches, render/QA loss, or duplicate legacy identifiers.
