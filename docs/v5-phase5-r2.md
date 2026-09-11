# Video Factory V5 — Phase 5 private R2 durable assets

Phase 5 makes Cloudflare R2 the durable object store for new production assets while MariaDB remains the metadata/source-of-truth database. It does **not** add social publishing, social OAuth, scheduler execution, Hostinger deployment, public buckets, public custom domains, or Phase 6 features.

## Architecture

```text
Mac worker
  -> local short-video-maker renderer
  -> local MP4
  -> ffprobe QA
  -> Video Factory API: create authorized upload session
  -> presigned R2 operation
  -> direct PUT/multipart to private R2
  -> Video Factory API: finalize
       -> HeadObject verifies size + MIME
       -> VideoAsset READY
  -> Video Factory API: complete job with outputAssetId
       -> verifies current worker/lease/attempt + durable READY R2 asset
       -> Video APPROVED

Admin browser
  -> Cloudflare Access
  -> same-origin /api/admin/* control requests
  -> receives short-lived object-specific presigned R2 URL
  -> direct PUT to private R2 (XMLHttpRequest only for upload progress)
  -> same-origin finalize request
```

The normal binary path is **worker/browser -> R2**. MP4/image bytes do not normally traverse the Hostinger Node process.

## Private bucket and storage class

Create one **private** Cloudflare R2 bucket. The bucket name is supplied only through `R2_BUCKET`; code does not hardcode the production name.

Use **Standard** storage initially. Do not use Infrequent Access for Phase 5 because uploads will be reviewed, previewed and later published.

Do not enable:

- public `r2.dev` access;
- anonymous GET;
- public bucket access;
- a custom public R2 domain.

Objects are accessed only through authenticated Video Factory control-plane requests that mint short-lived presigned operations.

## Server-side environment

```bash
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=
R2_ENDPOINT=
R2_PRESIGN_TTL_SECONDS=300
R2_SINGLE_UPLOAD_THRESHOLD_BYTES=104857600
R2_MULTIPART_PART_SIZE_BYTES=16777216
```

When `R2_ENDPOINT` is omitted, Video Factory derives:

```text
https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com
```

The AWS SDK v3 client uses:

- `region: "auto"`;
- the configured R2 S3 endpoint;
- explicit server-side R2 credentials;
- no global AWS credential chain.

Production fails closed when R2 credentials are absent or partially configured.

## Least-privilege production token

Cloudflare Dashboard flow (documented only; Phase 5 does not execute it):

1. Cloudflare Dashboard -> R2 Object Storage -> Create bucket.
2. Keep the bucket private and use Standard storage.
3. Create an R2 API token.
4. Grant **Object Read & Write**.
5. Scope the token to **only the Video Factory bucket**.
6. Copy the Access Key ID and Secret Access Key into the server secret environment.

Do not grant account-wide Admin Read & Write when bucket-scoped Object Read & Write is sufficient. Never commit the Access Key ID/Secret Access Key to Git, put them in MariaDB, browser code, worker configuration or logs.

## Workers do not receive permanent R2 credentials

`imac-01`, `macbook-01` and future render workers receive only temporary presigned operations. Worker configuration adds only:

```bash
R2_UPLOAD_MAX_RETRIES=3
DELETE_LOCAL_AFTER_DURABLE_UPLOAD=false
```

Workers do **not** receive `R2_ACCESS_KEY_ID` or `R2_SECRET_ACCESS_KEY`.

## Browser does not receive permanent R2 credentials

The Admin browser receives only:

- upload session ID;
- asset ID;
- upload mode;
- short-lived presigned URL(s);
- required headers;
- expiry;
- multipart part size when applicable.

Long-lived Cloudflare/R2 credentials never enter browser state or responses.

## Presigned URLs are bearer credentials

Treat every presigned URL as a bearer token: anyone who obtains it can perform the signed operation until expiry.

Default URL TTL is **300 seconds**. Server configuration bounds it to a short interval and URLs are generated on demand. Presigned URLs are never stored in:

- MariaDB;
- AuditLog;
- JobEvent;
- application logs;
- localStorage/sessionStorage/IndexedDB;
- browser query parameters.

The server stores only stable identifiers, bucket/object key metadata and upload-session state.

## URL/log redaction

Structured logging redacts fields such as:

- `presignedUrl`;
- `uploadUrl`;
- `downloadUrl`;
- `X-Amz-Signature`;
- `X-Amz-Credential`;
- `X-Amz-Security-Token`;
- authorization/token/secret/password fields.

If a signed URL appears inside a generic string field, its R2 signing query is stripped before logging. Full signed R2 URLs must not be printed.

## Server-generated immutable object keys

Clients never choose an R2 object key. Original filenames are metadata only and do not participate in path construction.

Video asset shape:

```text
channels/{channelId}/videos/{videoId}/assets/{assetId}/video.mp4
channels/{channelId}/videos/{videoId}/assets/{assetId}/cover.webp
channels/{channelId}/videos/{videoId}/assets/{assetId}/thumbnail.webp
channels/{channelId}/videos/{videoId}/assets/{assetId}/audio.mp3
```

Profile asset shape:

```text
channels/{channelId}/profiles/{profileId}/assets/{assetId}/avatar.webp
channels/{channelId}/profiles/{profileId}/assets/{assetId}/banner.webp
```

The actual extension follows the validated MIME type. Username, email, display name and filename never become trusted path segments.

Every upload creates a new `assetId` and therefore a new object key. Replacement never PUTs over an old object.

## VideoAsset and Profile ownership

Phase 5 reuses `VideoAsset`. It adds nullable `profileId` while preserving nullable `videoId` for historical compatibility.

Application rules:

- `VIDEO`, `COVER`, `THUMBNAIL`, `AUDIO` belong to a Video;
- `AVATAR`, `BANNER` belong to a Profile;
- legacy `LEGACY_LOCAL` records are preserved unchanged;
- R2 assets use `storageProvider="R2"`, configured `bucket`, server-generated `objectKey`, and no required `localPath`.

Profile ownership is relational, so TikTok, YouTube and Facebook can maintain distinct avatar/banner slots.

## AssetUploadSession

Issuing a presigned URL does **not** make an asset READY. Phase 5 persists `AssetUploadSession` with:

- asset and actor ownership;
- worker/render-attempt relationship where applicable;
- SINGLE or MULTIPART mode;
- expected MIME/size and optional asserted SHA-256;
- R2 multipart upload ID server-side;
- expiry/timestamps;
- lifecycle state (`CREATED`, `UPLOADING`, `FINALIZING`, `COMPLETED`, `ABORTED`, `EXPIRED`, `FAILED`).

A session normally lives longer than an individual signed URL so a client can request a fresh URL without creating another asset or re-rendering.

## MIME policy

Server allowlist:

- VIDEO: `video/mp4`;
- COVER / THUMBNAIL / AVATAR / BANNER: `image/jpeg`, `image/png`, `image/webp`;
- AUDIO: `audio/mpeg`, `audio/wav`, `audio/x-wav`.

The default policy rejects HTML, JavaScript and SVG. SVG is intentionally deferred because it can carry active content.

For single PUT, the presigned request signs `Content-Type`; the direct client must send the same value.

## Application size limits

Central server policy:

- VIDEO: maximum 2 GiB;
- IMAGE: maximum 20 MiB;
- AUDIO: maximum 200 MiB.

These are application limits and do not rely on R2 maximum object size.

## Single upload

When size is `<= R2_SINGLE_UPLOAD_THRESHOLD_BYTES` (default 100 MiB):

1. authenticated actor requests an upload session;
2. server creates `VideoAsset(PENDING)` + session and generates a new immutable key;
3. server returns a presigned `PutObject` URL with signed `Content-Type`;
4. browser/worker PUTs directly to R2;
5. client calls finalize;
6. server executes `HeadObject`;
7. server verifies existence, bucket/key association, `ContentLength` and `ContentType`;
8. only then does the transaction mark the new asset READY and the previous current slot REPLACED.

## Multipart upload

When size exceeds the single threshold:

1. server creates an R2 multipart upload and stores its upload ID only in `AssetUploadSession`;
2. client asks for a small set of part numbers;
3. server validates ownership and requested part numbers;
4. server signs `UploadPart` operations only for those parts;
5. client uploads directly to R2 and keeps each returned `ETag`;
6. client submits ordered `(partNumber, ETag)` values;
7. server calls `CompleteMultipartUpload`;
8. server executes `HeadObject` and performs the same size/MIME validation before READY.

Default part size is **16 MiB** and configuration refuses values below R2's 5 MiB minimum. Part numbers must be 1..N, and Video Factory never generates 10,000 URLs in advance.

### ETag is not SHA-256

R2/S3 ETag semantics differ for multipart uploads. Video Factory never copies ETag into `VideoAsset.sha256` and never claims that ETag is a cryptographic SHA-256 verification.

## Abort

Explicit cancellation of a multipart session calls `AbortMultipartUpload`, marks the session ABORTED, and marks its pending asset FAILED. A completed upload cannot be aborted. Failed replacement uploads never disturb the previous READY slot.

## SHA-256 semantics

Workers calculate SHA-256 locally from the rendered MP4 and send it as expected metadata. On successful finalize it is stored with `hashSource="WORKER"`.

Admin/browser hashes, when supplied in future/browser code, are client assertions and must be identified as `BROWSER_ASSERTED` unless the server actually recomputes the file. Phase 5 does not download every object through Hostinger just to recompute hashes.

`HeadObject` validates object existence, size and MIME; it does not independently prove the worker's SHA-256.

## Replacement semantics

During replacement:

- current old asset remains READY;
- new asset remains PENDING while uploading;
- failure leaves old asset READY;
- after successful R2 finalize + HEAD validation, one transaction marks new READY and old READY slot(s) REPLACED.

The transaction locks the owning Video/Profile to serialize competing replacements. For a logical slot there is one current READY asset after the transaction.

Phase 5 does not physically delete replaced R2 objects. This preserves rollback/audit safety. Garbage collection/lifecycle deletion is deferred.

## Worker durable-complete flow

Successful worker flow:

```text
render local
-> QA PASS
-> calculate local size + SHA-256
-> create worker-scoped upload session
-> direct R2 upload with bounded retries
-> finalize/HeadObject
-> VideoAsset VIDEO READY
-> complete job with outputAssetId
-> backend revalidates current lease + render attempt + READY R2 asset/session
-> RenderAttempt SUCCEEDED
-> Video APPROVED
```

A worker session is bound to:

- authenticated worker identity;
- active lease token;
- current video;
- current RenderAttempt;
- `AssetKind.VIDEO` only.

A worker cannot use worker auth to upload profile media, another video's output or arbitrary bucket keys.

If QA fails, the job fails without uploading a production asset. If R2 upload fails temporarily, the worker retries upload authorization/PUT while reusing the already rendered local MP4. It does not re-render. Exhaustion reports `STORAGE_UPLOAD_FAILED`; the local file remains available for diagnosis.

`DELETE_LOCAL_AFTER_DURABLE_UPLOAD=false` is the Phase 5 default. If explicitly enabled later, deletion happens only after R2 is READY **and** backend complete is confirmed.

## Admin uploads and progress

Admin control requests remain same-origin `/api/admin/*`. The sole Phase 5 external browser exception is a presigned R2 object operation.

The UI supports Video/Cover/Thumbnail upload and Profile Avatar/Banner upload. Server policy is authoritative even though the UI performs basic type/size validation.

Native `fetch` remains the normal API client. `XMLHttpRequest` is used only for the signed R2 PUT because it exposes upload progress events.

## Signed GET preview/download

Private READY assets have no permanent public URL. Admin requests a short-lived signed GET only after Admin JWT + allowlist authorization. READY assets can be previewed; authenticated historical REPLACED assets are also downloadable for rollback/audit review.

The UI renders:

- `<video controls>` for video;
- `<img>` for images;
- temporary download link for other supported assets.

Signed GET URLs live only in transient component state. If one expires, the UI requests another; it is never persisted or placed in browser URL/query state.

## R2 CORS — production

Configure the R2 bucket with an explicit production origin. Do **not** use `*`.

```json
[
  {
    "AllowedOrigins": [
      "https://factory.norvian.io"
    ],
    "AllowedMethods": [
      "GET",
      "HEAD",
      "PUT"
    ],
    "AllowedHeaders": [
      "Content-Type"
    ],
    "ExposeHeaders": [
      "ETag"
    ],
    "MaxAgeSeconds": 300
  }
]
```

`ETag` is exposed because browser multipart uploads must return part ETags to the backend for `CompleteMultipartUpload`. If future checksum/metadata headers are actually signed and sent, add only those exact headers.

### Local development CORS

For a dedicated development bucket/config only, explicit local origins may be added when required:

```json
"AllowedOrigins": [
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173"
]
```

Do not automatically add localhost to production CORS.

## CSP

Production CSP is generated from the configured R2 endpoint origin. It permits only:

```text
connect-src 'self' <exact-r2-origin>
img-src 'self' data: <exact-r2-origin>
media-src 'self' <exact-r2-origin>
```

It does not use `https:`, `*`, `*.cloudflarestorage.com`, `unsafe-inline`, or `unsafe-eval`.

## Asset endpoints

Admin (behind existing Admin Access JWT + exact email allowlist):

```text
GET  /api/admin/channels
GET  /api/admin/assets/policy
GET  /api/admin/videos/:id/assets
POST /api/admin/videos/:id/assets/uploads
POST /api/admin/profiles/:profileId/assets/uploads
POST /api/admin/assets/uploads/:sessionId/parts
POST /api/admin/assets/uploads/:sessionId/complete
POST /api/admin/assets/uploads/:sessionId/abort
POST /api/admin/assets/:assetId/download-url
```

Worker (behind Worker Access JWT + internal worker secret; upload lifecycle also requires active lease):

```text
POST /api/worker/jobs/:videoId/assets/uploads
POST /api/worker/assets/uploads/:sessionId/parts
POST /api/worker/assets/uploads/:sessionId/complete
POST /api/worker/assets/uploads/:sessionId/abort
```

Create and finalize use `Idempotency-Key`. A retried create returns the same logical asset/session with newly generated authorization when needed instead of creating duplicate objects.

## Audit and events

Administrative AuditLog actions include:

- `ASSET_UPLOAD_CREATED`;
- `ASSET_UPLOAD_COMPLETED`;
- `ASSET_REPLACED`;
- `ASSET_UPLOAD_ABORTED`;
- `PROFILE_AVATAR_CHANGED`;
- `PROFILE_BANNER_CHANGED`.

Worker JobEvents include lifecycle-level events only:

- `R2_UPLOAD_STARTED`;
- `R2_UPLOAD_COMPLETED`;
- `R2_UPLOAD_FAILED`.

Per-byte/per-part progress is not written as hundreds of database events.

## Optional real R2 smoke test

Normal CI uses the fake `R2Storage` adapter and local AWS signing tests. It requires no real cloud secret.

An operator may manually configure the four R2 credential variables and run:

```bash
npm run r2:smoke
```

The script PUTs, HEADs, GETs and DELETEs a small object under `smoke-tests/`. When credentials are absent it exits successfully with an explicit `SKIPPED` result. A skipped test must never be described as executed successfully against real R2.

## Durability and backup note

MariaDB stores logical metadata/relationships; R2 stores the object bytes. A MariaDB backup alone does not contain videos. An R2 bucket alone does not preserve the full application relationships/state. Disaster-recovery planning must cover both systems.

## Known Phase 5 limitations / deferred work

- no TikTok/YouTube/Facebook publishing;
- no social OAuth or analytics sync;
- no scheduler/cron execution;
- no public R2 bucket or permanent public asset URLs;
- no public/custom asset domain;
- no automatic deletion/garbage collection of REPLACED objects;
- no forced migration of historical `LEGACY_LOCAL` assets;
- no Hostinger/Cloudflare production deployment in this phase;
- no Phase 6 work.
