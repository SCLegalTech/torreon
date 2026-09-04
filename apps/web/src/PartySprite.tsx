import type { CSSProperties } from "react";

/**
 * SPRITES IDLE DEL GRUPO.
 *
 * THE PARTY MUST LOOK LIKE ONE PARTY, NOT THREE UNRELATED IMAGES.
 *
 * Los tres GIF tienen lienzos distintos y, sobre todo, cantidades distintas de
 * transparencia alrededor del personaje. Escalar por la altura del lienzo haría
 * a Roku enorme y a Cordera enana. Aquí se escala por la ALTURA VISIBLE medida
 * sobre los frames reales, y se alinea por los PIES, no por el centro.
 *
 * IDLE SOLAMENTE. Ningún pulso, rebote ni traslación finge un ataque: el GIF se
 * reproduce con su propio timing y nada más.
 */

export type PartySpriteId = "marques" | "cordera" | "roku";

interface SpriteMetrics {
  src: string;
  /** Lienzo original del GIF. */
  canvas: { w: number; h: number };
  /** Caja visible del personaje, unión del alpha de todos los frames. */
  box: { x: number; y: number; w: number; h: number };
  /** Altura visible objetivo, relativa al Marqués. */
  scale: number;
  alt: string;
}

/**
 * Medidas tomadas de los propios archivos:
 *
 *   marques-idle.gif  500×400   visible 277×371  en (27,15)   4 frames
 *   cordera-idle.gif  500×350   visible 292×332  en (23, 6)   4 frames
 *   roku-idle.gif     500×200   visible 139×132  en (33,60)  12 frames
 *
 * ROKU IS SMALL: ~30% OF THE MARQUÉS. Cordera conserva estatura humana, algo
 * por debajo del Marqués. Estas proporciones son la identidad del grupo y no
 * cambian con el breakpoint: lo único que cambia es la escala del grupo entero.
 */
export const PARTY_SPRITES: Record<PartySpriteId, SpriteMetrics> = {
  marques: {
    src: "/assets/sprites/party/marques-idle.gif",
    canvas: { w: 500, h: 400 },
    box: { x: 27, y: 15, w: 277, h: 371 },
    scale: 1,
    alt: "Marqués, arquero de la Marca",
  },
  cordera: {
    src: "/assets/sprites/party/cordera-idle.gif",
    canvas: { w: 500, h: 350 },
    box: { x: 23, y: 6, w: 292, h: 332 },
    scale: 0.9,
    alt: "Cordera, sanadora del grupo",
  },
  roku: {
    src: "/assets/sprites/party/roku-idle.gif",
    canvas: { w: 500, h: 200 },
    box: { x: 33, y: 60, w: 139, h: 132 },
    scale: 0.3,
    alt: "Roku, guardia del grupo",
  },
};

/**
 * Recorta el lienzo SIN tocar el archivo.
 *
 * El GIF se sigue reproduciendo entero; lo que hace la ventana es enseñar sólo
 * la caja del personaje. Así el asset queda intacto —orden y duración de frames
 * incluidos— y aun así los tres se pueden colocar juntos sin que el aire
 * transparente de cada lienzo abra huecos distintos entre ellos.
 */
export function PartySprite({
  id,
  /** Altura visible del Marqués, en cualquier unidad CSS. El resto deriva. */
  heroHeight,
  facing = "right",
  ko = false,
  decorative = false,
  className = "",
  style,
}: {
  id: PartySpriteId;
  heroHeight: string;
  facing?: "left" | "right";
  ko?: boolean;
  decorative?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const metrics = PARTY_SPRITES[id];
  // Cuánto hay que escalar el lienzo para que la caja visible mida lo pedido.
  const factor = `calc(${heroHeight} * ${metrics.scale} / ${metrics.box.h})`;
  // Al espejar, el personaje pasa a ocupar el hueco simétrico del lienzo: la
  // ventana tiene que moverse al otro lado o enseñaría transparencia vacía.
  const offsetX = facing === "left" ? -(metrics.canvas.w - metrics.box.x - metrics.box.w) : -metrics.box.x;
  return (
    <span
      className={`party-sprite party-sprite-${id} ${ko ? "is-ko" : ""} ${className}`}
      style={{
        width: `calc(${factor} * ${metrics.box.w})`,
        height: `calc(${factor} * ${metrics.box.h})`,
        ...style,
      }}
      aria-hidden={decorative || undefined}
    >
      <img
        src={metrics.src}
        alt={decorative ? "" : metrics.alt}
        draggable={false}
        style={{
          width: `calc(${factor} * ${metrics.canvas.w})`,
          height: `calc(${factor} * ${metrics.canvas.h})`,
          left: `calc(${factor} * ${offsetX})`,
          top: `calc(${factor} * ${-metrics.box.y})`,
          // No se espeja el asset por capricho: sólo cuando la composición pide
          // que un personaje mire al otro o al enemigo.
          transform: facing === "left" ? "scaleX(-1)" : undefined,
        }}
      />
    </span>
  );
}

// ---------------------------------------------------------------------------
// EL TABLERO
//
// La Battle se lee como un tablero de ajedrez de 4×4 visto en isométrico. El
// Marqués y Cordera ocupan las casillas del rey y la reina en la fila propia;
// Roku ocupa la casilla de peón que hay DELANTE del Marqués, porque su oficio
// es interponerse. El enemigo queda arriba a la derecha, hacia la Horda.
//
// Proyección: un vértice de rejilla (i, j) —i = columna hacia el enemigo, j =
// fila a lo ancho— cae en
//
//     x = (i + j) * a
//     y = (j - i) * b + 4b
//
// con a = ancho/8 y b = alto/8. Con la caja en proporción 2:1 sale un
// isométrico verdadero: cada casilla es un rombo del doble de ancho que de alto.
// ---------------------------------------------------------------------------

export const BOARD_SIZE = 4;

export interface BoardCell {
  /** 0 = nuestra fila de fondo; 3 = la del enemigo. */
  file: number;
  /** 0..3 a lo ancho del tablero. */
  rank: number;
}

/** Centro de una casilla, en porcentaje de la caja del tablero. */
export function cellCenter({ file, rank }: BoardCell): { left: number; top: number } {
  return {
    left: ((file + rank + 1) * 100) / (BOARD_SIZE * 2),
    top: ((rank - file + BOARD_SIZE) * 100) / (BOARD_SIZE * 2),
  };
}

/** Dónde se planta cada uno. Rey, reina y el peón que los cubre. */
export const PARTY_CELLS: Record<PartySpriteId, BoardCell> = {
  marques: { file: 0, rank: 1 },
  cordera: { file: 0, rank: 2 },
  roku: { file: 1, rank: 1 },
};

/** La casilla que ocupa el cuarto slot cuando un agente pelea de verdad. */
export const AGENT_CELL: BoardCell = { file: 1, rank: 2 };

function gridPoint(i: number, j: number): { x: number; y: number } {
  return { x: ((i + j) * 100) / (BOARD_SIZE * 2), y: ((j - i + BOARD_SIZE) * 100) / (BOARD_SIZE * 2) };
}

/**
 * EL PLANO, MUY SUTIL.
 *
 * No es decoración suelta: es la rejilla EXACTA con la que se calculan las
 * casillas, así que lo que se ve es literalmente el suelo donde están parados.
 * Se dibuja tenue para no competir con el arte del escenario, pero se ve.
 */
export function IsoBoard({ className = "" }: { className?: string }) {
  const lines: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  for (let i = 0; i <= BOARD_SIZE; i += 1) {
    const fileA = gridPoint(i, 0);
    const fileB = gridPoint(i, BOARD_SIZE);
    lines.push({ x1: fileA.x, y1: fileA.y, x2: fileB.x, y2: fileB.y });
    const rankA = gridPoint(0, i);
    const rankB = gridPoint(BOARD_SIZE, i);
    lines.push({ x1: rankA.x, y1: rankA.y, x2: rankB.x, y2: rankB.y });
  }

  // Casillas oscuras del damero, como en un tablero real.
  const shaded: string[] = [];
  for (let file = 0; file < BOARD_SIZE; file += 1) {
    for (let rank = 0; rank < BOARD_SIZE; rank += 1) {
      if ((file + rank) % 2 === 0) continue;
      shaded.push(
        [gridPoint(file, rank), gridPoint(file + 1, rank), gridPoint(file + 1, rank + 1), gridPoint(file, rank + 1)]
          .map((point) => `${point.x},${point.y}`)
          .join(" "),
      );
    }
  }

  const outline = [gridPoint(0, 0), gridPoint(BOARD_SIZE, 0), gridPoint(BOARD_SIZE, BOARD_SIZE), gridPoint(0, BOARD_SIZE)]
    .map((point) => `${point.x},${point.y}`)
    .join(" ");


  return (
    <svg className={`iso-board ${className}`} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      {/* El suelo entero, apenas insinuado: sin él las líneas se pierden
          contra el arte del escenario y el plano deja de leerse. */}
      <polygon className="iso-floor" points={outline} />
      {shaded.map((points) => (
        <polygon key={points} className="iso-cell" points={points} />
      ))}
      {lines.map((line) => (
        <line
          key={`${line.x1}:${line.y1}:${line.x2}:${line.y2}`}
          className="iso-line"
          x1={line.x1}
          y1={line.y1}
          x2={line.x2}
          y2={line.y2}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      <polygon className="iso-outline" points={outline} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
