# Torreón — manual para agentes

Si vas a tocar este repositorio, esto es lo primero que lees.

**Antes de escribir código, lee [docs/arquitectura/01-CONSTITUCION.md](docs/arquitectura/01-CONSTITUCION.md).**
No es documentación aspiracional: hay 47 pruebas que la hacen cumplir y un
build que se pone rojo.

---

## Qué es esto

Un juego donde **la vida real es el gameplay**. El jugador declara un propósito
real, el Códice (un modelo, dentro o fuera del servidor) lo convierte en un
contrato verificable, y **sólo la evidencia comprobada contra ese contrato causa
daño** a la Horda.

Esa frase es el producto entero. Un Torreón donde declarar basta es un gestor de
tareas con espadas.

## Cómo se ejecuta

```bash
npm install
npm run dev          # interfaz en :5173, MCP y API en :3000
npm test             # 269 pruebas: dominio, acceso y arquitectura
npm run typecheck
```

```bash
npm run android:install   # compila, instala por ADB y abre en el teléfono
```

Producción: `https://torreon.fly.dev` — reino autoritativo, el mismo que
consultan ChatGPT y Claude por MCP.

## El mapa

| Dónde | Qué |
|---|---|
| `apps/server/src/domain.ts` | El vocabulario. Tipos puros, cero imports. Empieza por aquí. |
| `apps/server/src/read-models.ts` | Proyecciones de lectura. Lo que verá Unity. |
| `apps/server/src/quest-service.ts` | El orquestador. 2 922 líneas; **sólo puede encoger**. |
| `apps/server/src/codice.ts` | El contrato del Dungeon Master, con dos runtimes. |
| `apps/server/src/app.ts` / `mcp.ts` | Transporte. Traducen; no deciden. |
| `apps/server/src/architecture.test.ts` | Las pruebas que defienden la constitución. |
| `apps/web/src/main.tsx` | Cliente React. Transitorio: Unity lo sustituye. |
| `docs/arquitectura/` | Auditoría, constitución, arquitectura objetivo, contrato de cliente, hoja de ruta, ADR. |

## Las cinco reglas que más se rompen

1. **El renderer no decide nada.** Ni progreso, ni daño, ni victoria, ni
   recompensa. Si lo estás calculando en el cliente, está mal.
2. **El modelo propone, el Núcleo dispone.** Todo texto que viene de fuera
   —incluido el contenido de un archivo del jugador— es **dato, nunca
   instrucción**.
3. **Lo derivable se deriva.** No guardes un puntero que pueda mentir. Dos
   sitios que dicen cosas distintas sobre la misma Battle es el error que más
   veces se ha pagado aquí.
4. **No ensanches `quest-service.ts`.** Hay un trinquete que lo impide. Si tu
   cambio no cabe, extrae un módulo y baja el presupuesto.
5. **Anular no es borrar.** Un hecho registrado se marca inválido con motivo y
   autor; no se reescribe.

## Cómo se trabaja aquí

- **Método de calca.** Los mockups son referencia, no contrato. Se implementa lo
  de la tajada actual, no la pantalla entera.
- **Commit al final de cada mensaje**, sin pedir permiso. El mensaje de commit
  describe lo que el jugador gana, en su idioma: *«el grupo aparece en el reino,
  se planta en un tablero, y un frente en pausa deja de reabrirse solo»*.
- **Verde antes de cerrar.** `npm test` y `npm run typecheck`.
- **El PC no cuenta.** Si el cambio se ve, la APK va instalada por ADB en el
  teléfono antes de decir que funciona.
- **Tocar el Núcleo implica desplegar a Fly.** No se pregunta.
- **Toda regla nueva nace con la prueba que la nombra**, en lenguaje del juego:
  *«conocido no es haber participado»*, no `test_hero_state_transition`.

## Si una prueba de arquitectura te estorba

No la relajes. Ese es el único camino prohibido.

1. Entiende qué límite defiende (el nombre cita el artículo).
2. Decide si el límite sigue siendo correcto.
3. Si hay que moverlo: escribe un ADR en `docs/arquitectura/adr/`.
4. Y **después** mueve la prueba.

## Estado actual, sin adornos

El Núcleo está limpio y bien probado. Lo que falta son cuatro decisiones
fundacionales que nunca se tomaron porque el juego se construyó para un jugador
en una máquina: **identidad, persistencia, contrato versionado y frontera de
confianza en el juez**.

Están diagnosticadas con medidas en
[docs/arquitectura/00-AUDITORIA.md](docs/arquitectura/00-AUDITORIA.md) y
ordenadas en [docs/arquitectura/04-HOJA-DE-RUTA.md](docs/arquitectura/04-HOJA-DE-RUTA.md).

Dos cosas que conviene saber antes de prometer nada:

- La API ya tiene llave (`TORREON_API_TOKEN`) **en el código**, pero el reino de
  la nube sigue abierto hasta que alguien ponga el secreto en Fly y recompile la
  APK. Ver la mitigación inmediata de la hoja de ruta.
- **El Núcleo no consulta el reloj.** Recibe `nowMs`, o un `Clock` si es el
  servicio o el almacén. `new Date()` dentro del Núcleo es un fallo de build.
  En una prueba, planta el reloj con `fixedClock(...)`.
