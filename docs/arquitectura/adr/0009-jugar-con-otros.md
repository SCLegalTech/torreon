# ADR-0009 · Jugar con otros: la ficha, el Duelo y la Hermandad

- **Estado:** aceptado en su primera etapa (la ficha); el resto, propuesto
- **Fecha:** 2026-09-07
- **Artículos:** 1, 2, 10, 11

## Contexto

Torreón se construyó para un jugador. Ahora hay gente pidiendo entrar, y hay dos
cosas distintas que la palabra «multijugador» tapa:

- **competir** con un amigo, cada uno con SU batalla;
- **cooperar** en la misma batalla, con los mismos objetivos.

No son la misma función y no cuestan lo mismo. Mezclarlas es la manera más
rápida de no entregar ninguna.

Y hay un problema que el propio jugador identificó antes que nadie: **quedar a
la misma hora no funciona.** Dos personas que se comprometen a empezar a las
19:00 fallan el 90 % de las veces, y el juego se rompe por una razón que no
tiene nada que ver con el juego.

## Decisión

### 1. La ficha, primero *(implementado)*

Antes de que haya dos jugadores hay que saber quién es cada uno.

- Se elige **arquetipo**: `marques` o `cordera`. Ese arquetipo lleva el nombre
  del jugador dentro del grupo.
- El otro arquetipo sigue en el grupo con su nombre canónico. El grupo son tres
  y crear una ficha no rompe la formación.
- **Roku es la mascota.** No se encarna: se le pone nombre.
- **Los ids internos no cambian nunca.** `roko` sigue siendo `roko` en toda la
  historia persistida; el nombre se resuelve al leer. Renombrar una pantalla no
  puede reescribir un evento de hace un mes (artículo 20).

### 2. El Duelo — competir sin quedar a la misma hora

Un **Duelo** es un reto asíncrono entre dos jugadores. Cada uno con **su propia
Battle**, sobre **su propia vida real**.

```
retar → aceptar → cada quien pelea su frente cuando puede → se resuelve
```

- El retador declara una **ventana** (por ejemplo, 48 horas), no una hora.
- Cada jugador compromete UNA Battle dentro de esa ventana. Cada quien la
  empieza cuando puede.
- El Duelo se resuelve cuando ambas Battles cierran, o cuando vence la ventana.

**Cómo se decide quién gana, y por qué así.** Comparar tiempos crudos premiaría
al que eligió la tarea fácil: lavarse los dientes contra redactar una tutela no
son lo mismo, y el jugador lo dijo con esas palabras. El Duelo compara
**resultado validado por minuto pactado, ponderado por dificultad**:

```
puntuación = (impacto validado / 100) × dificultad × (minutos pactados / minutos usados)
```

- **impacto validado** es lo de siempre: sólo evidencia comprobada cuenta
  (artículo 1). Una Battle a medias puntúa a medias.
- **dificultad** la propone el Códice al trazar el contrato y **el Núcleo la
  acota** (artículo 2). No la elige el jugador, porque entonces todos elegirían
  «difícil».
- **minutos pactados / minutos usados** premia terminar antes de lo pactado y
  castiga estirarse; nunca puede pasar de un tope, para que pactar veinte
  minutos y tardar uno no gane el duelo por sí solo.

Un Duelo **no crea Battles ni cambia contratos**: se cuelga de las que cada
jugador ya tiene. Y no puede tocar el impacto: eso lo sigue decidiendo la
evidencia, sólo la evidencia, y el Núcleo (artículo 1).

### 3. La Hermandad — cooperar en la misma batalla

Dos o más jugadores sobre **la misma Quest**: si un compañero cierra un paso,
la campaña avanza para todos.

Esto es lo caro, y conviene decir por qué: **hoy una Quest pertenece a un
jugador** (artículo 10, ADR-0002). Una Quest compartida no tiene un dueño, tiene
varios, y eso toca la raíz del modelo:

- quién puede aceptar el contrato y quién puede repactarlo;
- de quién es la evidencia que cierra un paso, y a quién se le concede el XP;
- qué pasa cuando uno abandona y el otro sigue;
- qué ve cada uno del expediente del otro (artículo 12).

Ninguna de esas preguntas se contesta con código: son decisiones de producto.
Por eso la Hermandad va **después** del Duelo, y con su propio ADR.

### 4. La beta cerrada

Registro **por invitación**, no abierto. La identidad ya existe (ADR-0007) y
viene apagada; encenderla es lo que abre la puerta a los primeros jugadores.

## Consecuencias

**A favor:** el Duelo se puede construir sin tocar la raíz del modelo —son dos
Battles normales y un marcador encima— y da la función social sin esperar a
resolver la propiedad compartida. La ficha, además, hace falta igual para los
dos modos.

**En contra:** el Duelo introduce el primer dato que pertenece a DOS jugadores a
la vez, y eso obliga a decidir qué ve cada uno del reino del otro. La respuesta
por defecto es la mínima: título de la Battle, dificultad y puntuación. Nada del
expediente, nada de la evidencia, nada del dinero.

**Riesgo que hay que vigilar:** un juego sobre la vida real con marcador puede
empujar a inflar la dificultad o a declarar sin probar. Las dos cosas ya están
defendidas —la dificultad la propone el Códice y la acota el Núcleo; sin
evidencia comprobada no hay impacto— pero conviene mirar los primeros duelos
reales antes de abrirlo a más gente.

## Alternativas descartadas

- **Duelo en tiempo real, empezando a la misma hora.** Es lo primero que se
  imagina y lo primero que falla: obliga a coordinar agendas para poder jugar.
  La ventana asíncrona da lo mismo sin ese coste.
- **Comparar tiempos crudos.** Premia al que elige la tarea fácil, que es
  justamente lo contrario de lo que este juego quiere premiar.
- **Que el jugador declare la dificultad.** Todos declararían «difícil». El
  Códice propone y el Núcleo acota, como con todo lo demás.
- **Empezar por la Hermandad.** Es lo que más ilusión hace y lo que más caro
  sale: toca la propiedad de la Quest, que es la raíz del modelo de datos.
