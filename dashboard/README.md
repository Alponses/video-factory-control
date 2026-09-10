# Dashboard Admin V4.1

Aplicación local de administración para Video Factory.

## Inicio

```bash
cd dashboard
npm start
```

Abre `http://127.0.0.1:4173`.

## Ventanas

Resumen, Calendario, Canales, Biblioteca de videos, Publicación, Métricas,
Integraciones, GitHub y Servidores son vistas independientes.

## Persistencia

- Edición editorial: `db/dashboard/<jobId>.json`
- Calendario: `dashboard/dashboard-schedule.json`
- Branding subido: `dashboard/uploads/` y `dashboard/dashboard-channels.json`
- Secretos: `dashboard/.secrets.json`

`db/jobs` nunca se modifica desde el dashboard.

La vista de cada job se construye:

`db/jobs` → `db/migrations/v3` → `db/migrations/v4` → `db/dashboard`

## GitHub

Copia `.secrets.example.json` solo si quieres preparar el archivo manualmente.
También puedes configurar owner, repo, branch y PAT desde la ventana GitHub.

La rama predeterminada es `main`. El campo branch sigue siendo editable desde la UI para apuntar temporalmente a otra rama durante pruebas.

El PAT nunca se devuelve al frontend. Para lectura usa un fine-grained PAT con
`Contents: Read`. Para "Guardar en GitHub", usa `Contents: Read and write`.

## Servidores

Renderer:

```bash
cd ~/video-factory/renderer
pnpm dev
```

Factory solo se habilita si existe:

`~/video-factory/factory/scripts/run-factory.mjs`

## Validación

```bash
npm run check
npm run validate:json
npm run test:smoke
```
