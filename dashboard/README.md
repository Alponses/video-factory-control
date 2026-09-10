# Video Factory Dashboard V4

Dashboard administrativo local, sin dependencias externas.

## Ejecutar

```bash
cd dashboard
npm start
```

Abrir `http://127.0.0.1:4173`.

## Capas de datos

La API local construye cada video mediante deep merge:

`db/jobs` → `db/migrations/v3` → `db/migrations/v4` → `db/dashboard`.

Guardar local escribe únicamente `db/dashboard/<jobId>.json`.

## GitHub

Copia `.secrets.example.json` a `.secrets.json` dentro de `dashboard/` y configura un Fine-grained PAT con acceso únicamente al repositorio necesario. Para usar **Guardar en GitHub**, el token necesita `Contents: Read and write`.

`.secrets.json` está ignorado por Git y el token nunca se entrega al navegador.

Guardar en GitHub escribe exclusivamente `db/dashboard/<jobId>.json`. Si el token no tiene permiso de escritura, el servidor mostrará el error de GitHub y no modificará `db/jobs`.
