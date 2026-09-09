# Video Factory Control

Repositorio de control y estado para el sistema automatizado Video Factory.

## Arquitectura

ChatGPT
↓
GitHub Control Repository
↓
Workers
↓
Renderer
↓
QA
↓
GitHub

## Directorios

### config/

Configuraciones y reglas globales.

### prompts/

Instrucciones para los generadores de contenido.

### db/jobs/

Un archivo JSON por video.

### db/topics.json

Índice de temas utilizados para prevenir duplicados.

### db/stats.json

Estadísticas globales de producción.

### batches/

Registro de lotes de generación y producción.

### docs/

Documentación de arquitectura.

## Estados de un Job

pending
→ processing
→ approved / failed
→ published

## Archivos multimedia

Los videos, audios y recursos multimedia NO se almacenan en este repositorio.

El repositorio contiene exclusivamente:

- configuración
- scripts
- prompts
- estados
- metadata
- analytics

## Seguridad

Nunca subir:

- API keys
- tokens
- archivos .env
- credenciales
- MP4
- WAV
- MP3
