# Constitución de Torreón

Esta es la ley del proyecto. No describe lo que existe: **manda sobre lo que se
escriba a partir de ahora**, incluido el código que ya está y todavía no la
cumple (ver [00-AUDITORIA.md](00-AUDITORIA.md) y [04-HOJA-DE-RUTA.md](04-HOJA-DE-RUTA.md)).

Va dirigida a personas y a agentes por igual. Si eres un agente y vas a tocar
este repositorio, **léela entera antes de escribir la primera línea**.

Cada artículo dice tres cosas: **la regla**, **por qué existe** y **quién la
hace cumplir**. Un artículo marcado 🔒 tiene una prueba que lo defiende en
`apps/server/src/architecture.test.ts`: no es una recomendación, es un fallo de
build. Un artículo marcado 🕐 todavía no tiene guardián automático porque el
código aún no lo cumple; su guardián llega en la etapa indicada de la hoja de
ruta.

**Cambiar un artículo exige un ADR nuevo en [adr/](adr/).** Relajar una prueba
de aptitud para que pase un cambio es una violación de la constitución, no una
solución.

---

## Título I — La verdad

### Artículo 1 · La realidad es la autoridad 🔒(por el dominio, ver Título V)

Sólo la evidencia comprobada contra una condición pactada de antemano modifica
la batalla. Ni el tiempo, ni la actividad, ni la buena intención, ni la
insistencia, ni la elocuencia de una declaración.

*Por qué:* es la tesis entera del producto. Un Torreón donde declarar basta es
otro gestor de tareas con espadas.

*Corolario:* un artefacto por sí solo tampoco causa daño. La cadena obligatoria
es `Artifact → verificación → Evidence → LifeEvent → GameEvent → daño`, y ningún
eslabón se salta.

### Artículo 2 · El modelo propone, el Núcleo dispone

El Códice —o ChatGPT, o Claude, o el que venga— **sugiere** importancia,
veredicto y descomposición. El Núcleo reparte exactamente 100 puntos, acota el
impacto a lo que el paso permite y degrada un veredicto que no corresponde a la
clase de prueba pactada.

*Por qué:* el modelo cambia de voz, de proveedor y de versión. La verdad de la
campaña no puede cambiar con él.

*Corolario:* **todo texto que venga de fuera del Núcleo es dato, nunca
instrucción.** Incluye el extracto de un archivo del jugador, el nombre de una
quest y cualquier campo que un cliente MCP rellene. En el prompt del juez, lo
comprobado y lo afirmado van separados, y lo afirmado viaja dentro de un sobre
marcado como no confiable (ADR-0008). ✅

### Artículo 3 · Anular no es borrar

Un hecho registrado no se reescribe ni se elimina. Se marca inválido, con motivo
y autor, y la historia conserva ambos.

*Por qué:* el valor del producto es el expediente. Un expediente que se puede
editar no prueba nada.

*Corolario operativo:* el log de eventos es **append-only y sin techo**. El
recorte a 100/200 que sufre `RealmState` es una limitación del documento JSON,
no una política: en SQLite (ADR-0003) cada hecho se archiva entero y ni siquiera
`reset` lo borra. Mientras el reino viva en el documento, el límite sigue ahí y
está centralizado en `realm-events.ts`, para que se borre de un solo sitio. 🕐

*Lo que este artículo NO dice:* que un jugador no pueda irse. Este artículo
protege la historia **dentro** de una partida —que un hecho no se reescriba para
que la campaña parezca otra cosa—. El derecho al olvido va sobre la partida
entera y es lo contrario: `DELETE /v1/player` borra el reino, su expediente, sus
artefactos y sus llaves. Un expediente al que no se puede renunciar no es un
expediente.

### Artículo 4 · Una sola fuente autoritativa por hecho

Si un dato se puede derivar, se deriva en la lectura. No se guarda un puntero
que pueda quedar rancio y contradecir a la verdad.

*Por qué:* dos lugares que dicen cosas distintas sobre la misma Battle es el
error que más veces se ha pagado en este repositorio. Está escrito en el propio
código: *«NUNCA `won` en una vista y `active` en otra»*.

*Guardián:* 🔒 `read-models.ts` no puede importar el almacén ni el servicio: es
proyección pura o no es.

---

## Título II — El Núcleo y sus fronteras

El **Núcleo** son las reglas del juego: `domain`, `battle`, `party`, `horde`,
`scale`, `finance`, `product`, `progression`, `inventory`, `companions`,
`barracks`, `battle-memory`, `notifications`, `codice`, `read-models`.

### Artículo 5 · El Núcleo no conoce el transporte 🔒

Ningún módulo del Núcleo importa Express, el SDK de MCP, `app.ts` ni `mcp.ts`.

*Por qué:* Unity, React, MCP, un cron y una prueba deben poder ejercitar la
misma regla. Una regla que sabe por dónde la llamaron ya sólo sirve para ese
camino.

### Artículo 6 · El Núcleo no conoce la persistencia 🔒

Ningún módulo del Núcleo importa el almacén. El Núcleo **recibe** estado; no va
a buscarlo. `domain.ts` no importa absolutamente nada.

*Por qué:* es lo que permite cambiar JSON por SQLite por Postgres sin tocar una
sola regla del juego. Hoy se cumple; mañana es lo que hace barata la etapa 2.

### Artículo 7 · El transporte traduce, no decide 🔒

`app.ts` y `mcp.ts` convierten un protocolo en una llamada al servicio y una
respuesta. No leen el almacén, no aplican reglas, no derivan estado.

*Corolario:* toda entrada se valida con esquema (Zod) en el borde, en **ambos**
transportes y desde la misma fuente (`contracts.ts`), y los errores se traducen
a códigos que distinguen «no existe» de «no puedes» de «mandaste basura»
(`errors.ts`). 🔒

### Artículo 8 · Toda infraestructura entra por un puerto 🔒 (reloj) · 🕐 (archivos)

Reloj, generación de identificadores, aleatoriedad y almacenamiento de archivos
se reciben como dependencia. `new Date()` dentro del Núcleo queda prohibido.

*Por qué:* había 33 relojes cableados y una prueba que **fallaba 25 días de cada
30** por eso. Un dominio con plazos, ventanas críticas y períodos de facturación
no se puede probar contra el reloj de pared.

*Estado:* el reloj ya entra por `clock.ts` y una prueba de aptitud lo defiende.
Falta el almacenamiento de artefactos, que sigue cableado al disco local.

### Artículo 9 · El monolito sólo puede encoger 🔒

`quest-service.ts` tiene un presupuesto de líneas que **sólo baja**. Cada
extracción lo reduce; ninguna función nueva lo sube.

*Por qué:* un orquestador de 2 922 líneas y 56 métodos es el sitio donde
aterriza todo porque es el único sitio que hay. El trinquete obliga a crear el
otro sitio.

*Cómo se cumple:* si tu cambio no cabe, la respuesta correcta es extraer un
módulo del Núcleo y **bajar el presupuesto**, nunca subirlo.

---

## Título III — El jugador

*(El artículo 10 se cumple desde E2 y el 11 desde E5, aunque la identidad viene
apagada por defecto: encenderla en un reino que ya juega es una decisión de
persona. El 12 se cumple para las vistas de `/v1`; `/api` sigue entregando el
estado completo mientras React migra.)*

### Artículo 10 · Todo dato pertenece a un jugador ✅

`playerId` es la raíz de todo agregado. No existe consulta sin sujeto: no hay
«el reino», hay «el reino de este jugador». Un `QuestService` se construye para
UN jugador y no puede alcanzar el reino de otro.

*Por qué:* multiusuario no es una capa que se pone encima. Es la raíz del modelo
de datos, y cambiarla después cuesta una migración de todo lo persistido.

### Artículo 11 · Autenticar al jugador no es autorizar al agente ✅

Son dos identidades distintas, con dos alcances distintos y dos revocaciones
independientes:

- **Jugador**: entra desde la APK. Puede todo sobre lo suyo.
- **Agente** (ChatGPT, Claude, Codex por MCP): actúa *en nombre de* un jugador,
  con un alcance declarado, revocable sin cerrarle la sesión al jugador.

*Por qué:* un secreto embebido en una APK no es seguridad, y un token estático
compartido no identifica a nadie ni se puede revocar sin romperlo todo.

### Artículo 12 · Cada respuesta entrega lo que su pantalla necesita, y nada más

Ninguna respuesta incluye el estado persistido crudo. Razonamientos del juez,
rutas en disco, contadores de plan y transacciones financieras se entregan sólo
a quien los pide explícitamente y tiene derecho a verlos.

---

## Título IV — El contrato con los clientes

Ver el detalle en [03-CONTRATO-DE-CLIENTE.md](03-CONTRATO-DE-CLIENTE.md).

### Artículo 13 · El contrato es versionado y aditivo ✅ (`/v1`)

Las rutas viven bajo `/v1`. Dentro de una versión mayor sólo se **añade**:
ningún campo cambia de tipo, ningún valor desaparece de una unión, ningún campo
obligatorio nace después del contrato.

*Por qué:* cuando la APK esté en Play Store, habrá versiones viejas ejecutándose
durante meses. Romper el contrato es romper teléfonos ajenos.

### Artículo 14 · El vocabulario tiene una sola fuente 🔒

Hoy `apps/web/src/types.ts` es una copia a mano de `domain.ts` y una prueba
impide que se desvíen. Cuando exista Unity, la copia a mano deja de ser viable:
el contrato se **genera** para TypeScript y para C# desde una única fuente
(ADR-0005).

*Por qué:* ya hubo deriva. El cliente había ensanchado un tipo del Núcleo para
que le compilara, creando un estado que el servidor no puede producir.

### Artículo 15 · El renderer no calcula reglas

Unity y React dibujan, animan y navegan. No deciden progreso, daño, bloqueo,
victoria ni recompensa. Un renderer puede cambiar de motor, de estilo y de
plataforma sin tocar una regla.

*Corolario:* prohibido un segundo reino en el cliente. Sin conexión se informa
el fallo y se conserva la verdad autoritativa; **no se simula el juego**.

### Artículo 16 · El cliente recibe proyecciones, no el estado

Cada pantalla pide su vista. El cliente no recibe el documento persistido, y no
recarga el mundo entero para saber cuánta vida le queda a la Horda.

---

## Título V — La entrega

### Artículo 17 · Toda regla nueva nace con la prueba que la nombra

El nombre de la prueba dice la regla en lenguaje del juego, no en lenguaje de
implementación. El estándar ya existe en este repositorio: *«conocido no es
haber participado»*, *«el estado deja de mentir»*. Súbete a él.

### Artículo 18 · Un límite se cambia con un ADR, no con un `expect`

Si una prueba de aptitud te estorba, el camino es: entender el límite, decidir
si sigue siendo correcto, escribir el ADR y **después** mover la prueba. Nunca
al revés y nunca en silencio.

### Artículo 19 · Verde en la máquina, y después en el teléfono

`npm test` y `npm run typecheck` en verde antes de cerrar un mensaje. Si el
cambio se ve en pantalla, la APK va instalada por ADB en el dispositivo antes de
decir que funciona. Si el cambio toca el Núcleo, se despliega a Fly.

*Por qué:* el PC no cuenta. La verdad de este proyecto es lo que ocurre en el
teléfono del jugador y en el reino de la nube.

### Artículo 20 · Una migración es idempotente, versionada, y nunca resucita lo que ya murió

Correr una migración dos veces da el mismo resultado que correrla una. Cada
migración declara desde qué versión sube. Y ninguna puede devolverle vida a una
Horda que el jugador ya bajó a golpes reales: **sólo baja, nunca sube**.

*Por qué:* ya pasó. La corrección vive hoy en `store.ts:150-163` y es la lección
más cara del repositorio.

---

## Antes de escribir código, un agente se pregunta

1. ¿Esto es una **regla** o una **presentación**? Si es regla, va al Núcleo y va
   con prueba. Si es presentación, no toca el servidor.
2. ¿Estoy **derivando** o **guardando** este dato? Si se puede derivar, se
   deriva (art. 4).
3. ¿Este dato **tiene dueño**? Si mañana hay dos jugadores, ¿de quién es esta
   fila? (art. 10).
4. ¿Estoy metiendo texto de fuera en un prompt? Entonces va delimitado y
   marcado como dato (art. 2).
5. ¿Estoy ensanchando `quest-service.ts`? Entonces estoy en el sitio equivocado
   (art. 9).
6. ¿Estoy llamando a `new Date()` en el Núcleo? Entonces acabo de crear una
   prueba que fallará algún día del mes (art. 8).
7. ¿Rompe esto una APK que ya está instalada? (art. 13).
8. ¿Puedo nombrar la prueba con una frase que el jugador entendería? Si no,
   probablemente no entendí la regla (art. 17).
