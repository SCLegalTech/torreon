# Contrato gráfico de Torreón

Este documento separa tres clases de arte: interfaz, escenarios y sprites. Las capturas conceptuales entregadas sirven como dirección visual; no se montan como pantallas interactivas.

## Entrega recomendada

La mejor entrega es el archivo fuente de Aseprite (`.aseprite`) con capas y etiquetas de animación. También funciona una hoja PNG con transparencia y, si usa otro orden, un JSON que indique cada animación.

Empaqueta todo en un ZIP con esta estructura:

```text
torreon-art-v1/
  characters/
    marquis.aseprite
    wolf.aseprite
    codex.aseprite
    horde-grunt.aseprite
  environments/
    bastion-sky.png
    bastion-midground.png
    bastion-ground.png
    battle-cavern-back.png
    battle-cavern-front.png
  ui/
    crest.png
    coin.png
    quest.png
    settings.png
  references/
    palette.png
    scale-lineup.png
```

## Hoja mínima que el MVP ya entiende

Si entregas PNG directamente, cada personaje debe usar:

- Archivo PNG RGBA transparente.
- Tamaño total: `1024 × 512 px`.
- Cuadrícula: 8 columnas × 4 filas.
- Celda: `128 × 128 px`.
- Dirección: el personaje mira hacia la derecha.
- Pies anclados cerca de `(64, 116)` en todas las celdas.
- Los cuadros sin usar quedan completamente transparentes.
- Sin sombra pintada; la sombra se representa por separado en el juego.
- Sin suavizado, reescalado borroso ni fondo de color.

| Fila | Animación | Cuadros usados | Ritmo orientativo |
|---|---|---:|---:|
| 0 | `idle` | 4 | 5 fps |
| 1 | `attack` | 6 | 10 fps |
| 2 | `hurt` | 4 | 9 fps |
| 3 | `victory` | 6 | 7 fps |

Nombres que se pueden copiar directamente a la aplicación:

```text
apps/web/public/assets/sprites/characters/marquis.png
apps/web/public/assets/sprites/characters/wolf.png
apps/web/public/assets/sprites/characters/codex.png
apps/web/public/assets/sprites/characters/horde.png
```

El motor detecta estos archivos automáticamente y reemplaza los marcadores provisionales.

## Diseño de cada personaje

### Marqués

- Silueta legible: capa oscura, espada corta y broche dorado.
- `idle`: respiración y movimiento leve de capa.
- `attack`: anticipación, avance, impacto y recuperación.
- `hurt`: retroceso sin caer.
- `victory`: espada o estandarte elevado.

### Lobo

- Debe mantenerse más bajo que la cadera del Marqués.
- `idle`: respiración, orejas y cola.
- `attack`: salto o embestida.
- `hurt`: repliegue breve.
- `victory`: aullido.

### Códice de la Marca

- Libro oscuro flotante, herrajes dorados, llama azul y páginas como alas.
- `idle`: flotación y llama viva.
- `attack`: equivale a conjuro o asistencia de IA.
- `hurt`: cierre brusco y pérdida momentánea de luz.
- `victory`: páginas abiertas y halo.

### Horda

- No copiar literalmente criaturas protegidas de otra franquicia. Debe conservar la sensación de amenaza subterránea con diseño propio.
- `idle`: postura agresiva.
- `attack`: embestida.
- `hurt`: golpe visible.
- `victory`: para este actor se interpreta como recuperación; la futura animación `death` se agregará al atlas expandido.

## Escenarios

- Orientación principal: horizontal.
- Lienzo maestro: `1608 × 720 px`, coincidente con el dispositivo de prueba en paisaje.
- Cada capa de escenario se entrega a ese mismo tamaño para superponerla sin adivinar posiciones.
- Fondo y capas ambientales no deben contener botones, paneles, indicadores, títulos ni texto.
- Capas recomendadas: cielo/luz, fondo lejano, arquitectura, suelo transitable y primer plano transparente.
- Exportar PNG; conservar el archivo fuente por capas.

La interfaz —botones, barras, contratos, textos y acciones— siempre se construye con componentes del programa para que sea inequívocamente pulsable y se adapte a otros teléfonos.

## Pixel art

- Trabajar con una paleta limitada y compartida.
- Usar bordes consistentes de uno o dos píxeles en la resolución de dibujo.
- Reescalar únicamente por múltiplos enteros con `nearest-neighbor`.
- Entregar una lámina de escala con Marqués, Doncella, Lobo, Códice, Dragón y enemigo, todos sobre la misma línea de suelo.

## Antes de animar todo

Conviene entregar primero un paquete piloto con `marquis.png`, `horde.png` y una capa de escenario. Se integra y prueba en el vivo V2436; después se producen los demás personajes con la escala ya confirmada.
