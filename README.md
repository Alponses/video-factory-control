# Video Factory Control V4

Repositorio de control, estado editorial y administración para Video Factory.

## Arquitectura

ChatGPT / generador
↓
GitHub Control Repository
↓
Workers
↓
Renderer
↓
QA
↓
Publicación / Dashboard

## Directorios

- `config/`: configuración y reglas globales reutilizables.
- `prompts/`: instrucciones del generador.
- `db/jobs/`: jobs originales consumidos por workers. El dashboard no los modifica.
- `db/migrations/v3/`: metadata editorial V3 histórica.
- `db/migrations/v4/`: overlays editoriales V4 para históricos o compatibilidad.
- `db/dashboard/`: overrides administrativos de publicación/estado.
- `db/topics.json`: índice de temas usados.
- `db/stats.json`: estadísticas globales de producción.
- `dashboard/`: aplicación administrativa local.
- `docs/`: documentación y ejemplos.

## Modelo de lectura V4

La vista administrativa usa deep merge en este orden:

`job original + migration V3 + migration V4 + dashboard override`.

Esto permite enriquecer publicación, enlaces y estados sin reemplazar `scenes`, `renderConfig`, `render`, `render.videoId` ni resultados QA del job original.

## Estados

El job original conserva sus estados de producción (`pending`, `processing`, `approved`, `failed`, `publishing`, `published`).

El dashboard agrega `admin.status`: `review`, `ready`, `scheduled`, `published`, `needs_changes`.

Cada plataforma usa: `pending`, `ready`, `scheduled`, `published`, `failed`.

## Reglas editoriales

Los límites de hashtags, emojis, descripciones y títulos viven en `config/publishing-rules.json`. Son reglas internas de Video Factory y no deben confundirse con límites oficiales de cada plataforma.

## Seguridad

Nunca subir API keys, tokens, `.env`, `.secrets.json`, credenciales, MP4, WAV o MP3. El token opcional del dashboard se mantiene en `dashboard/.secrets.json`, ignorado por Git y leído únicamente por el servidor local.
