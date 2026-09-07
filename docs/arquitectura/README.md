# Arquitectura de Torreón

Base arquitectónica del proyecto: qué hay, qué manda, a dónde vamos y en qué
orden. Escrita para que un agente que llega hoy pueda trabajar sin volver a
deducirlo todo del código.

## Por dónde empezar

| Si eres… | Lee |
|---|---|
| Un agente que va a tocar código **ahora** | [`../../CLAUDE.md`](../../CLAUDE.md) → [01-CONSTITUCION](01-CONSTITUCION.md) |
| Quien decide qué se hace primero | [00-AUDITORIA](00-AUDITORIA.md) → [04-HOJA-DE-RUTA](04-HOJA-DE-RUTA.md) |
| Quien va a construir el cliente Unity | [03-CONTRATO-DE-CLIENTE](03-CONTRATO-DE-CLIENTE.md) |
| Quien quiere entender una decisión pasada | [adr/](adr/) |

## Los documentos

- **[00-AUDITORIA.md](00-AUDITORIA.md)** — qué hay hoy, con medidas. Fortalezas
  que hay que preservar y hallazgos con severidad.
- **[01-CONSTITUCION.md](01-CONSTITUCION.md)** — la ley. 20 artículos; los
  marcados 🔒 los hace cumplir una prueba.
- **[02-ARQUITECTURA-OBJETIVO.md](02-ARQUITECTURA-OBJETIVO.md)** — las capas y
  los cuatro cortes: identidad, persistencia, contrato, confianza.
- **[03-CONTRATO-DE-CLIENTE.md](03-CONTRATO-DE-CLIENTE.md)** — qué recibe, qué
  envía y qué tiene prohibido un renderer. Para Unity.
- **[04-HOJA-DE-RUTA.md](04-HOJA-DE-RUTA.md)** — etapas en orden, con criterios
  de cierre comprobables.
- **[adr/](adr/)** — decisiones con su contexto, sus consecuencias malas y las
  alternativas descartadas.

## Cómo se hace cumplir

`apps/server/src/architecture.test.ts` — 47 pruebas que ejecutan los artículos
4, 5, 6, 7, 9 y 14. Corren con `npm test`.

Una prueba de aptitud en rojo **no se relaja**: se respeta el límite o se cambia
la constitución con un ADR (art. 18).

## Decisiones registradas

| ADR | Decisión | Estado |
|---|---|---|
| [0001](adr/0001-nucleo-autoridad-renderers-intercambiables.md) | El Núcleo es la única autoridad; los renderers son intercambiables | aceptado |
| [0002](adr/0002-jugador-como-raiz-de-agregado.md) | El jugador es la raíz de agregado, no el reino | **implementado** (E2) |
| [0003](adr/0003-persistencia-sqlite-y-log-append-only.md) | SQLite + log append-only sustituyen al documento JSON | **implementado** (E3) · trasladar el reino, pendiente |
| [0004](adr/0004-contrato-http-versionado-y-sse.md) | Contrato `/v1` con proyecciones por pantalla y SSE | **implementado** (E4) |
| [0005](adr/0005-contrato-generado-fuente-unica.md) | El vocabulario del contrato se genera, no se copia | **implementado** (E4) · los DTO, con Unity |
| [0006](adr/0006-puertos-de-infraestructura.md) | Toda infraestructura entra por un puerto, empezando por el reloj | **implementado** (E1) · los archivos, pendientes |
| [0007](adr/0007-identidad-jugador-y-agente.md) | Dos identidades: sesión de jugador y concesión de agente | **implementado** (E5) · apagado por defecto |
| [0008](adr/0008-el-juez-no-obedece-a-la-evidencia.md) | El texto de un artefacto es dato, nunca instrucción | **implementado** |

## Lo que falta encender

Tres cosas están construidas y probadas pero **apagadas a propósito**, porque
encenderlas en un reino que ya se está jugando es una decisión de persona:

| Variable | Qué enciende | Qué exige antes |
|---|---|---|
| `TORREON_API_TOKEN` | La llave de la API | recompilar la APK con la misma llave |
| `TORREON_IDENTITY=on` | La identidad de verdad | que la APK abra sesión al arrancar |
| `TORREON_STORE=sqlite` | La persistencia real | `npm run realm:sqlite` y copia del volumen |
