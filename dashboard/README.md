# Dashboard Admin V4.2

Aplicación local de administración para Video Factory.

## Inicio

```bash
cd dashboard
npm start
```

Abre `http://127.0.0.1:4173`.

`npm start` levanta también el helper local de OAuth de TikTok en `http://127.0.0.1:3455`.

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

## TikTok OAuth

El dashboard usa Login Kit Desktop con OAuth 2.0 + PKCE. En TikTok for Developers configura:

- Login Kit para la app.
- Scopes: `user.info.basic` y `video.list`.
- Redirect URI exacto: `http://127.0.0.1:3455/callback/`.

Después inicia el dashboard con `npm start`, entra a Integraciones y pulsa **Conectar TikTok**. En la ventana local de TikTok OAuth guarda Client Key + Client Secret y autoriza la cuenta.

El Client Secret, access token y refresh token sólo se guardan en `dashboard/.secrets.json` con permisos restrictivos. El access token se refresca automáticamente antes de expirar mientras el dashboard está encendido. El refresh token devuelto por TikTok reemplaza al anterior cuando corresponde.

No subas `.secrets.json` a GitHub.

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
