# ADR-0005 · El vocabulario del contrato se genera; no se copia a mano

- **Estado:** aceptado — el vocabulario ya se genera y CI lo verifica; los DTO de cada vista, con el proyecto Unity
- **Fecha:** 2026-09-06
- **Artículos:** 13, 14

## Contexto

`apps/web/src/types.ts` (648 líneas) es una transcripción manual de
`apps/server/src/domain.ts`. Ya había derivado, y en la peor dirección: el
cliente **ensanchó un tipo del Núcleo para que le compilara**.

```ts
// Núcleo:  "active" | "suspended_external" | "awaiting_replan" | "awaiting_recovery" | "won"
// Cliente: ... | "pending"    ← un estado que el servidor no puede producir
```

Unity sería la tercera copia a mano, en un lenguaje distinto, sin ningún
compilador que la ate a las otras dos.

## Decisión

Fuente única → artefacto generado:

```
apps/server/src/domain.ts  ──►  contract/*.schema.json  ──┬──►  TypeScript (web)
                                                          └──►  C#  (Unity)
```

La generación corre en CI y **falla el build si el artefacto no coincide con la
fuente**. Mientras no exista, la prueba de no-deriva de `architecture.test.ts`
cubre el vocabulario compartido con `apps/web`.

Convenciones para C#, decididas ahora:

- Cada unión de literales genera un `enum` con `Unknown = 0`, para que un valor
  nuevo del servidor **no rompa una APK vieja** (art. 13).
- Campos opcionales → nullable. Sin valores centinela.
- Fechas ISO-8601 UTC; el reloj autoritativo es `serverTime`.

## Consecuencias

**A favor:** la deriva pasa de «se detecta leyendo» a «no compila»; añadir un
cliente cuesta un generador, no una traducción; el contrato queda documentado
por construcción.

**En contra:** un paso de build más y un artefacto versionado en el repositorio.
Generar desde tipos TypeScript no es trivial para tipos avanzados, así que el
contrato público tendrá que mantenerse deliberadamente simple — lo cual es, en
sí mismo, una virtud.

## Alternativas descartadas

- **Seguir copiando a mano con la prueba de deriva.** Funciona para uniones de
  literales; no detecta un campo que cambia de tipo ni uno que falta.
- **OpenAPI como fuente.** Describe rutas mejor que dominios, y obligaría a
  mantener el vocabulario en dos sitios de todos modos.
- **gRPC / Protobuf.** Resuelve esto y trae una cadena de herramientas entera
  para un problema que un generador de esquemas cubre.
