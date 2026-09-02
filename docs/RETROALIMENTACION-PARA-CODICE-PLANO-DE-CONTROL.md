# Retroalimentación para Códice — Plano de control de campañas

Escrito desde el Core, para el Dungeon Master. Aquí está lo que el reino ya
sabe hacer, lo que defiende por su cuenta y lo que todavía no puedes pedirle.

---

## 1. Corrección del diagnóstico

El markdown asumía que el MCP «sólo expone herramientas de Quest/evidencia».
No era exacto: `create_campaign`, `create_act`, `assign_quest_to_act`,
`focus_campaign`, `create_saga` y `classify_objective_scale` ya existían.

Lo que **sí** estaba roto era el ciclo de vida. `create_campaign` creaba la
campaña directamente en `active`: no había borrador, no había revisión y no
había pacto. Es decir, podías escribir una campaña pero no **negociarla**, que
es lo único que importa. Esa es la brecha que se cerró.

Si ves un toolset viejo, es una sesión MCP con la lista cacheada. Reconecta.

---

## 2. Inventario real de herramientas

### Leer

| Herramienta | Para qué |
|---|---|
| `get_realm_state` | Panorámica: `hierarchy.campaigns[]`, `activeCampaignIds`, `focusedCampaignId`, `engagedQuestId`, `standaloneQuests`, `battle.party`, `battle.clock`. |
| `get_quest_detail` | Qué ocurre exactamente dentro de una misión: pasos, artefactos y veredictos unidos. |
| `classify_objective_scale` | **Antes** de crear estructura: dice si eso es Quest, Acto, Campaña o Saga. |

### Campaña

| Herramienta | Para qué |
|---|---|
| `create_campaign_draft` | Traza el pacto. Nace en `draft`. Admite `initialActs`. |
| `revise_campaign_draft` | Corrige el pacto mientras no esté sellado. |
| `accept_campaign` | Lo sella. Exige `userAccepted: true` real. |
| `plan_campaign_from_intent` | Propone campaña + actos desde una intención amplia. |
| `focus_campaign` | Mueve la mirada del jugador. Nada más. |

### Estructura

| Herramienta | Para qué |
|---|---|
| `create_act` | Fase jugable de una jornada. No exige ceremonia propia. |
| `assign_quest` | Vincula por ID una quest **ya existente** a campaña y/o acto. |
| `create_saga` | Sólo cuando hay dos o más campañas naturales. |

### Quest y batalla

`create_quest_draft` (acepta `actId` y `campaignId`), `revise_quest_draft`,
`accept_quest`, `start_quest` (acepta `durationMinutes`), `retry_battle`,
`plan_quest_from_intent`, `submit_quest_evidence`, `verify_step_evidence`,
`attach_evidence_artifact`, `attest_evidence_artifact`,
`reuse_evidence_artifact`, `propose_quest_amendment`, `accept_quest_amendment`,
`record_unexpected_requirement`, `abandon_quest`.

---

## 3. Herramientas que probablemente no estás usando

Tres existen desde hace tiempo y resuelven cosas que se ven en tus sesiones:

- **`attest_evidence_artifact`** — cuando el archivo está cargado en TU
  conversación y no en el disco del servidor. Ábrelo, míralo y declara qué
  viste. El servidor lo registra como comprobado *por testigo*. Es la manera de
  jugar sin que el jugador toque el teléfono.
- **`reuse_evidence_artifact`** — el mismo documento sirve para dos pasos. No
  dupliques bytes: reutilízalo y emite un veredicto independiente por paso.
- **`classify_objective_scale`** — evita el error más caro: fabricar una
  Campaña para cuarenta minutos de trabajo.

Y dos nuevas de esta forja:

- **`retry_battle`** — cuando un plazo venció con la Horda viva. No borra nada.
- **`assign_quest`** — para adoptar las quests que ya existían.

---

## 4. Reglas que el servidor defiende solo

No pelees contra estas: te devolverán un error explicando el porqué.

1. **Una Battle dura como máximo 60 minutos.** Si el trabajo pide más, recorta
   el alcance de ESA quest y deja el resto para otra del mismo Acto.
2. **Un Acto sostiene 8 Battles. Una Campaña, 7 Actos.** Más allá, se parte.
3. **Un solo frente comprometido.** Puede haber muchas campañas activas y
   muchas quests aceptadas, pero sólo una Battle con reloj. Si intentas
   `start_quest` con otra corriendo, te lo rechazo con el nombre de la que
   ocupa el frente.
4. **El reloj arranca en `start_quest`,** nunca al redactar ni al aceptar.
5. **La escala la fijan los minutos ACTIVOS.** Diez minutos de trabajo más tres
   días esperando una firma son una Quest en `waiting_external`, no una
   Campaña. `estimatedCalendarDays` describe el calendario y no cambia nada.
6. **Sólo la evidencia comprobada causa daño.** Un paso que pactó `file`,
   `link`, `screenshot` o `photo` no se cierra con una declaración, por
   convincente que suene: el servidor degrada tu veredicto a parcial o
   rechazado.
7. **La Horda no ataca por silencio.** El único ataque temporal legítimo lo
   aplica el servidor en diez ventanas del plazo. `record_unexpected_requirement`
   es para una complicación real y concreta, no para castigar inactividad.
8. **El Tesoro no se inventa.** Completar quests da XP, Aura y maestría. El
   dinero sólo cambia con un hecho financiero real.

---

## 5. Ciclo de vida de una campaña

```text
create_campaign_draft   →  status = draft
        ↓
(revise_campaign_draft) →  sigue draft
        ↓
accept_campaign         →  status = active, entra en activeCampaignIds
        ↓
(varias quests validadas cierran sus actos)
        ↓
                           status = completed
```

Sellar una campaña **no** inicia ninguna Battle y **no** cierra ninguna otra
campaña. Enfocar tampoco: `focus_campaign` sólo mueve `focusedCampaignId`, no
toca `engagedQuestId` ni arranca relojes. Las campañas fuera de foco siguen
vivas y no atacan al jugador: varios frentes de vida no pueden matarlo a la vez.

Un **Acto** no tiene ceremonia propia. Es planificación operativa tuya: créalo,
renómbralo y reorganízalo mientras no cambies el objetivo pactado de la
campaña. Nace `available`; pasa a `active` cuando recibe su primera quest.

---

## 6. `campaignTitle` no es una campaña

Una quest puede llevar `campaignTitle: "La Forja de Solve & Coagula"` y tener
`campaignId: null`. Eso es una **etiqueta de display**, no una relación.

El servidor **nunca** inventará una campaña por coincidencia de texto. Si
quieres que esas quests pertenezcan a una campaña real:

```text
create_campaign_draft  → accept_campaign → create_act (si hace falta)
        ↓
assign_quest { questId, actId }   ← una por cada quest existente
```

`assign_quest` conserva `questId`, `status`, `acceptedAt`, `startedAt`,
`completedAt`, evidencia, eventos e historial. Es idempotente y rechaza un
`actId` que pertenezca a otra campaña.

Una quest también puede colgar directamente de la campaña sin Acto intermedio:
pasa sólo `campaignId`.

---

## 7. El caso Solve & Coagula, paso a paso

```text
1. classify_objective_scale
   intent: "Poner al día Solve & Coagula en las próximas semanas"
   activeMinutes: 1200
   → scale: campaign

2. create_campaign_draft
   title: "La Forja de Solve & Coagula"
   objective: "Los frentes prioritarios quedan atendidos"
   estimatedActiveMinutes: 1200
   estimatedCalendarDays: 21
   initialActs:
     - "Los Expedientes Abiertos"
     - "Reabrir las Puertas del Mercado"

   → el teléfono muestra: 🏰 NUEVA CAMPAÑA TRAZADA [ REVISAR ]

3. el jugador sella el pacto en la app (o tú llamas accept_campaign
   cuando él lo diga explícitamente en la conversación)

4. assign_quest
   "El Oráculo de la Gaceta" → acto "Los Expedientes Abiertos"
   "El Sello de Producción"  → acto "Los Expedientes Abiertos"

5. start_quest sobre UNA de ellas. La otra espera su turno.
```

No planifiques las semanas completas en el paso 2. Una campaña puede empezar
sin conocer todos sus actos y crecer cuando la realidad revele los frentes.

---

## 8. Notificaciones: por qué se abría la quest equivocada

Cada hecho del reino ahora lleva `entityType` y `entityId`. La app abre
exactamente esa entidad; ya no usa heurísticas del tipo «el último borrador» o
«la quest actual». Si trazas dos pactos seguidos, tocar el primero abre el
primero.

Hechos que generan aviso dirigido:

```text
campaign_created   → 🏰 NUEVA CAMPAÑA TRAZADA   [ REVISAR ]
campaign_accepted  → ⚔️ CAMPAÑA ACTIVA
campaign_completed → 🏆 CAMPAÑA CONQUISTADA
quest_created      → 📜 UN NUEVO PACTO AGUARDA TU SELLO  [ REVISAR ]
quest_started      → ⚔️ NUEVA ORDEN DEL CÓDICE  [ VER BATALLA ]
quest_completed    → 🏆 VICTORIA
horde_attack       → 💥 LA HORDA CONTRAATACA
```

Lo que esto te pide a ti: **un hecho, un objetivo**. Si haces dos cosas en una
misma tanda, el jugador recibirá dos avisos y cada uno abrirá lo suyo. No
intentes «resumir» dos creaciones en una sola.

---

## 9. Lo que el jugador ve mientras tú escribes

- **Mapa de campaña** — actos como nodos, progreso derivado, selector de
  frentes abiertos, y el pacto sin sellar con su botón.
- **Acto** — quests del acto y `PREPARAR EXPEDICIÓN`.
- **Orden de misión** — objetivo real, condición de victoria, evidencia
  requerida, duración pactada, valor de ataque por paso y recompensa real.
- **Batalla** — reloj, HP de la Horda y el grupo: Roko con escudo, el Marqués
  y Cordera.

Ten esto en cuenta al redactar: `outcome` y `evidence` de cada paso se leen
enteros en la Orden. Un `outcome` de tres líneas se lee mal en un teléfono en
horizontal.

---

## 10. Lo que todavía no puedes pedirle al reino

- No hay `abandon_campaign` ni `delete_act`. Si un pacto muere, hoy queda vivo.
- No hay tooling de Saga más allá de `create_saga`: no puedes mover campañas
  entre sagas ni cerrarlas a mano.
- No hay desbloqueo configurable de actos: el camino se abre en orden, y un
  acto se considera cerrado cuando todas sus quests están cerradas.
- No hay programación de calendario: `estimatedCalendarDays` es descriptivo.
- No hay push del sistema operativo. El aviso aparece cuando la app consulta el
  reino, cada segundo y medio con la app abierta.

---

## 11. El principio

```text
REALIDAD → CÓDICE → REALM → TODOS LOS CLIENTES
```

Si la campaña sólo existe en el texto de un chat, no existe. Escríbela.
