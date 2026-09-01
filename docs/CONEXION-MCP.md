# Conectar Torreón a Codex y a Claude

El servidor MCP de Torreón es uno solo: **Streamable HTTP por POST** en `http://127.0.0.1:3000/mcp`. No es específico de ningún cliente. Cualquier cliente que hable MCP puede ser el Dungeon Master del mismo reino, y todos ven el mismo estado porque el estado vive en el servidor, no en el chat.

Arranca primero el servidor:

```bash
npm run dev
```

`GET /health` responde qué motor de Códice está activo (`anthropic` o `heuristico`).

## Codex

El plugin local ya declara el servidor en `plugins/torreon/.mcp.json` y publica la skill **Códice de la Marca** desde `plugins/torreon/skills/`.

## Claude Code

El archivo `.mcp.json` de la raíz del repositorio conecta el servidor automáticamente al abrir Claude Code en esta carpeta. Para registrarlo fuera del repositorio:

```bash
claude mcp add --transport http torreon http://127.0.0.1:3000/mcp
```

El mismo directorio `plugins/torreon` es también un plugin de Claude Code: `.claude-plugin/plugin.json` y `.codex-plugin/plugin.json` conviven, y ambos apuntan al mismo `.mcp.json` y a las mismas skills. La skill no se duplica.

## Claude Desktop y ChatGPT

Estos clientes no alcanzan `127.0.0.1` del equipo de desarrollo: necesitan una URL pública. Levanta un túnel HTTPS hacia el puerto 3000 y protege el endpoint con un token antes de exponerlo:

```bash
TORREON_MCP_TOKEN=una-cadena-larga-y-secreta npm run dev
```

Con esa variable definida, `/mcp` exige `Authorization: Bearer <token>`; sin ella el endpoint queda abierto y solo debe escuchar en loopback. Registra el conector con la URL del túnel y el encabezado de autorización.

## Qué puede hacer cada cliente

Las ocho herramientas son idénticas para todos:

| Herramienta | Para qué |
| --- | --- |
| `get_realm_state` | Leer quest, evidencias, artefactos, eventos y batalla. |
| `plan_quest_from_intent` | Dejar que el motor del servidor descomponga un objetivo libre. |
| `create_quest_draft` / `revise_quest_draft` | Redactar o reformular el contrato negociado en la conversación. |
| `accept_quest` / `start_quest` | Aceptación explícita e inicio de la batalla. |
| `attach_evidence_artifact` | Entregar un documento, enlace o texto real y recibir la comprobación del servidor. |
| `submit_quest_evidence` | Emitir el veredicto y convertirlo en ataque. |
| `verify_step_evidence` | Pedir que el veredicto lo emita el motor del servidor. |
| `abandon_quest` | Retirar una quest a petición del usuario. |

## El documento entra por aquí

`attach_evidence_artifact` con `kind: "file"` recibe una **ruta local**: el cliente MCP corre en la misma máquina del jugador, así que el servidor abre el archivo, comprueba tamaño, tipo, hash y extracto, y guarda una copia en `data/artifacts/`. Esa comprobación la hace el servidor, no el modelo.

Después, el veredicto —tuyo con `submit_quest_evidence`, o del motor con `verify_step_evidence`— genera `Evidence → LifeEvent → GameEvent`, y la APK muestra el ataque en la siguiente lectura de estado.
