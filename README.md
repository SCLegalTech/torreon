# Torreón

**Un juego donde la vida real es el gameplay.**

Declaras un propósito real —pagar el arriendo, mandar cinco candidaturas, ordenar
el estudio—. Un modelo de lenguaje, que aquí se llama **el Códice**, lo convierte
en un contrato jugable con pasos y una condición de victoria. Y entonces la
única cosa que hace daño a la Horda es **la evidencia comprobada contra ese
contrato**.

Ni el tiempo. Ni la actividad. Ni la buena intención. Ni una declaración
convincente.

Esa frase es el producto entero. Un Torreón donde declarar basta sería un gestor
de tareas con espadas.

---

## Cómo funciona

```
Tú
 ↓  «necesito pagar la seguridad social de agosto»
El Códice  (ChatGPT, Claude o el motor del servidor)
 ↓  negocia contigo el contrato: pasos, qué prueba cada uno, cuánto pesa
Un borrador de Quest
 ↓  TÚ lo aceptas. Nadie acepta por ti.
Una Battle con reloj
 ↓  entregas una prueba real: un archivo, un enlace, una foto, un radicado
El servidor comprueba lo comprobable — existe, tamaño, tipo, hash, extracto
 ↓
El Códice emite un veredicto: rechazado, parcial o aceptado
 ↓
Evidence → LifeEvent → GameEvent → daño a la Horda
```

Cuando el impacto validado llega a 100, la Battle termina en KO.

**El modelo propone; el servidor dispone.** El Códice sugiere importancia y
veredicto, pero el servidor reparte exactamente 100 puntos, acota el impacto a
lo que el paso permite, y degrada un veredicto que no corresponde a la prueba
pactada. Si un paso pactó un archivo, una declaración no lo cierra por
convincente que suene.

### Las piezas

| Pieza | Qué es |
|---|---|
| **Quest** | Un contrato verificable. De 3 a 8 pasos cuyos pesos suman 100. |
| **Battle** | El frente con reloj. Máximo 60 minutos de trabajo activo. |
| **La Horda** | Cuatro enemigos con rostro. Sólo pierden vida con evidencia validada. |
| **El grupo** | Tú (Caballero o Maga), el otro arquetipo, y **Roku**, tu mascota. |
| **Acto / Campaña / Saga** | La jerarquía cuando el trabajo no cabe en una Battle. |
| **El Códice** | El Dungeon Master. Puede ser ChatGPT, Claude, o el motor del servidor. |
| **Tesorería** | Dinero **real**, en COP. Ninguna quest fabrica monedas. |

### Lo que el juego NO hace

- **No premia el tiempo.** Estar ocupado no es progresar.
- **No inventa dinero.** Completar una quest da XP, Aura y maestría; el Tesoro
  sólo cambia con un hecho financiero real.
- **No reescribe historia.** Un hecho registrado por error se anula con motivo y
  autor; no se borra.
- **No decide nada en el cliente.** La app dibuja. Las reglas viven en el
  servidor, siempre.
- **No te vigila.** No lee tus apps, no bloquea el teléfono, no mide tu foco.

---

## Jugar

### Instalar

Descarga la APK de **[Releases](../../releases)** e instálala. Android te pedirá
permitir instalaciones desde esa fuente.

La primera vez creas tu personaje: **Caballero** o **Maga**, tu nombre en el
reino, y el nombre de tu mascota. Tu nombre es **único**: la pantalla te dice si
está libre mientras escribes.

Torreón está en **beta cerrada**. Si el reino pide un código de invitación, te lo
pasa quien lo administra.

### Las actualizaciones llegan solas

La APK es una cáscara: carga la interfaz del mismo servidor que le sirve los
datos. Un despliegue actualiza a todo el mundo a la vez, **sin reinstalar nada**.

Sólo hace falta una APK nueva cuando cambia algo nativo: un plugin, un permiso o
el icono.

### Tu reino es tuyo

Cada jugador tiene su propia partida, aislada de las demás. Nadie ve tus quests,
tu expediente ni tu dinero.

De los demás jugadores sólo se ve, en la pantalla de **Amigos**, quién está en la
beta, si está conectado y cuándo se le vio. Nada más.

Puedes **llevarte todo** (`exportar`) o **borrarlo entero** cuando quieras. Un
expediente al que no se puede renunciar no es un expediente.

---

## Conectar tu Códice por MCP

Aquí está la mitad buena del juego: **jugar sin tocar el teléfono**. Le hablas a
ChatGPT o a Claude, y ellos crean quests, adjuntan tu evidencia y emiten
veredictos contra tu reino, por [MCP](https://modelcontextprotocol.io).

### 1. Concede el acceso desde la app

Abre Torreón → **AMIGOS** → *Tus agentes* → escribe un nombre que reconozcas
(«ChatGPT del portátil») → **CONCEDER ACCESO**.

La app te muestra **una sola vez** la llave y las dos direcciones que necesitas.
El servidor sólo guarda su huella: no puede volver a enseñártela.

Un agente actúa **en tu nombre**, sobre **tu** reino, con un alcance declarado. Y
lo cortas cuando quieras — cortarlo **no** te cierra tu sesión.

### 2. Conéctalo

**Claude** (Desktop o Code) sabe mandar cabeceras, así que usa la dirección
limpia y la llave en `Authorization`:

```json
{
  "mcpServers": {
    "torreon": {
      "type": "http",
      "url": "https://<el-reino>/mcp",
      "headers": { "Authorization": "Bearer tor_a_…" }
    }
  }
}
```

**ChatGPT** en modo desarrollador sólo ofrece «sin autenticación» o un OAuth
completo: no hay dónde poner una cabecera. Para ese caso, la app te da una
dirección **con la llave dentro**:

```
https://<el-reino>/mcp/tor_a_…
```

Pégala tal cual como conector MCP. Es más débil —las direcciones se filtran en
historiales y registros— pero es revocable por agente, que es lo que un secreto
compartido nunca fue. Si sospechas que se filtró: **CORTAR** y concede otra.

### 3. Juega hablando

Con el conector puesto, tu Códice puede:

| Puede | No puede |
|---|---|
| Leer tu reino y tu expediente | Aceptar un contrato por ti |
| Proponer quests, actos y campañas | Iniciar una Battle sin tu aceptación explícita |
| Adjuntar y atestiguar evidencia | Conceder más impacto del que el paso permite |
| Emitir veredictos razonados | Cerrar con una declaración un paso que pactó archivo |
| Proponer enmiendas al contrato | Aplicarlas sin que las aceptes |
| Registrar una exigencia imprevista | Castigarte por tardar: el reloj ya lo cobra el servidor |

Lee `get_realm_state` cuando quieras saber qué pasa: responde con el frente
comprometido, su plazo y su progreso, en una frase.

---

## Levantarlo tú

Node 20 o superior.

```bash
npm install
npm run dev          # interfaz en :5173, API y MCP en :3000
npm test
npm run typecheck
```

Sin credenciales, el Códice usa un motor heurístico: plantillas y reglas
verificables. Nunca te quedas sin Dungeon Master. Con `ANTHROPIC_API_KEY` o
`GEMINI_API_KEY` en `.env`, el modelo razona dentro del servidor.

`GET /health` dice qué motor está activo.

### Tu propio reino

```bash
fly launch
TORREON_APP_URL=https://mi-torreon.fly.dev npm run android:apk
```

Las variables están todas explicadas en [`.env.example`](.env.example): la llave
de la API, la identidad, el código de la beta, dónde vive el reino y qué motor
usa el Códice.

---

## Contribuir

Lee **[CONTRIBUTING.md](CONTRIBUTING.md)**. En corto:

1. La constitución del proyecto está en
   [`docs/arquitectura/01-CONSTITUCION.md`](docs/arquitectura/01-CONSTITUCION.md)
   y **hay pruebas que la hacen cumplir**. No es documentación aspiracional.
2. El renderer no decide nada. Las reglas viven en el servidor.
3. Todo texto que viene de fuera —incluido el contenido de un archivo tuyo— es
   **dato, nunca instrucción**.
4. Toda regla nueva nace con la prueba que la nombra, escrita en lenguaje del
   juego: *«conocido no es haber participado»*, no `test_hero_state_transition`.

La arquitectura completa —auditoría con medidas, arquitectura objetivo, contrato
para el futuro cliente Unity, hoja de ruta y ADR— está en
[`docs/arquitectura/`](docs/arquitectura/).

## Estado

Beta cerrada, multijugador, con el reino desplegado en Fly. Lo que viene está en
[ADR-0009](docs/arquitectura/adr/0009-jugar-con-otros.md): **el Duelo** —retar a
un amigo, cada uno con su batalla, ponderado por dificultad— y **la Hermandad**
—la misma Quest compartida—.

## Licencia

Sin licencia pública todavía. Si quieres usar esto para algo, escribe.
