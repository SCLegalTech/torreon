# Hoja de ruta arquitectónica

Orden de ejecución de [02-ARQUITECTURA-OBJETIVO.md](02-ARQUITECTURA-OBJETIVO.md).
El orden **no es negociable por comodidad**: cada etapa existe donde está porque
la siguiente cuesta el doble sin ella.

Cada etapa es entregable por separado, deja el juego funcionando y termina con
un criterio comprobable. Ninguna pide congelar funcionalidades: se puede seguir
añadiendo juego entre etapas.

| | Etapa | Desbloquea | Riesgo |
|---|---|---|---|
| 🔑 | **Mitigación inmediata** — cerrar la API abierta | nada; **detiene un daño en curso** | bajo · *código listo, falta desplegar* |
| ✅ | **E0** — guardarraíles | que lo demás no se deshaga | — |
| OK | **E1** — puertos y bordes | pruebas deterministas, errores útiles | — |
| OK | **E2** — el jugador en el modelo | todo lo multiusuario | — |
| ~ | **E3** — persistencia real | concurrencia, auditoría, escala | **alto** · *construida y probada; trasladar el reino es decisión de persona* |
| | **E4** — contrato versionado + SSE | **Unity** | medio |
| | **E5** — autenticación e identidad | **Play Store** | medio |
| | **E6** — descomponer el orquestador | velocidad sostenida | bajo, continuo |
| | **E7** — preparación de tienda | publicar | medio |

---

## 🔑 Mitigación inmediata — cerrar la puerta abierta

**Esto no es una etapa de arquitectura; es una fuga en producción.**
`https://torreon.fly.dev` exponía 59 rutas sin autenticación, incluida
`POST /api/reset`, que destruye el reino completo (00-AUDITORIA § B-2).

### Código: hecho

| Variable | Qué hace |
|---|---|
| `TORREON_API_TOKEN` | Ninguna ruta `/api` responde sin `Authorization: Bearer <token>`. Sin la variable, el reino local sigue abierto como siempre. |
| `VITE_TORREON_API_TOKEN` | La misma llave, horneada en la interfaz al compilar la APK. |
| `TORREON_RESET_TOKEN` | `/api/reset` exige **su propia llave** en `X-Torreon-Reset`. Si el reino está cerrado y esta no se declara, la ruta responde 403 y punto. |
| `TORREON_ALLOWED_ORIGINS` | Orígenes permitidos, separados por coma. Vacío = abierto. |

Nueve pruebas lo defienden en `apps/server/src/api-access.test.ts`.

Sobre el origen: **no se cierra por defecto, a propósito.** La APK de Capacitor
no sirve desde `torreon.fly.dev`, así que restringirlo a ciegas dejaría al
teléfono fuera de su propio reino. Con la llave exigida, un origen abierto ya no
es un agujero: no hay credencial ambiente —ni cookies—, así que una página ajena
no puede leer nada. Cerrar el origen queda como refuerzo, para configurarlo
cuando se compruebe en el teléfono cuál es el suyo.

### Despliegue: pendiente, y lo tiene que hacer una persona

```bash
fly secrets set TORREON_API_TOKEN=<cadena larga> TORREON_RESET_TOKEN=<otra distinta> -a torreon
```

Y después recompilar la APK con `VITE_TORREON_API_TOKEN` **con el mismo valor**,
o el teléfono se queda fuera. Ese es el orden: secreto, APK, comprobación.

**Esto no es el artículo 11 y no debe confundirse con él**: un token compartido
no identifica a nadie, se puede extraer de un APK y no sobrevive a la
publicación. Es un tapón mientras llega E5.

*Criterio:* `curl -X POST https://torreon.fly.dev/api/reset` devuelve `401`.

---

## ✅ E0 — Guardarraíles *(hecho en este cambio)*

- `apps/server/src/architecture.test.ts`: 47 pruebas de aptitud que hacen
  cumplir los artículos 4, 5, 6, 7, 9 y 14.
- Trinquete de `quest-service.ts` fijado en su marca máxima: 2 922 líneas.
- Corregida la deriva del contrato del cliente y sellada con una prueba.
- Eliminado `apps/web/src/mobile-store.ts`: segunda fuente de verdad, sin
  importadores (adelanta el punto 4 de E1).
- CI en GitHub Actions: `typecheck` + `test` en cada push. Sin esto, las pruebas
  dependían de que alguien se acordara, y `F-001` llevaba días roja.
- Esta documentación y `CLAUDE.md` en la raíz.

---

## E1 — Puertos y bordes *(hecho)*

1. **Reloj inyectable** — hecho (art. 8, ADR-0006). `clock.ts` define el puerto
   y tres relojes: el de pared, uno detenido (`fixedClock`) y uno que sólo
   avanza cuando alguien lo mueve (`manualClock`). Las 33 llamadas a
   `new Date()` salieron del Núcleo; una prueba de aptitud impide que vuelvan.
2. **Validación con esquema en HTTP** — hecho (art. 7). `contracts.ts` es ahora
   la fuente única de las formas de entrada: `mcp.ts` importa las suyas de ahí
   y las 21 rutas `/api` con cuerpo se validan en el borde. Una petición sin
   forma se rechaza con `422` **diciendo qué campo**.
3. **Errores tipados** — hecho. `errors.ts` define `DomainError` con clase
   (`not_found` 404, `conflict` 409, `invalid` 422, `forbidden` 403), y lo que
   NO es una regla del reino sale como `500`: se acabó culpar al cliente de un
   fallo nuestro.
4. **Retirar `mobile-store.ts`** — hecho en E0.
5. **`max_machines_running = 1` en `fly.toml`** — hecho, con el porqué escrito
   al lado: hasta E3, la integridad del reino depende de que no se escale.

**Además, forzado por el trinquete:** al crecer `quest-service.ts` no se subió
el presupuesto, se extrajeron tres módulos —`realm-events.ts`,
`treasury-flow.ts` y las operaciones del Centro de Notificaciones—. El
orquestador bajó de 2 922 a 2 767 líneas.

*Criterio cumplido:* **269 pruebas, verdes tres ejecuciones seguidas y verdes
cualquier día del mes.** `battle-timer` y `combat-continuity` dejaron de fallar
bajo carga: todas las pruebas de servicio plantan el reloj del reino.

---

## E2 — El jugador entra en el modelo *(hecho)*

Sin autenticación todavía. Sólo el sujeto (art. 10).

1. `RealmState.playerId` es la raíz de agregado. `players.ts` define el tipo, el
   id del jugador que ya existía y la validación —un id no puede escaparse del
   directorio del reino—.
2. El almacén se direcciona por jugador: `read(playerId)`, `mutate(fn, playerId)`,
   `reset(playerId)`, **una cola de escritura por reino** en vez de una global.
3. `QuestService` se construye PARA un jugador y no puede tocar otro reino.
4. Adopción, no migración: el reino que ya existe conserva su archivo
   (`torreon-state.json`), su `realmId` y todo su contenido; sólo estrena dueño
   al leerse. Un jugador nuevo estrena archivo bajo `realms/<id>.json`.

*Por qué antes de E3:* si el esquema de la base de datos nace sin `player_id`,
E3 se paga dos veces.

*Criterio cumplido:* `players.test.ts` demuestra que dos reinos conviven en el
mismo proceso y el mismo almacén sin verse la campaña, que el frente
comprometido de uno no ocupa el del otro, que reiniciar uno no toca al otro, y
que el reino que ya existía sobrevive intacto.

**Lo que sigue faltando:** saber QUIÉN pregunta. Hoy el transporte sirve siempre
al jugador por defecto; la identidad real es E5.

---

## E3 — Persistencia real *(construida y probada; falta la decisión de trasladar)*

### Hecho

1. **El puerto existe como tipo**, no sólo como disciplina: `realm-store.ts`
   define `RealmStore` y `HistoryEntry`. `QuestService` depende del puerto, no
   del adaptador; `JsonRealmStore` es ahora *un* adaptador.
2. **`sqlite-store.ts`**: SQLite en WAL con `synchronous = FULL`, esquema
   versionado en `schema_migrations`, tabla `realms` y tabla `realm_events`
   **append-only y sin techo**.
3. **Una operación = una transacción**, con **concurrencia optimista**: se lee
   con revisión, se decide, y la escritura sólo entra si nadie se adelantó; si
   alguien lo hizo, la operación se rehace sobre la verdad nueva. Se acabó la
   escritura perdida en silencio.
4. **El expediente deja de borrarse.** El documento sigue recortando a 100/200
   —es su límite—, pero SQLite archiva cada hecho por `event_id`, idempotente.
   Y `reset` **no borra el expediente**: anular no es borrar (art. 3).
5. **`migrateRealm` se extrajo** del lector del JSON: los dos adaptadores
   comparten exactamente la misma migración de lectura.
6. **Traslado**: `npm run realm:sqlite` copia cada reino con su historia. No
   borra el documento, así que volver atrás es cambiar una variable.

*Comprobado:* `store-conformance.test.ts` corre la misma batería contra los dos
adaptadores. **289 pruebas verdes bajo Node 22** (con Node 20, las de SQLite se
saltan). El traslado se ejecutó sobre una copia del reino real: 12 quests y 85
hechos archivados.

### Pendiente, y es deliberado

- **Node 22.5+** (`node:sqlite`). El Docker de Fly ya lo cumple; la máquina de
  desarrollo tiene Node 20, así que `json` sigue siendo el valor por defecto.
- **Trasladar el reino de producción es una decisión de persona**, no un efecto
  secundario de un despliegue: exige copia del volumen por delante.
- **El estado sigue guardándose como documento** dentro de la fila del jugador.
  Normalizar el dominio entero es otra obra y ningún problema actual la pide: lo
  que engordaba el documento era la historia, y la historia ya salió de ahí.

### Cómo se traslada, cuando se decida

```bash
fly volumes snapshots create <volumen> -a torreon
fly ssh console -a torreon -C "npm run realm:sqlite"
fly secrets set TORREON_STORE=sqlite -a torreon
```

*Criterio:* las mismas pruebas pasan contra SQLite, hecho; dos escrituras
concurrentes sobre el mismo reino no se pierden, hecho; el expediente sobrevive
a un reinicio del reino, hecho.

---

## E4 — Contrato versionado, proyecciones y SSE *(la etapa que desbloquea Unity)*

1. `/v1` con sobre estable (`schemaVersion`, `serverTime`, `cursor`, `data`).
2. Vistas por pantalla; `RealmSnapshot.realm` sale del contrato público.
3. `GET /v1/stream` (SSE) reanudable por `cursor`; el sondeo de 1,5 s muere.
4. Contrato generado a JSON Schema → TypeScript y C# (ADR-0005), verificado en CI.
5. React migra a `/v1` y **valida el diseño**: si React puede, Unity puede.

*Criterio:* la carga por cliente conectado baja de ~345 MB/hora a kilobytes;
`apps/web/src/types.ts` deja de existir como archivo escrito a mano; el contrato
C# se genera y compila.

---

## E5 — Autenticación e identidad *(la etapa que desbloquea Play Store)*

1. Sesión de jugador con refresco desde la APK.
2. `AgentGrant`: acceso por MCP en nombre de un jugador, con alcance y
   revocación independientes (art. 11). Sustituye a `TORREON_MCP_TOKEN`.
3. Autorización por propietario en cada caso de uso.
4. Pantalla de agentes conectados: qué tienen, qué hicieron, cómo se les corta.

*Criterio:* dos jugadores reales en el mismo despliegue, cada uno con su reino y
sus agentes; revocar un agente no cierra la sesión del jugador; una petición sin
sesión no obtiene nada.

---

## E6 — Descomponer el orquestador *(continua)*

No es una etapa con fecha: es la regla del artículo 9 aplicada en cada cambio.
Cada vez que se toque `quest-service.ts` se extrae un flujo y **se baja el
presupuesto** del trinquete. Orden sugerido por facilidad decreciente:

`TreasuryFlow` → `NotificationFlow` → `BarracksFlow` → `CampaignFlow` →
`EvidenceFlow` → `BattleFlow` → `QuestFlow`

*Criterio:* el presupuesto de `architecture.test.ts` baja en cada commit que
toque ese archivo. Nunca sube.

---

## E7 — Preparación de tienda

1. Borrado de cuenta y exportación de datos, de verdad, no en el formulario.
2. Declaración de datos recogidos que se corresponda con el código.
3. Los límites de plan de `product.ts` conectados a algo real (o retirados del
   contrato público hasta que lo estén).
4. Retención del log de eventos declarada y aplicada.
5. Firma de release, ofuscación, `versionCode` gestionado.

*Criterio:* un jugador pide su borrado y no queda ni una fila suya, demostrado
por una prueba.

---

## Qué NO hacer en el orden equivocado

- **Unity antes de E4.** Un cliente Unity contra el contrato de hoy nace
  acoplado al estado persistido y hay que rehacerlo entero.
- **Play Store antes de E5.** Publicar sin identidad es publicar la base de
  datos de un usuario.
- **E3 antes de E2.** Un esquema sin `player_id` se migra dos veces.
- **Refactor grande del orquestador antes de E1.** Sin reloj inyectable ni
  errores tipados, cada extracción arrastra la ambigüedad a otro archivo.
