# Torreón

MVP de planificación financiera y enfoque convertido en una batalla persistente. ChatGPT negocia una quest, el servidor MCP guarda el contrato y cada paso verificado produce daño real en la batalla.

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
5. Cada `complete_quest_step` reduce la vida de la horda según el peso del paso.
6. Al completar todos los pasos, la quest termina en KO.

La opción **Invocar misión de prueba** permite recorrer el flujo sin conectar ChatGPT.

