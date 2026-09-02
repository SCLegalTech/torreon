# Torreón

MVP de **Real Gameplay**: Códice convierte cualquier propósito real en una quest, el servidor MCP guarda el contrato y únicamente la evidencia validada modifica la batalla. El alcance exacto está en [docs/MVP-SLICE-1.md](docs/MVP-SLICE-1.md).

## Ejecutar el MVP

Requisitos: Node.js 20 o superior.

```bash
npm install
npm run dev
```

- Interfaz: `http://127.0.0.1:5173`
- MCP: `http://127.0.0.1:3000/mcp`
- Salud: `http://127.0.0.1:3000/health`

Para probar una compilación integrada:

```bash
npm run build
npm start
```

Entonces la interfaz y MCP quedan servidos en `http://127.0.0.1:3000`.

## El Códice como motor

El Dungeon Master es un contrato, no una plantilla: `apps/server/src/codice.ts` define `plan` (objetivo libre -> contrato jugable) y `judge` (evidencia -> veredicto e impacto). Dos runtimes lo cumplen:

- **`anthropic`**: con `ANTHROPIC_API_KEY` definida, el modelo razona dentro del servidor. Así el jugador puede declarar cualquier objetivo desde el propio juego, sin tener un chat abierto.
- **`heuristico`**: sin credenciales, plantillas y reglas verificables. El MVP nunca se queda sin Dungeon Master.

Cuando el jugador habla con Codex o Claude, el modelo del cliente cumple el mismo contrato desde fuera llamando a las herramientas MCP. El servidor conserva siempre las reglas de daño: el modelo propone importancia relativa, el servidor reparte exactamente 100 puntos; el modelo propone veredicto, el servidor lo acota a lo que el paso permite.

`GET /health` informa qué motor está activo.

## Probar MCP

Con el servidor activo:

```bash
npx @modelcontextprotocol/inspector@latest
```

En el Inspector, seleccionar **Streamable HTTP** y usar `http://127.0.0.1:3000/mcp`.

El endpoint local no tiene autenticación y escucha únicamente en loopback por defecto. Con `TORREON_MCP_TOKEN` definido, `/mcp` exige `Authorization: Bearer <token>`, que es lo que permite exponerlo por túnel a Claude Desktop o ChatGPT. El despliegue posterior tendrá aplicación Fly, secretos y almacenamiento separados de Opus.

El mismo servidor sirve a Codex y a Claude: los pasos de conexión de cada cliente están en [docs/CONEXION-MCP.md](docs/CONEXION-MCP.md).

## Flujo demostrable

1. ChatGPT consulta `get_realm_state`.
2. El Códice negocia propósito, restricciones, pasos y evidencia.
3. Tras aprobación explícita llama `create_quest_draft`, `accept_quest` y `start_quest`.
4. La interfaz detecta la misión activa.
5. El jugador entrega una prueba real con `attach_evidence_artifact`: un documento, un enlace o un texto. El servidor comprueba lo comprobable —existencia, tamaño, tipo, hash, extracto— y guarda copia del documento en `data/artifacts/`.
6. Códice evalúa esa prueba con `submit_quest_evidence` (o `verify_step_evidence` si juzga el motor): rechazada, parcial o aceptada.
7. El servidor registra `Evidence → LifeEvent → GameEvent`; solo el impacto validado reduce la vida de la horda, y la batalla muestra el ataque.
8. Al alcanzar 100 puntos verificados, la quest termina en KO.

El artefacto por sí solo nunca causa daño, y una declaración sin prueba comprobada no puede completar un paso. Esa es la diferencia entre actividad y progreso.

La opción **Cargar quest demostrativa** permite recorrer el contrato sin conectar Codex.

## Android

La aplicación usa Capacitor 7, orientación horizontal y una única interfaz React para web y Android. Mientras Torreon está visible, Android mantiene la pantalla encendida para que la batalla pueda acompañar una sesión de trabajo. En gameplay normal la APK utiliza `https://torreon.fly.dev`, el mismo Realm persistente que consulta ChatGPT mediante MCP. No crea un segundo reino silencioso cuando pierde conexión: informa el fallo y conserva la verdad autoritativa.

El dominio del juego es independiente del renderer: quests, amendments, evidencia, eventos y salud bilateral viven en el Core/servidor. React es el cliente visual transitorio del MVP; Unity podrá consumir esos mismos DTO y eventos sin reescribir las reglas ni migrar la verdad de la campaña.

Requisitos de compilación: JDK 21, Android SDK Platform 35, Build Tools 35 y Platform Tools. Con esas herramientas disponibles en `JAVA_HOME` y `ANDROID_HOME`:

```powershell
npm run android:apk
npm run android:install
```

La segunda orden compila, instala por ADB, crea el puente local y abre `com.solvecoagula.torreon`. La APK de depuración queda en `android/app/build/outputs/apk/debug/app-debug.apk`.

## Plugin local de Codex y Claude

El paquete `plugins/torreon` publica las herramientas MCP y la skill **Códice de la Marca**. El mismo directorio es plugin de Codex (`.codex-plugin/`) y de Claude Code (`.claude-plugin/`): comparten `.mcp.json` y `skills/`, así que la skill no se duplica. Se mantiene separado del proyecto y del MCP de Opus; ambos procesos pueden evolucionar sin mezclar estado ni despliegues.

En el vivo V2436 de prueba, un administrador de seguridad llamado Cetro/Guard puede poner paquetes ADB nuevos en cuarentena. Si aparece **«Tu administrador borró este paquete»**, se debe autorizar `com.solvecoagula.torreon` en ese administrador y volver a ejecutar `npm run android:install`; el script confirma que la aplicación siga instalada antes de intentar abrirla.

## Arte animable

Los mockups iniciales se conservan como referencias, pero ya no forman parte del fondo interactivo. La interfaz, sus acciones y paneles son componentes independientes. El formato exacto para escenarios y sprites está en [docs/ARTE-Y-SPRITES.md](docs/ARTE-Y-SPRITES.md).
