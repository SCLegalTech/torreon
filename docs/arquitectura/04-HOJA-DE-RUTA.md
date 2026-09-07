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
| | **E1** — puertos y bordes | pruebas deterministas, errores útiles | bajo |
| | **E2** — el jugador en el modelo | todo lo multiusuario | medio |
| | **E3** — persistencia real | concurrencia, auditoría, escala | **alto** |
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

## E1 — Puertos y bordes

Lo barato que hace posible todo lo demás.

1. **Reloj inyectable** (art. 8). Un puerto `Clock`; el Núcleo lo recibe. Se
   eliminan las 33 llamadas a `new Date()` de los módulos de dominio.
   *Se sabe que funcionó cuando `quick-battles-finance.test.ts` pasa cualquier
   día del mes* — hoy falla 25 de cada 30.
2. **Validación con esquema en HTTP** (art. 7). Las 59 rutas dejan de hacer
   `String(req.body?.x ?? "")`. Zod ya está en el proyecto y `mcp.ts` ya define
   los esquemas: se comparten, no se reescriben.
3. **Errores tipados.** Un `DomainError` con clase (`not_found`, `conflict`,
   `forbidden`, `invalid`) que el borde traduce a HTTP y a MCP. Se acaba el
   `400` para todo.
4. ~~Retirar `mobile-store.ts`~~ ✅ hecho en E0.
5. **`max_machines = 1` explícito en `fly.toml`**, con el comentario de por qué
   es crítico hasta E3.

*Criterio:* suite verde cualquier día del mes y **estable en 20 ejecuciones
seguidas** —hoy `battle-timer.test.ts` falla intermitentemente bajo carga—; una
petición inválida a `/api` y una a `/mcp` fallan con el mismo mensaje y el
código correcto.

---

## E2 — El jugador entra en el modelo

Sin autenticación todavía. Sólo el sujeto (art. 10).

1. `playerId` como raíz de agregado en `domain.ts`.
2. El almacén se direcciona por jugador: `read(playerId)`, `mutate(playerId, …)`.
3. Un único jugador con id fijo mientras no exista E5. El juego no cambia.
4. Una migración versionada que adopta el reino existente bajo ese id.

*Por qué antes de E3:* si el esquema de la base de datos nace sin `player_id`,
E3 se paga dos veces.

*Criterio:* dos reinos coexisten en el mismo proceso sin verse, demostrado por
una prueba; el reino de Diego sobrevive intacto a la migración.

---

## E3 — Persistencia real *(la etapa de mayor riesgo)*

1. SQLite con WAL: tablas de estado + **log de eventos append-only**.
2. `RealmRepository` y `EventLog` como puertos; `JsonRealmStore` pasa a ser un
   adaptador más (útil para pruebas).
3. Un caso de uso = una transacción. Se acaba la lectura-modificación-escritura
   partida entre llamadas.
4. Los `slice(0, 200)` **desaparecen**: el log deja de truncarse (art. 3).
5. Migraciones a `migrations/NNNN-*.ts`, versionadas e idempotentes; el lector
   del almacén deja de migrar en cada lectura.

*Riesgo:* es el corazón. Mitigación: el Núcleo no se toca (art. 6 lo garantiza y
`architecture.test.ts` lo vigila), las 183 pruebas existentes corren contra
ambos adaptadores, y se hace copia del volumen Fly antes de migrar.

*Criterio:* las mismas 183 pruebas pasan contra SQLite; dos escrituras
concurrentes sobre el mismo reino no se pierden; un reino con 10 000 eventos
responde igual de rápido que uno con 73.

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
