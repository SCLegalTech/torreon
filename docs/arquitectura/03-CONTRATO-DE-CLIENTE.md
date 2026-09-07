# Contrato de cliente — para Unity (y para el React que lo precede)

Documento para quien construya el cliente Unity. Define **qué puede hacer un
renderer, qué recibe y qué tiene terminantemente prohibido**.

Regla de oro: *el cliente puede cambiar de motor, de arte, de plataforma y de
lenguaje sin que cambie una sola regla del juego.* Si un cambio en Unity obliga
a cambiar el Núcleo por otra razón que no sea «faltaba un dato en la
proyección», el contrato está mal.

---

## 1. Lo que el renderer NO hace, nunca

No es una lista de estilo. Cada punto ya está defendido por el Núcleo, y un
cliente que lo intente producirá una pantalla que miente.

| Prohibido | Por qué |
|---|---|
| Calcular progreso o daño | Sólo la evidencia validada por el Núcleo mueve la barra (art. 1) |
| Decidir victoria, derrota o KO | El Núcleo concilia y proyecta el resultado |
| Restar inventario | El Core valida existencia, cantidad y destino, y decrementa |
| Conceder XP, Aura, maestría o dinero | El Tesoro sólo cambia con un hecho financiero real |
| Arrancar o pausar el reloj de una Battle | El reloj arranca en `start_quest` y sólo ahí |
| Interpretar evidencia | El veredicto es del Códice, acotado por el Núcleo |
| Guardar un reino paralelo | Prohibido explícitamente (art. 15) |
| Reordenar para desbloquear | *Position is not authorization*: bloquea la dependencia declarada, no la posición |

Lo que el renderer **sí** decide, entero y sin pedir permiso: cámara, cortes,
animación, partículas, sonido, timing visual, transiciones, retroalimentación
háptica, orden de aparición en pantalla, y cuándo una animación empieza o
termina. Esa es la mitad que Unity hace mejor que React, y es toda suya.

---

## 2. Modelo mental: tres canales

```
1. VISTA      GET /v1/...            «dame la foto de esta pantalla»
2. EVENTOS    GET /v1/stream (SSE)   «avísame cuando algo cambie»
3. COMANDO    POST /v1/...           «el jugador quiere hacer esto»
```

El ciclo de un cliente bien hecho:

```
abrir pantalla  → VISTA (una vez)
mientras viva   → EVENTOS → animar → refrescar sólo la vista afectada
acción jugador  → COMANDO → respuesta autoritativa → animar el resultado
```

**Nunca**: sondear la vista en bucle. **Nunca**: aplicar el efecto de un comando
antes de la respuesta. Se puede *anticipar la animación* (el arquero dispara),
pero el número lo pone el servidor (cuánto quitó la flecha).

---

## 3. Vistas por pantalla

Una vista por pantalla, con exactamente lo que esa pantalla dibuja (art. 12, 16).
Los nombres se corresponden con proyecciones que **ya existen** en
`read-models.ts`; lo que falta es exponerlas por separado en vez de dentro del
estado completo.

| Pantalla Unity | Vista | Ya existe en el Núcleo |
|---|---|---|
| Bastión / menú del reino | `GET /v1/realm/summary` | `statsFor`, `treasuryViewFor`, `worldSystemsFor` |
| Frentes abiertos | `GET /v1/fronts` | `openFrontsFor` ✔ |
| Mapa de campaña | `GET /v1/campaigns/{id}/map` | `hierarchyFor` ✔ |
| Batalla | `GET /v1/battle/{questId}` | `BattleState` + `battleClock` ✔ |
| Expediente de la Quest | `GET /v1/quests/{id}` | `questDetailFor` ✔ |
| Barracas | `GET /v1/barracks` | `barracksViewFor` ✔ |
| Avisos | `GET /v1/notifications` | `notificationViewsFor` ✔ |
| Tesorería | `GET /v1/treasury` | `treasuryViewFor` ✔ |

**Esto es lo importante para el plan de Unity:** la capa de proyección ya está
escrita y probada. El trabajo pendiente no es diseñarla, es *dejar de enviarla
envuelta en el estado persistido*.

Toda vista responde en un sobre estable:

```jsonc
{
  "schemaVersion": 1,
  "serverTime": "2026-09-06T21:00:00.000Z",  // el reloj es del servidor
  "cursor": "evt_01J...",                    // último evento incluido en esta foto
  "data": { /* la vista */ }
}
```

`cursor` es lo que hace correcto el ciclo: el cliente pide la vista, recibe el
punto exacto del log en que está esa foto, y se suscribe **desde ahí**. Sin él
hay una ventana en la que un evento se pierde entre la foto y la suscripción.

---

## 4. Eventos

`GET /v1/stream?since={cursor}` (SSE). Cada evento es una **notificación de
cambio**, no un delta que el cliente aplique al estado. Trae lo justo para
animar; si el cliente necesita el número exacto, refresca la vista afectada.

```jsonc
{ "id": "evt_01J...", "type": "quest_attack", "questId": "...",
  "at": "...", "payload": { "damage": 12, "target": "horde", "byHero": "marques" } }
```

Tipos que Unity debe saber animar, todos ya emitidos hoy por el Núcleo:

| Evento | Qué dibuja Unity |
|---|---|
| `quest_attack` | el grupo golpea; la barra de la Horda baja al valor autoritativo |
| `horde_attack` | contraataque; el grupo encaja daño |
| `quest_completed` | KO, victoria, recompensa |
| `battle_recontracted` | el reloj cambia; el frente sigue |
| `party_member_down` / `recovered` | caída y levantamiento |
| `quest_waiting_external` | el frente se suspende: reloj parado, presión parada |
| `notification_created` | 🔔 |

Reglas de consumo, aprendidas ya en el cliente React:

1. **Idempotencia por `id`.** Un evento releído tras una reconexión no vuelve a
   producir la animación ni el aviso.
2. **Al arrancar se hidrata sin reproducir.** La historia se carga; no se
   redisparan cincuenta ataques en la cara del jugador.
3. **El evento no es la verdad; es el aviso de que la verdad cambió.** Si la
   animación y la vista discrepan, gana la vista.

---

## 5. Comandos

Todo comando es `POST`, autenticado como jugador, y devuelve **el resultado
autoritativo** —no un `204`—, para que el cliente anime sobre datos ciertos:

```
POST /v1/quests/{id}/accept          { userAccepted: true }
POST /v1/quests/{id}/start           { durationMinutes }
POST /v1/quests/{id}/steps/{sid}/artifacts
POST /v1/quests/{id}/steps/{sid}/verify
POST /v1/inventory/use               { itemId, target, questId }
POST /v1/quests/{id}/battle/recover
POST /v1/quests/{id}/discard         { reason }
```

**Aceptación explícita**: los comandos que sellan un pacto exigen
`userAccepted: true` y ese `true` tiene que venir de un gesto real del jugador.
Un cliente que lo mande por su cuenta está falsificando consentimiento; es la
frontera entre un juego sobre la vida real y un juguete.

**Errores.** El cliente necesita distinguirlos para reaccionar bien; hoy todo
llega como `400` y eso hay que arreglarlo en el borde (art. 7):

| Código | Significado | Qué hace Unity |
|---|---|---|
| `400` | la petición está mal formada | error de programación, reportar |
| `401` / `403` | sesión o permiso | reautenticar |
| `404` | no existe | volver a la pantalla anterior y refrescar |
| `409` | conflicto de estado (p. ej. ya hay un frente comprometido) | **mostrar el motivo del Núcleo**, que viene redactado para el jugador |
| `422` | la regla lo prohíbe | igual que `409` |

Los mensajes del Núcleo están escritos para leerse (*«ya hay una Battle con
reloj corriendo: …»*). Unity los muestra; no los reescribe ni los oculta.

---

## 6. El vocabulario en C#

**No se copia a mano.** Ya hubo deriva con una sola copia y un solo lenguaje
(ver 00-AUDITORIA § A-5); con C# de por medio no habría compilador que la
detecte.

El contrato se genera desde una fuente única (ADR-0005):

```
apps/server/src/domain.ts  ──►  contract/*.schema.json  ──┬──►  TypeScript (web)
        (fuente)                    (artefacto)           └──►  C#  (Unity)
```

La generación corre en CI y **falla el build si el artefacto no coincide con la
fuente**. Mientras eso no exista, la prueba de no-deriva de
`architecture.test.ts` cubre el vocabulario compartido con `apps/web`.

Convenciones para el lado C#, decididas ahora para no discutirlas después:

- Las uniones de literales se generan como `enum` con un miembro `Unknown = 0`.
  **Un valor nuevo del servidor no puede romper una APK vieja** (art. 13): lo
  desconocido cae en `Unknown` y la pantalla lo ignora con elegancia.
- Los campos opcionales del contrato son nullable en C#. Nada de valores
  centinela.
- Las fechas viajan como ISO-8601 en UTC y se muestran en la zona del
  dispositivo. **El reloj autoritativo es `serverTime`**; el del teléfono sólo
  interpola entre respuestas y nunca decide si un plazo venció.

---

## 7. Estado del cliente: qué puede recordar

| Puede recordar | No puede recordar |
|---|---|
| La última vista, para pintar algo mientras carga (marcada como desactualizada) | Cualquier cosa que se parezca a un reino jugable |
| `cursor` y los `id` de eventos ya animados | Progreso, daño o veredictos propios |
| Preferencias locales: volumen, calidad gráfica, idioma | Inventario, XP, Aura, Tesoro |
| Un artefacto capturado y todavía no subido, en cola | Un veredicto sobre ese artefacto |

Sin conexión: se informa el fallo y se muestra la última vista en gris. **No se
juega.** El precedente está en `apps/web/src/mobile-store.ts`: fabricaba un
reino entero en `localStorage`, hubo que desconectarlo del gameplay y ya se
eliminó. No debe reaparecer en Unity con otro nombre.

---

## 8. Lista de verificación para el proyecto Unity

Antes de la primera escena:

- [ ] Etapas 1–4 de la hoja de ruta cerradas (proyecciones, versión, SSE, identidad).
- [ ] Contrato C# generado, no escrito.
- [ ] `Unknown = 0` en cada enum generado.
- [ ] Una capa de acceso —`TorreonClient`— y **ninguna** llamada HTTP fuera de ella.
- [ ] Reconexión de SSE con reanudación por `cursor` probada con la red caída.
- [ ] Una escena de prueba que consuma un log de eventos grabado, sin servidor:
      si las animaciones no se pueden probar sin Núcleo, el acoplamiento existe.
