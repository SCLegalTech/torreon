# ADR-0007 · Dos identidades: sesión de jugador y concesión de agente

- **Estado:** propuesto (etapa 5)
- **Fecha:** 2026-09-06
- **Artículos:** 11, 12

## Contexto

Hoy no hay autenticación de jugador. Las 59 rutas `/api/*` de
`https://torreon.fly.dev` están abiertas, incluida `POST /api/reset`, que
destruye el reino. `Access-Control-Allow-Origin` es `*`.

Lo único que existe es `TORREON_MCP_TOKEN`: un token estático, compartido y
opcional que protege `/mcp`. No identifica a nadie y no se puede revocar sin
romperlo para todos.

Y hay una particularidad de este producto que no se puede ignorar: **los agentes
son jugadores de primera clase**. ChatGPT, Claude y Codex crean quests, adjuntan
evidencia y emiten veredictos por MCP. Eso no es una integración: es una de las
dos formas de jugar.

## Decisión

Dos identidades separadas, con dos ciclos de vida:

**Sesión de jugador.** Desde la APK o la web. Puede todo sobre lo suyo.

**Concesión de agente (`AgentGrant`).** Un agente actúa *en nombre de* un
jugador con un alcance declarado. Cada concesión se revoca por separado, sin
cerrarle la sesión al jugador, y toda acción hecha bajo ella queda atribuida al
agente en el log.

El jugador ve una pantalla con sus agentes conectados: qué alcance tienen, qué
hicieron y un botón para cortarlos.

`TORREON_MCP_TOKEN` se retira cuando esto exista.

## Consecuencias

**A favor:** desbloquea Play Store; hace del acceso de agentes una función
visible y auditable en vez de un secreto compartido; la atribución en el log
pasa a ser cierta —hoy `proposedBy` es una cadena que el llamante rellena.

**En contra:** los clientes MCP existentes tendrán que reconectarse con una
credencial nueva, y los que sólo ofrecen «sin autenticación» u OAuth completo
—ChatGPT entre ellos— obligan a implementar el flujo de concesión con cuidado.
La ruta secreta actual es un parche que **no** sobrevive a la publicación.

## Alternativas descartadas

- **Un token por jugador, y ya.** No distingue al jugador del agente: revocar a
  ChatGPT dejaría al jugador fuera de su propio reino.
- **Delegar todo a un proveedor de identidad desde el día uno.** Razonable para
  el jugador; no resuelve la concesión de agente, que es la parte específica de
  este producto.
