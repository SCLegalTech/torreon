# ADR-0001 · El Núcleo es la única autoridad; los renderers son intercambiables

- **Estado:** aceptado (ratifica una decisión ya vigente en el código)
- **Fecha:** 2026-09-06
- **Artículos:** 1, 2, 5, 15

## Contexto

La decisión ya estaba tomada y aplicada —el dominio vive en el servidor, React
es un cliente— pero nunca se escribió. Estaba dispersa en comentarios de código
y en `docs/RETROALIMENTACION-PARA-CODICE-ADAPTIVE-UNITY.md`. Un ADR ausente es
un ADR que el siguiente agente puede contradecir sin darse cuenta.

Con Unity en el horizonte, la tentación concreta es real: portar «un poco» de
lógica al cliente para que las animaciones respondan sin esperar al servidor.

## Decisión

Las reglas del juego viven **sólo** en el Núcleo. Quests, evidencia, veredictos,
impacto, salud bilateral, reloj, recompensas y jerarquía son suyos.

Un renderer dibuja, anima y navega. Puede anticipar una animación; no puede
decidir su resultado. React hoy y Unity mañana son sustituibles sin tocar una
regla.

## Consecuencias

**A favor:** el cliente Unity no hereda deuda de dominio; MCP, HTTP y las
pruebas ejercitan exactamente las mismas reglas; cambiar de motor gráfico deja
de ser un riesgo de producto.

**En contra:** toda acción del jugador paga una ida y vuelta a la red. En una
Battle con animaciones rápidas eso se nota. Se compensa con animación optimista
y número autoritativo, nunca con lógica duplicada.

## Alternativas descartadas

- **Reglas compartidas cliente/servidor.** Con C# y TypeScript significa dos
  implementaciones que divergen. La divergencia sería exactamente sobre cuánto
  daño hizo algo: el peor sitio posible.
- **Autoridad en el cliente con validación diferida.** Convierte cada
  discrepancia en una corrección visible al jugador, y su reino en algo que
  discute consigo mismo.
