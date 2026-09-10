# Video Factory V4 — arquitectura editorial y administrativa

## Objetivos

V4 separa producción/render de administración editorial. El worker conserva autoridad sobre `db/jobs`; el dashboard solo crea overrides administrativos.

## Orden de fusión

1. Job original (`db/jobs`).
2. Metadata V3 (`db/migrations/v3`).
3. Metadata editorial V4 (`db/migrations/v4`).
4. Override administrativo (`db/dashboard`).

La fusión es profunda. Una modificación de `publishing.youtube.title`, por ejemplo, no reemplaza `render`, `scenes` ni otros hermanos del job.

## Estados

`admin.status`: `review`, `ready`, `scheduled`, `published`, `needs_changes`.

Estados de plataforma: `pending`, `ready`, `scheduled`, `published`, `failed`.

El status efectivo mostrado por el dashboard prioriza `admin.status`; si no existe, deriva del estado de publicación y del estado original de producción.

## Links y métricas

Cada plataforma puede asociarse mediante URL + identificador (`videoId` o `postId`). El dashboard clasifica el vínculo como:

- Sin publicar.
- Publicado sin métricas.
- Métricas conectadas.
- Error de sincronización.

No se fabrican métricas. Cualquier valor desconocido permanece en `null`.

## Seguridad

El token opcional de GitHub se lee únicamente desde `dashboard/.secrets.json` o `.secrets.json` en la raíz. Ambos paths se encuentran ignorados por Git. El navegador solo recibe un booleano indicando si GitHub está configurado.

El endpoint de guardado remoto siempre escribe `db/dashboard/<jobId>.json`; no existe endpoint de escritura hacia `db/jobs`.
