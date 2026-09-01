# Torreón — contrato del MVP (Slice 1)

Este documento traduce el **Product North Star** a un vertical comprobable. La constitución orienta las decisiones; el alcance operativo de este MVP es el que se define aquí.

## Promesa que debe funcionar

Una persona expresa **cualquier propósito real** a Códice desde Codex. Códice lo mejora con ella, lo convierte en una quest verificable, lo divide en pasos y lo sincroniza con la APK. Cuando la persona aporta evidencia, Códice la evalúa y el progreso validado se convierte en ataques visibles. La victoria solo ocurre cuando el resultado pactado alcanza 100 puntos de evidencia aceptada.

## Bucle vertical

```text
Intención real → Códice → contrato negociado → quest aceptada → expedición
      → evidencia → veredicto → Life Event → Game Event → ataque → nuevo estado
```

## Criterios de aceptación

1. Códice puede formular una quest de 1 a 12 pasos para dos intenciones de dominios distintos, sin depender de plantillas financieras.
2. El usuario ve en la APK horizontal el mismo borrador creado desde Codex/MCP.
3. La quest no comienza sin aceptación explícita.
4. Cada evidencia guarda fuente, resumen, veredicto y razonamiento.
5. Un veredicto `rejected` no causa daño; `partial` causa solo el impacto concedido; `accepted` puede completar el impacto restante del paso.
6. Cada impacto genera primero un `LifeEvent` y después un `GameEvent` enlazado a él.
7. La barra, los sprites y el KO reflejan el estado del dominio; la animación nunca es la fuente de verdad.
8. La APK obtiene el estado del servidor local mediante ADB reverse y conserva un modo demostrativo sin conexión.

## Dentro de este Slice

- Pantalla de inicio, bastión, Códice, campaña, quest, expedición y batalla.
- Creación, reformulación, aceptación, inicio y abandono de una quest.
- Evidencia rechazada, parcial o aceptada.
- Ataque, progreso y victoria derivados de evidencia.
- MCP local y APK Android horizontal.

## Fuera de este Slice

- Motor financiero y conexión bancaria (Slice 2).
- Vigilancia de aplicaciones, bloqueo del teléfono o validación automática de foco.
- Reino procedural, economía completa, agentes autónomos, cooperativo y despliegue público.
- Ejecución de acciones externas sin una autorización específica.

## Prueba de “cualquier tarea”

El contrato se considera universal cuando recorre el bucle con, al menos, dos ejemplos no relacionados —por ejemplo «enviar cinco candidaturas» y «ordenar el estudio»— usando el mismo modelo de dominio y las mismas herramientas MCP.
