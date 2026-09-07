# ADR-0002 · El jugador es la raíz de agregado, no el reino

- **Estado:** propuesto (etapa 2 de la hoja de ruta)
- **Fecha:** 2026-09-06
- **Artículos:** 10, 11, 12

## Contexto

`RealmState` tiene `realmId` pero no tiene dueño. El proceso entero es un reino:
`JsonRealmStore` recibe una ruta de archivo y `QuestService` lee ese archivo sin
filtro de propietario.

No falta autenticación: **falta el sujeto**. No hay ningún sitio donde poner al
segundo jugador.

## Decisión

`playerId` pasa a ser la raíz de todo agregado:

```
Player ──1:N── Realm ──1:N── Saga ──1:N── Campaign ──1:N── Act ──1:N── Quest
```

Toda lectura y toda escritura llevan sujeto. No existe «el reino»: existe «el
reino de este jugador».

Se modela `Player 1:N Realm` aunque hoy sea siempre 1:1. Cuesta lo mismo ahora y
evita una migración el día que existan temporadas, personajes o reinos
compartidos.

Se hace **antes** de cambiar de motor de persistencia: un esquema que nace sin
`player_id` se migra dos veces.

## Consecuencias

**A favor:** desbloquea todo lo multiusuario; hace posible el borrado de cuenta
que Play Store exige; permite demostrar el aislamiento entre jugadores con una
prueba.

**En contra:** toca la firma de prácticamente todos los métodos del servicio y
la de todas las pruebas. Es mecánico, pero es ancho.

## Alternativas descartadas

- **Un proceso o un archivo por jugador.** Aparentemente gratis, pero no
  sobrevive a ninguna consulta entre jugadores y multiplica el despliegue por el
  número de usuarios.
- **Añadir `playerId` sólo en la capa HTTP.** El Núcleo seguiría sin saber de
  quién es cada cosa, que es justamente el agujero.
