# Torreón en la nube y conexión con ChatGPT

## Estado: desplegado

```
URL       https://torreon.fly.dev
MCP       https://torreon.fly.dev/mcp
Región    dfw (Fly no tiene región en Colombia; Dallas es la de menor latencia disponible)
Volumen   torreon_data (1 GB) montado en /data
Motor     gemini
Token     en secrets.local.txt, fuera de git
```

Verificado: sin `Authorization` el endpoint responde `-32001 Torreón requiere un token de acceso`; con el bearer correcto lista las doce herramientas.

## Por qué existe este despliegue

Codex y Claude Code corren en la máquina del jugador y alcanzan `127.0.0.1:3000`. ChatGPT no: su cliente MCP vive en los servidores de OpenAI y necesita una URL pública con HTTPS.

La aplicación es **propia de Torreón**: comparte proveedor con Opus, pero no comparte aplicación, secretos ni volumen.

## Principio que manda sobre el diseño de la evidencia

> La mejor manera de jugar Torreón es, frecuentemente, dejar de mirar Torreón.

Si para entregar una prueba el jugador tiene que tomar el teléfono en plena batalla, el juego está compitiendo con el trabajo real. Por eso **la evidencia entra por la conversación**, donde el jugador ya está trabajando y donde el archivo ya está abierto.

El Dungeon Master —ChatGPT, Codex o Claude— es quien tiene el documento delante y sabe leerlo. Su trabajo es mirarlo y declarar qué contiene.

## Las tres vías de evidencia, y qué distingue a cada una

| Herramienta | Cuándo | Quién comprueba |
| --- | --- | --- |
| `attest_evidence_artifact` | El archivo está cargado en la conversación del DM | `witness` — un modelo capaz de leerlo lo examinó y declaró qué vio |
| `attach_evidence_artifact` | El archivo está en el disco donde corre el MCP | `server` — abrió los bytes: tamaño, tipo, hash, extracto |
| Carga desde el juego | Respaldo, cuando no hay conversación abierta | `server` — recibió los bytes |

La primera es la vía principal para ChatGPT y la que permite jugar sin tocar el teléfono.

`attest_evidence_artifact` exige el campo `observed`: qué vio literalmente el testigo —fechas, cifras, estados, nombres—, no lo que el jugador afirma. Una atestiguación sin observación concreta se rechaza.

## La regla que ninguna vía puede saltarse

Si un paso pactó una prueba (`file`, `link` o `screenshot`) y no llegó **ningún** artefacto —ni comprobado por el servidor ni atestiguado por un testigo—, el veredicto no puede ser `accepted`. El servidor lo degrada a parcial automáticamente.

Vale para todos los motores, presentes y futuros. Está en `enforceArtifactRule`, con test.

## Conectar ChatGPT

Modo desarrollador → agregar conector MCP:

```
URL      https://torreon.fly.dev/mcp
Auth     Authorization: Bearer <token de secrets.local.txt>
```

Si la interfaz de ChatGPT no admite cabecera personalizada y exige OAuth, hay que añadir un proveedor OAuth al servidor. **No dejes el endpoint sin token**: es una URL pública y quedaría expuesto a que cualquiera cree quests, meta evidencia falsa o lea el reino.

## Operación

```bash
fly logs --app torreon
fly status --app torreon
fly secrets set GEMINI_API_KEY=... --app torreon
fly deploy --app torreon
```

El volumen guarda el reino y los artefactos. Si se pierde, se pierde la campaña.
