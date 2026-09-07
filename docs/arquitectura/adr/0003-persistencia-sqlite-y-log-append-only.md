# ADR-0003 · SQLite con log de eventos append-only sustituye al documento JSON

- **Estado:** aceptado — implementado y probado en E3; el traslado del reino de producción sigue pendiente de decisión
- **Fecha:** 2026-09-06
- **Artículos:** 3, 6, 20

## Contexto

Un solo documento JSON es a la vez base de datos, log de auditoría y DTO.
Medido hoy: 143 834 bytes tras cuatro días de un jugador, de los cuales el 37 %
son eventos de juego. Se lee, se parsea, se migra y se reescribe **entero** en
cada operación.

Tres consecuencias, en orden de gravedad:

1. **La auditoría se destruye sola.** Como el log vive dentro del documento que
   se reescribe, hay que recortarlo: `slice(0, 200)` en seis sitios distintos.
   Un producto cuya tesis es la evidencia comprobada borra su evidencia a partir
   del evento 201.
2. **La concurrencia es una cola de promesas en memoria.** Dos máquinas =
   escrituras perdidas sin error. Hoy no ocurre por una propiedad accidental de
   los volúmenes de Fly, no por diseño.
3. **Coste O(estado completo) por operación**, en lectura y en escritura.

## Decisión

SQLite con WAL, en el mismo proceso y sobre el mismo volumen. Tres cosas
separadas con vidas distintas: **estado** (acotado), **log de eventos**
(append-only, sin techo) y **proyecciones** (derivadas).

**Cómo quedó implementado**, con tres decisiones que conviene tener escritas:

- **El estado se guarda como documento dentro de su fila** (`realms.state`), no
  normalizado. Normalizar el dominio entero sería otra obra y ningún problema
  actual la pide: lo que engordaba el documento era la historia, y la historia
  ya vive en su propia tabla. La escritura sigue siendo O(estado) —bastante más
  pequeño— y eso se acepta a sabiendas.
- **Concurrencia optimista con revisión**, no un candado. Se lee con revisión,
  se decide, y la escritura sólo entra si nadie se adelantó; si alguien lo hizo,
  la operación se rehace sobre la verdad nueva. Una cola en memoria evita la
  mayoría de los reintentos dentro de un proceso, pero la corrección no depende
  de ella: depende de la revisión, que sí cruza procesos.
- **`node:sqlite` (Node 22.5+)** en vez de una dependencia nativa.
  `better-sqlite3` no compila en la máquina de desarrollo actual y arrastraría
  node-gyp al Dockerfile. El coste es que el adaptador SQLite no corre en Node
  20, donde el documento JSON sigue siendo el camino soportado.

`RealmRepository` y `EventLog` como puertos; `JsonRealmStore` sobrevive como
adaptador para pruebas. Postgres el día que haya más de una máquina, sin tocar
el Núcleo.

Las migraciones salen del lector del almacén y pasan a `migrations/NNNN-*.ts`:
versionadas, idempotentes, ejecutadas al arrancar.

## Consecuencias

**A favor:** el artículo 3 se puede cumplir de verdad; una operación es una
transacción; escrituras proporcionales al cambio; consultas por rango para el
expediente y para SSE.

**En contra:** es la etapa de mayor riesgo del plan y toca el corazón del
producto. Exige copia del volumen antes de migrar y correr las 183 pruebas
existentes contra ambos adaptadores.

**Coste oculto:** el estado deja de ser legible con `cat`. Se compensa con un
comando de volcado a JSON.

## Alternativas descartadas

- **Postgres desde ya.** Añade una dependencia de red y coste a un problema que
  hoy es de un solo proceso. SQLite migra a Postgres sin tocar el Núcleo (art. 6).
- **Seguir con JSON y sólo arreglar el truncado.** El documento crecería sin
  techo y cada escritura lo reescribiría entero: cambia una avería por otra.
- **Event sourcing puro.** Log append-only sí; reconstruir todo el estado desde
  el log en cada arranque, no: complejidad que ningún problema actual pide.
