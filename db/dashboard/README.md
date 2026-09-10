# Dashboard overrides

Este directorio contiene exclusivamente overrides administrativos por job.

Orden de fusión de la vista V4:

1. `db/jobs/<jobId>.json`
2. `db/migrations/v3/<jobId>.json`
3. `db/migrations/v4/<jobId>.json`
4. `db/dashboard/<jobId>.json`

La fusión es profunda (deep merge). El dashboard nunca debe copiar ni sobrescribir `scenes`, `renderConfig`, `render`, QA o el `videoId` del renderer dentro de este directorio.

Campos administrativos permitidos:

- `admin.status`: `review`, `ready`, `scheduled`, `published`, `needs_changes`.
- Overrides editables dentro de `publishing.tiktok`, `publishing.youtube` y `publishing.facebook`.

Los workers pueden seguir consumiendo `db/jobs/` de forma independiente.
