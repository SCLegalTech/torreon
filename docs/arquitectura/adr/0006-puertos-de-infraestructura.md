# ADR-0006 · Toda infraestructura entra por un puerto, empezando por el reloj

- **Estado:** propuesto (etapa 1)
- **Fecha:** 2026-09-06
- **Artículos:** 6, 8

## Contexto

Hay 33 llamadas directas a `new Date()` / `Date.now()` en módulos de producción.
La consecuencia no es teórica:

```
FAIL  src/quick-battles-finance.test.ts > F-001
      expected 'upcoming' to be 'pending'
```

Esa prueba crea una obligación que vence el día 5 del mes. **Pasa los días 1–5 y
falla los otros 25.** Sin CI, llevaba días roja sin que nadie lo notara.

Hay un segundo síntoma, más corrosivo: **la suite es inestable bajo carga**.
`battle-timer.test.ts` falla intermitentemente en la ejecución completa y pasa
siempre aislado, porque sus pruebas esperan tiempo real (300–400 ms cada una) y
bajo contención las aserciones resbalan. Con CI recién añadido, un guardián que
falla al azar se convierte en un botón de «reintentar».

Torreón es un dominio de plazos: ventanas críticas, presión temporal, períodos
de facturación, vencimientos recurrentes. Es el peor dominio posible para tener
el reloj cableado.

`artifacts.ts` tiene el mismo problema con el disco: hace `copyFile` /
`writeFile` sobre una ruta local. Es la única fuga de infraestructura dentro del
Núcleo, y por eso está excluido de las pruebas de aptitud de capa.

## Decisión

Puertos explícitos, recibidos como dependencia por quien los necesite:

| Puerto | Sustituye a | Permite |
|---|---|---|
| `Clock` | `new Date()`, `Date.now()` | probar cualquier fecha; viajar en el tiempo en pruebas |
| `IdGen` | `randomUUID()` | identificadores estables en pruebas |
| `ArtifactStore` | `node:fs` en `artifacts.ts` | disco hoy, S3/R2 con varias máquinas |
| `CodiceRuntime` | ya existe como `CodicePlanner` ✔ | modelo intercambiable |
| `PushChannel` | entrega de avisos | FCM sin tocar el registro |

`new Date()` queda prohibido dentro del Núcleo, y una prueba de aptitud lo
vigilará en cuanto se complete la sustitución.

## Consecuencias

**A favor:** pruebas deterministas y **estables bajo carga**; la suite deja de
esperar tiempo real y baja de 35 s; se pueden probar vencimientos, ventanas
críticas y rotación de períodos sin esperar al calendario; el almacenamiento de
artefactos deja de anclar el reino a una máquina.

**En contra:** las firmas del Núcleo crecen. Se mitiga agrupando los puertos en
un único `CoreContext` que se pasa una vez, en vez de cinco parámetros sueltos.

## Alternativas descartadas

- **Falsear el reloj global en las pruebas** (`vi.useFakeTimers`). Tapa el
  síntoma en la prueba y deja el dominio igual de imposible de razonar.
- **Pasar `now` como parámetro suelto en cada función.** Es lo que ya se hace a
  medias (`nowMs` en `finance.ts`) y produce dos convenciones conviviendo.
