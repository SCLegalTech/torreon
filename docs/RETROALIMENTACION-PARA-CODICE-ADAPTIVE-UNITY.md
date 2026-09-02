# Retroalimentación para Códice — quests adaptativas y combate bilateral

## Decisión de arquitectura

La realidad es autoridad y la quest es un contrato versionado. El renderer no decide progreso, daño, bloqueo ni finalización. Esas reglas viven en el Core compartido por HTTP, MCP, React y el futuro cliente Unity.

## Qué quedó implementado

- Una quest activa puede recibir un `QuestAmendment` propuesto por Códice.
- Ningún cambio material se aplica sin aceptación explícita del jugador.
- El amendment puede agregar, modificar o sustituir órdenes, marcar bloqueos externos y desbloquearlos.
- Las órdenes completadas y sus `Evidence`, `LifeEvent` y `GameEvent` nunca se reescriben.
- `waiting_external` representa que toda acción restante depende de terceros y que el jugador no tiene una acción honesta disponible.
- Un `Artifact` puede vincularse a varios pasos sin duplicar bytes; cada paso recibe su propio veredicto.
- El combate es bilateral: el Marqués y la Horda tienen salud independiente en `BattleState`.
- La Horda sólo ataca a partir de una presión real explícita (`unexpected_requirement`). No ataca por cronómetro, silencio, inactividad ni espera externa.

## Conducta esperada de Códice

1. Consultar el reino y el expediente antes de interpretar un cambio.
2. Si la evidencia contradice el plan, explicar la nueva realidad y proponer un amendment.
3. Esperar una aceptación inequívoca antes de aplicar el amendment.
4. Marcar una orden como bloqueada sólo cuando existe una dependencia concreta; declarar si queda o no una acción del jugador.
5. Reutilizar artefactos cuando una misma prueba fundamenta varias órdenes, pero razonar cada veredicto por separado.
6. Registrar un contraataque únicamente cuando aparece una exigencia imprevista real y describible.

## Contrato para Unity

Unity no necesita portar reglas de negocio. Debe leer `RealmSnapshot`, representar `BattleState.player` y `BattleState.enemy`, y reaccionar a `GameEvent` (`quest_attack` o `horde_attack`). El cliente puede cambiar animaciones, sprites y cámara sin alterar el historial autoritativo.

## Alcance deliberadamente diferido

- IA de animación, pathfinding y VFX complejos.
- Daño periódico o castigo por inactividad.
- Integraciones automáticas con fuentes externas de presión.
- Migración del renderer a Unity.

Esta frontera evita invertir en animaciones React desechables y deja listo el contrato que Unity consumirá.
