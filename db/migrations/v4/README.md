# Migraciones V4

Los archivos de este directorio son overlays editoriales. No contienen ni reemplazan `scenes`, `renderConfig`, `render` o QA.

Para jobs históricos V3, la vista final se construye con deep merge:

`db/jobs/<id>.json` + `db/migrations/v3/<id>.json` + `db/migrations/v4/<id>.json` + `db/dashboard/<id>.json`.

Las migraciones `religion-000002` a `religion-000011` elevan la metadata editorial a V4: copy diferenciado por plataforma, hashtags/emojis dentro de reglas, campos de programación/enlace y estructura de métricas V4 con valores desconocidos en `null`.
