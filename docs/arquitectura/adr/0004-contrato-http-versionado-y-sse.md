# ADR-0004 · Contrato `/v1` con proyecciones por pantalla y eventos por SSE

- **Estado:** propuesto (etapa 4)
- **Fecha:** 2026-09-06
- **Artículos:** 12, 13, 16

## Contexto

`GET /api/state` devuelve `RealmSnapshot`, cuyo primer campo es el documento
persistido completo, más ~20 vistas derivadas encima. El cliente lo sondea cada
1 500 ms.

Con el estado medido hoy: **≈ 96 KB/s ≈ 345 MB/hora ≈ 8 GB/día por cliente
conectado**, en una máquina `shared-cpu-1x` de 512 MB, y cada respuesta vuelve a
migrar el documento entero.

Además no hay versión: `RealmState.version` existe y vale 1, pero nadie lo lee.
Cuando haya una APK publicada, cualquier cambio de forma romperá teléfonos que
no controlamos.

## Decisión

1. **Proyecciones por pantalla.** `RealmSnapshot.realm` sale del contrato
   público. Cada pantalla pide su vista; las proyecciones ya existen y están
   probadas en `read-models.ts`.
2. **`/v1` con sobre estable**: `schemaVersion`, `serverTime`, `cursor`, `data`.
   Dentro de una versión mayor sólo se añade.
3. **SSE** en `GET /v1/stream?since={cursor}`. El cliente carga la vista una vez
   y reacciona a eventos. Muere el sondeo.
4. `cursor` liga la foto al log, cerrando la ventana entre una vista y su
   suscripción.

## Consecuencias

**A favor:** desbloquea Unity; el tráfico baja tres órdenes de magnitud; deja de
filtrarse estado interno (razonamientos del juez, rutas en disco, contadores de
plan); las APKs publicadas dejan de ser rehenes de cada refactor.

**En contra:** más superficie de API que mantener, y una conexión abierta por
cliente. Con `min_machines_running = 0` obliga a decidir qué pasa cuando la
máquina se suspende con clientes suscritos: el cliente reanuda por `cursor` y no
pierde nada, pero hay que probarlo con la red caída.

## Alternativas descartadas

- **WebSocket.** Bidireccional que no necesitamos: los comandos van por HTTP.
  SSE reanuda solo y atraviesa proxies sin negociación.
- **Sondeo con `If-None-Match` / 304.** Reduce bytes, no coste de servidor: cada
  petición seguiría leyendo y migrando el documento entero.
- **Mantener `/api` sin versión y «tener cuidado».** Lo mismo que no tener
  contrato, con más confianza.
