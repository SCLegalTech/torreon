# Arquitectura objetivo — Torreón multiusuario, con Unity

Esto es a dónde vamos. No es una reescritura: es el mismo Núcleo, con los cuatro
cortes que hoy le faltan. El orden y las etapas están en
[04-HOJA-DE-RUTA.md](04-HOJA-DE-RUTA.md).

---

## 1. Las capas

```
┌──────────────────────────────────────────────────────────────────────┐
│  CLIENTES                                                            │
│  Unity (objetivo) · React (transitorio) · ChatGPT/Claude/Codex (MCP) │
│  Dibujan, animan, navegan. NO deciden reglas.        (art. 15)       │
└────────────┬────────────────────────────────────┬────────────────────┘
             │ HTTP /v1 + SSE                     │ MCP
┌────────────▼────────────────────────────────────▼────────────────────┐
│  TRANSPORTE — traduce protocolo, no decide           (art. 7)        │
│  · valida con esquema en el borde (Zod, ambos caminos)               │
│  · autentica jugador / autoriza agente               (art. 11)       │
│  · traduce errores de dominio a códigos HTTP y MCP                   │
└────────────┬─────────────────────────────────────────────────────────┘
             │ casos de uso tipados
┌────────────▼─────────────────────────────────────────────────────────┐
│  APLICACIÓN — un caso de uso = una transacción                       │
│  QuestFlow · BattleFlow · EvidenceFlow · TreasuryFlow ·              │
│  CampaignFlow · NotificationFlow · BarracksFlow                      │
│  (hoy: una sola clase de 2 922 líneas)                (art. 9)       │
└────────────┬─────────────────────────────────────────────────────────┘
             │ funciones puras sobre estado
┌────────────▼─────────────────────────────────────────────────────────┐
│  NÚCLEO — las reglas del juego            (art. 1, 2, 5, 6)          │
│  domain · battle · party · horde · scale · finance · progression ·   │
│  inventory · companions · barracks · battle-memory · notifications · │
│  product · codice(contrato) · read-models(proyección)                │
│  Sin Express. Sin MCP. Sin almacén. Sin reloj de pared. (art. 8)     │
└────────────┬─────────────────────────────────────────────────────────┘
             │ puertos
┌────────────▼─────────────────────────────────────────────────────────┐
│  INFRAESTRUCTURA — adaptadores intercambiables                       │
│  RealmRepository · EventLog · ArtifactStore · Clock · IdGen ·        │
│  Identity · CodiceRuntime · PushChannel                              │
└──────────────────────────────────────────────────────────────────────┘
```

La regla de dependencia es una flecha que **sólo apunta hacia abajo**, y las
tres de arriba están hoy vigiladas por `architecture.test.ts`.

---

## 2. Corte 1 — Identidad: el jugador como raíz

Hoy la raíz del modelo es el **reino**. Debe ser el **jugador**.

```
Player ──1:N── Realm ──1:N── Saga ──1:N── Campaign ──1:N── Act ──1:N── Quest
   │                                                                     │
   └── Credential / AgentGrant                                        Battle
```

Un jugador tiene normalmente un reino. Modelarlo así igualmente cuesta lo mismo
hoy y evita la migración del día que existan personajes, temporadas o partidas
compartidas.

**Dos identidades, no una** (art. 11):

| | Jugador | Agente |
|---|---|---|
| Origen | APK / web | ChatGPT, Claude, Codex por MCP |
| Prueba | sesión con refresco | *grant* por jugador, con alcance |
| Alcance | todo lo suyo | lo que el jugador le concedió |
| Revocación | cerrar sesión | revocar el *grant*, sin tocar la sesión |
| Hoy | ❌ nada | ⚠️ token estático compartido, opcional |

El *grant* de agente es lo que hace que «ChatGPT juega mi partida» sea una
función de producto y no un agujero: el jugador ve qué agentes tienen acceso,
qué hicieron y puede cortarlos de uno en uno.

**Sobre Play Store:** identidad y borrado de cuenta no son opcionales. La ficha
exige declarar qué datos se recogen y ofrecer eliminación. Con el modelo actual
—un JSON global sin dueño— esa declaración no se puede hacer con verdad.

---

## 3. Corte 2 — Persistencia: separar el estado del log

El error de raíz es que **un mismo documento es la base de datos, el log de
auditoría y el DTO**. Se separan en tres cosas con vidas distintas:

| | Qué es | Crece | Se lee |
|---|---|---|---|
| **Estado** | el reino actual | acotado | siempre |
| **Log de eventos** | `Evidence → LifeEvent → GameEvent`, append-only | sin techo | por rango |
| **Proyecciones** | vistas por pantalla | derivadas | por pantalla |

**Motor:** SQLite (mismo proceso, un archivo en el volumen Fly, transacciones
reales, `WAL`) resuelve concurrencia, atomicidad y consultas por rango sin
cambiar de infraestructura ni de precio. Postgres cuando haya más de una
máquina. El Núcleo no se entera de la diferencia (art. 6), y ese es justamente
el motivo de que el artículo 6 exista.

Lo que se gana, en el orden en que importa:

1. **La auditoría deja de borrarse.** Un log en su propia tabla no necesita
   `slice(0, 200)`. El artículo 3 se puede cumplir de verdad.
2. **Una operación es una transacción.** Se acaba la lectura-modificación-
   escritura partida entre llamadas HTTP.
3. **Escrituras O(cambio)**, no O(estado completo).
4. **Migraciones versionadas y ejecutadas una vez**, no en cada lectura.

**Migraciones** (art. 20): pasan de rellenos `??=` dispersos en el lector a un
directorio `migrations/NNNN-nombre.ts`, cada una declarando desde qué versión
sube, idempotente, ejecutada al arrancar y registrada. La lógica delicada —«una
migración no puede resucitar al enemigo»— sale del almacén y se convierte en una
migración con nombre y prueba.

---

## 4. Corte 3 — El contrato: proyecciones, versión y empuje

Tres cambios, en este orden:

**(a) Deja de mandarse el estado crudo.** `RealmSnapshot.realm: RealmState`
desaparece del contrato público. Cada pantalla pide su vista:

```
GET /v1/realm/summary        → bastión: personaje, tesoro, frentes abiertos, avisos
GET /v1/fronts               → lista de Battles vivas
GET /v1/battle/{questId}     → el frente: grupo, Horda, reloj, contrato
GET /v1/quests/{id}          → expediente: pasos, artefactos, veredictos
GET /v1/events?since={id}    → el log, paginado, nunca entero
```

**(b) Versión y evolución aditiva** (art. 13). `/v1` en la ruta,
`schemaVersion` en el sobre de la respuesta, y dentro de la mayor sólo se añade.
Una APK de hace seis meses sigue funcionando o se le dice explícitamente que
actualice; lo que no puede es recibir un campo que cambió de tipo.

**(c) Empuje en vez de sondeo.** SSE sobre el log de eventos:

```
GET /v1/stream            → eventos nuevos según ocurren
```

El cliente carga la vista una vez y aplica eventos. El sondeo cada 1,5 s del
mundo entero pasa de ~8 GB/día por cliente a un flujo de kilobytes. Push nativo
(FCM) queda para cuando la app está cerrada; **el registro sigue siendo la
verdad y la push sólo una entrega**, como ya está bien planteado hoy.

---

## 5. Corte 4 — Confianza: el juez no obedece a la evidencia

El juez lee texto que escribió alguien que no es el jugador ni nosotros. Tres
defensas, ninguna cara:

1. **Delimitar y etiquetar.** El extracto de un artefacto entra al prompt dentro
   de un bloque marcado como dato no confiable, con instrucción explícita de que
   nada de ahí dentro son órdenes.
2. **Separar lo comprobado de lo afirmado.** El prompt distingue tipográfica y
   semánticamente lo que el servidor verificó (hash, tamaño, tipo, existencia)
   de lo que alguien declara.
3. **El Núcleo sigue acotando.** Ya lo hace y se mantiene: el veredicto del
   modelo nunca concede más de lo que el paso permite ni cierra con declaración
   un paso que pactó archivo.

Detalle: 1 y 2 son de una tarde. Es la relación coste/riesgo más favorable de
todo este documento.

---

## 6. Unity

El contrato de cliente completo está en
[03-CONTRATO-DE-CLIENTE.md](03-CONTRATO-DE-CLIENTE.md). En una frase: **Unity no
porta ninguna regla**. Lee proyecciones, se suscribe a eventos, y dibuja.

Lo que hay que tener listo **antes** de que empiece el proyecto Unity:

1. Proyecciones por pantalla (§4a) — o Unity se acopla al estado persistido.
2. Contrato versionado (§4b) — o cada cambio del Núcleo rompe el build de Unity.
3. Contrato **generado** para C# (ADR-0005) — o hay una tercera copia a mano.
4. SSE (§4c) — o Unity nace sondeando.
5. Identidad (§2) — o el primer usuario que no seas tú es una reescritura.

Ese es exactamente el contenido de las etapas 1–4 de la hoja de ruta, y el
motivo de que estén en ese orden.

---

## 7. Lo que NO se hace

Decisiones tomadas en contra, para que nadie las reabra sin motivo nuevo:

- **No microservicios.** Un despliegue, un proceso. El problema es de límites
  internos, no de red.
- **No event sourcing puro.** Log de eventos append-only sí; reconstruir todo el
  estado desde el log en cada arranque, no.
- **No Kubernetes, no cola de mensajes, no caché distribuida.** Nada de eso
  resuelve ninguno de los cuatro cortes.
- **No reescritura del Núcleo.** Los módulos de dominio se quedan. Lo que se
  parte es el orquestador y lo que se cambia es la infraestructura.
- **No modo offline con reglas en el cliente.** Se puede cachear la última vista
  para mostrarla en gris; no se puede jugar sin Núcleo (art. 15).
