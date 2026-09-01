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

## Probar MCP

Con el servidor activo:

```bash
npx @modelcontextprotocol/inspector@latest
```

En el Inspector, seleccionar **Streamable HTTP** y usar `http://127.0.0.1:3000/mcp`.

El endpoint local no tiene autenticación y escucha únicamente en loopback por defecto. No debe publicarse. Para ChatGPT se usará Developer Mode con un túnel seguro durante pruebas; el despliegue posterior tendrá aplicación Fly, secretos y almacenamiento separados de Opus.

## Flujo demostrable

1. ChatGPT consulta `get_realm_state`.
2. El Códice negocia propósito, restricciones, pasos y evidencia.
3. Tras aprobación explícita llama `create_quest_draft`, `accept_quest` y `start_quest`.
4. La interfaz detecta la misión activa.
5. Códice evalúa evidencia con `submit_quest_evidence`: rechazada, parcial o aceptada.
6. El servidor registra `Evidence → LifeEvent → GameEvent`; solo el impacto validado reduce la vida de la horda.
7. Al alcanzar 100 puntos verificados, la quest termina en KO.

La opción **Cargar quest demostrativa** permite recorrer el contrato sin conectar Codex.

## Android

La aplicación usa Capacitor 7, orientación horizontal y una única interfaz React para web y Android. Durante el MVP, `adb reverse tcp:3000 tcp:3000` conecta la APK al servidor MCP local; si el servidor no está disponible, la misión demostrativa puede guardarse en el teléfono.

Requisitos de compilación: JDK 21, Android SDK Platform 35, Build Tools 35 y Platform Tools. Con esas herramientas disponibles en `JAVA_HOME` y `ANDROID_HOME`:

```powershell
npm run android:apk
npm run android:install
```

La segunda orden compila, instala por ADB, crea el puente local y abre `com.solvecoagula.torreon`. La APK de depuración queda en `android/app/build/outputs/apk/debug/app-debug.apk`.

## Plugin local de Codex

El paquete `plugins/torreon` publica ocho herramientas MCP y la skill **Códice de la Marca**. Se mantiene separado del proyecto y del MCP de Opus; ambos procesos pueden evolucionar sin mezclar estado ni despliegues.

En el vivo V2436 de prueba, un administrador de seguridad llamado Cetro/Guard puede poner paquetes ADB nuevos en cuarentena. Si aparece **«Tu administrador borró este paquete»**, se debe autorizar `com.solvecoagula.torreon` en ese administrador y volver a ejecutar `npm run android:install`; el script confirma que la aplicación siga instalada antes de intentar abrirla.

## Arte animable

Los mockups iniciales se conservan como referencias, pero ya no forman parte del fondo interactivo. La interfaz, sus acciones y paneles son componentes independientes. El formato exacto para escenarios y sprites está en [docs/ARTE-Y-SPRITES.md](docs/ARTE-Y-SPRITES.md).
