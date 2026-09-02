# Retroalimentación de Codex para Códice — Realm único y batalla viva

## Diagnóstico encontrado

Antes de esta implementación, ChatGPT/MCP escribía el volumen persistente de `https://torreon.fly.dev`, mientras la APK intentaba `127.0.0.1:3000` y, ante cualquier fallo, creaba silenciosamente otro Realm en `localStorage`. El `JsonRealmStore`, `QuestService` y los adaptadores HTTP/MCP ya compartían correctamente el dominio dentro de una misma instancia; la divergencia estaba en la selección de instancia hecha por el cliente móvil.

Gemini no conserva una Quest paralela: `GeminiCodice` propone un `QuestPlanInput`, pero `QuestService.createDraft()` lo persiste en el mismo `JsonRealmStore` que utiliza MCP. La historia de chat del modelo no es fuente de verdad.

## Decisión para el MVP

El Realm autoritativo es el desplegado en Fly:

```text
https://torreon.fly.dev
instance: torreon-nube
storage: /data/torreon-state.json
```

La APK usa esa API directamente. El fallback local silencioso deja de participar en gameplay normal. Así, la ruta de ambos sentidos queda:

```text
ChatGPT → MCP → QuestService → JsonRealmStore ← App API ← Torreon/Gemini
```

La app expone discretamente `consistency.instance` y los primeros caracteres de `realmId`, y `/health` también devuelve ambos valores para diagnosticar una instancia equivocada.

## Realtime elegido

Se conservó polling de `GET /api/state` cada 1,5 segundos. Para una sola campaña y un Realm JSON es la solución mínima que cumple reacción foreground en pocos segundos sin introducir WebSocket/SSE prematuramente.

La app recuerda los `eventId` ya observados y convierte solamente eventos nuevos de estos tipos en feedback narrativo:

- `quest_created`: nuevo pacto;
- `quest_started`: nueva orden;
- `quest_completed`: victoria.

El CTA abre la batalla de la Quest actual. Un evento releído después de una desconexión no vuelve a producir el aviso dentro de la sesión, y al arrancar la app se hidratan los eventos históricos sin reproducirlos.

## Evidencia móvil

Se añadió `photo` al contrato `EvidenceKind` compartido por dominio, Códice, Gemini y MCP. Para este corte no fue necesario añadir un plugin de Capacitor: Android resuelve `input[type=file]` con `accept=image/*` y `capture=environment` abriendo la cámara nativa.

```text
photo → cámara Android → bytes base64 → Artifact(file/image) → verifyStep → Evidence → LifeEvent → GameEvent → daño
```

La fotografía vive en el Realm y su copia en `/data/artifacts`; no queda solamente en React. MCP ya puede leer su metadata, comprobación y vínculo con el paso mediante `get_realm_state`/`get_quest_detail`. El binario no se expone todavía como recurso descargable a ChatGPT.

## Visión sobre la batalla

La nueva pantalla debe tratar el arte como campo de batalla y los componentes como instrumentos del Realm. La imagen no decide vida, progreso ni estado. Las capas funcionales actuales son: campaña, Quest, salud de la Horda, contrato, órdenes, captura de evidencia, impacto y KO. Las economías ficticias que aparecen en el concepto visual permanecen sin lógica hasta que exista un contrato de dominio para ellas.

## Alcance pendiente, recomendado

1. Añadir autenticación de jugador para App API; un secreto embebido en APK no sería seguridad real.
2. Implementar push y deep link nativo como P1. Foreground realtime e in-app CTA ya quedan resueltos.
3. Exponer el binario/preview de Artifact mediante una lectura autenticada si Códice necesita volver a inspeccionar fotos tomadas en Torreon.
4. Retirar `mobile-store.ts` cuando se defina formalmente el modo offline; no debe reactivarse como fallback implícito.
5. Si aumenta el número de jugadores o eventos, sustituir polling por SSE antes de considerar una infraestructura mayor.

## Principio preservado

El modelo puede cambiar de voz. La Quest, la evidencia, el impacto y la batalla no cambian de verdad.

