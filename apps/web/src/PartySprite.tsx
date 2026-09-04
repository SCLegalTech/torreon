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
  /** Hacia dónde mira el asset tal cual viene. Cordera mira a su izquierda. */
  nativeFacing: "left" | "right";
  alt: string;
}

/**
 * Medidas tomadas de los propios archivos:
 *
 *   marques-idle.gif  500×400   visible 277×371  en (27,15)   4 frames
 *   cordera-idle.gif  500×350   visible 292×332  en (23, 6)   4 frames
 *   roku-idle.gif     500×200   visible 139×132  en (33,60)  12 frames
 *
 * Las proporciones NO salen de una tabla: salen de medir los mockups que el
 * jugador compuso a mano. En `MAIN MOCKUP.png` el Marqués mide 306 px de alto,
 * Cordera 300 y Roku 136; en `battle stage mockup.png`, 356 / 370 / 140. De ahí
 * estos números, que sustituyen al 0.90 / 0.30 del documento anterior: Cordera
 * es prácticamente tan alta como el Marqués, y Roku es un perro grande, no un
 * cachorro.
 *
 * Son la identidad del grupo y no cambian con el breakpoint: lo único que
 * cambia es la escala del grupo entero.
 */
export const PARTY_SPRITES: Record<PartySpriteId, SpriteMetrics> = {
  marques: {
    src: "/assets/sprites/party/marques-idle.gif",
    canvas: { w: 500, h: 400 },
    box: { x: 27, y: 15, w: 277, h: 371 },
    scale: 1,
    nativeFacing: "right",
    alt: "Marqués, arquero de la Marca",
  },
  cordera: {
    src: "/assets/sprites/party/cordera-idle.gif",
    canvas: { w: 500, h: 350 },
    box: { x: 23, y: 6, w: 292, h: 332 },
    scale: 0.98,
    nativeFacing: "left",
    alt: "Cordera, sanadora del grupo",
  },
  roku: {
    src: "/assets/sprites/party/roku-idle.gif",
    canvas: { w: 500, h: 200 },
    box: { x: 33, y: 60, w: 139, h: 132 },
    scale: 0.42,
    nativeFacing: "right",
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
  facing,
  ko = false,
  decorative = false,
  className = "",
  style,
}: {
  id: PartySpriteId;
  heroHeight: string;
  /** Hacia dónde debe mirar. Por defecto, como viene el asset. */
  facing?: "left" | "right";
  ko?: boolean;
  decorative?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const metrics = PARTY_SPRITES[id];
  // Cuánto hay que escalar el lienzo para que la caja visible mida lo pedido.
  const factor = `calc(${heroHeight} * ${metrics.scale} / ${metrics.box.h})`;
  // Sólo se espeja cuando lo pedido NO coincide con cómo viene el asset.
  // Cordera ya mira a su izquierda: pedirle que mire a la izquierda no la voltea.
  const mirrored = Boolean(facing) && facing !== metrics.nativeFacing;
  // Al espejar, el personaje pasa a ocupar el hueco simétrico del lienzo: la
  // ventana tiene que moverse al otro lado o enseñaría transparencia vacía.
  const offsetX = mirrored ? -(metrics.canvas.w - metrics.box.x - metrics.box.w) : -metrics.box.x;
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
          transform: mirrored ? "scaleX(-1)" : undefined,
        }}
      />
    </span>
  );
}

// ---------------------------------------------------------------------------
// EL REINO
//
// Copiado del mockup, no inventado: el Marqués lo más a la izquierda, Cordera
// enfrente mirándolo y Roku EN MEDIO de los dos, a sus pies. Los tres se pisan
// a propósito —son un grupo, no tres figuras en fila— y el orden de dibujo es
// Cordera detrás, el Marqués encima de ella y Roku delante de ambos.
//
// Coordenadas en % del lienzo del arte (1672×941), tomadas de `MAIN MOCKUP.png`.
// ---------------------------------------------------------------------------

export interface RealmSpot {
  id: PartySpriteId;
  /** Centro horizontal, en % del ancho del arte. */
  centerX: number;
  /** Quién tapa a quién. Mayor = más cerca del jugador. */
  depth: number;
}

/** Los pies de los tres, sobre la misma línea de suelo del arte. */
export const REALM_GROUND = 78.1;
/** Altura visible del Marqués, en % del alto del arte. */
export const REALM_HERO_HEIGHT = 32.5;

export const REALM_SPOTS: RealmSpot[] = [
  { id: "cordera", centerX: 17.2, depth: 1 },
  { id: "marques", centerX: 7.6, depth: 2 },
  { id: "roku", centerX: 10.6, depth: 3 },
];

/** Altura visible del Marqués sobre el tablero, en % del alto del arte. */
export const BATTLE_HERO_HEIGHT = 37;

// ---------------------------------------------------------------------------
// LAS DOS CUADRÍCULAS DE LA BATTLE
//
// No es un tablero de 4×4: son DOS cuadrículas INDEPENDIENTES de 2×2, una para
// el grupo y otra para la Horda, enfrentadas a través del valle. Cada una es un
// cuadrilátero en perspectiva —el borde lejano más corto que el cercano, y el
// lateral inclinado— calcado del mockup, y las dos se inclinan en sentidos
// opuestos porque se miran de frente.
//
// Los cuatro vértices están en % del lienzo del arte, medidos sobre el trazo
// rojo de `battle stage mockup.png`. La posición de cada casilla se interpola
// bilinealmente entre ellos, así que las piezas caen exactamente sobre el suelo
// que el arte tiene pintado.
// ---------------------------------------------------------------------------

export interface Quad {
  tl: [number, number];
  tr: [number, number];
  br: [number, number];
  bl: [number, number];
}

/** Cuadrícula del grupo. `col` 0→1 avanza hacia la Horda; `row` 0→1 se acerca. */
export const ALLY_QUAD: Quad = {
  tl: [13.64, 56.64],
  tr: [41.63, 56.64],
  br: [34.39, 72.9],
  bl: [3.59, 72.16],
};

/** Cuadrícula de la Horda. Su `col` 0 es la más cercana a nosotros. */
export const HORDE_QUAD: Quad = {
  tl: [58.25, 55.79],
  tr: [83.13, 56.0],
  br: [93.36, 72.05],
  bl: [65.43, 71.73],
};

export const GRID_COLS = 2;
export const GRID_ROWS = 2;

/** Punto interior del cuadrilátero por interpolación bilineal. */
export function quadPoint(quad: Quad, u: number, v: number): { left: number; top: number } {
  const top = [quad.tl[0] + (quad.tr[0] - quad.tl[0]) * u, quad.tl[1] + (quad.tr[1] - quad.tl[1]) * u];
  const bottom = [quad.bl[0] + (quad.br[0] - quad.bl[0]) * u, quad.bl[1] + (quad.br[1] - quad.bl[1]) * u];
  return { left: top[0] + (bottom[0] - top[0]) * v, top: top[1] + (bottom[1] - top[1]) * v };
}

/** Centro de una casilla. Ahí se plantan los pies de quien la ocupa. */
export function cellCenter(quad: Quad, col: number, row: number): { left: number; top: number } {
  return quadPoint(quad, (col + 0.5) / GRID_COLS, (row + 0.5) / GRID_ROWS);
}

/**
 * QUIÉN OCUPA CADA CASILLA.
 *
 * La columna 1 es la que da a la Horda: ahí van Roku, que se interpone, y el
 * cuarto slot cuando un agente real entra en combate. Detrás quedan el Marqués
 * y Cordera, que es la que más lejos está del enemigo.
 */
export const ALLY_CELLS: Record<PartySpriteId | "agent", { col: number; row: number }> = {
  cordera: { col: 0, row: 0 },
  marques: { col: 0, row: 1 },
  agent: { col: 1, row: 0 },
  roku: { col: 1, row: 1 },
};

/**
 * EL PLANO, MUY SUTIL.
 *
 * No es decoración suelta: es la misma rejilla con la que se calculan las
 * casillas, así que lo que se ve es literalmente el suelo donde están parados.
 * Se dibuja tenue para no competir con el arte, pero se ve.
 */
export function BattleGrid({
  quad,
  className = "",
  /** Casillas a marcar como caídas. Clave `col,row`. */
  fallen = [],
}: {
  quad: Quad;
  className?: string;
  fallen?: string[];
}) {
  const point = (u: number, v: number) => quadPoint(quad, u, v);
  const cells: Array<{ key: string; points: string; down: boolean }> = [];
  for (let col = 0; col < GRID_COLS; col += 1) {
    for (let row = 0; row < GRID_ROWS; row += 1) {
      const corners = [
        point(col / GRID_COLS, row / GRID_ROWS),
        point((col + 1) / GRID_COLS, row / GRID_ROWS),
        point((col + 1) / GRID_COLS, (row + 1) / GRID_ROWS),
        point(col / GRID_COLS, (row + 1) / GRID_ROWS),
      ];
      cells.push({
        key: `${col},${row}`,
        points: corners.map((corner) => `${corner.left},${corner.top}`).join(" "),
        down: fallen.includes(`${col},${row}`),
      });
    }
  }

  const lines: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  for (let i = 0; i <= GRID_COLS; i += 1) {
    const a = point(i / GRID_COLS, 0);
    const b = point(i / GRID_COLS, 1);
    lines.push({ x1: a.left, y1: a.top, x2: b.left, y2: b.top });
  }
  for (let i = 0; i <= GRID_ROWS; i += 1) {
    const a = point(0, i / GRID_ROWS);
    const b = point(1, i / GRID_ROWS);
    lines.push({ x1: a.left, y1: a.top, x2: b.left, y2: b.top });
  }

  const outline = [quad.tl, quad.tr, quad.br, quad.bl].map((corner) => `${corner[0]},${corner[1]}`).join(" ");

  return (
    <svg className={`battle-grid ${className}`} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <polygon className="grid-floor" points={outline} />
      {cells.map((cell) => (
        <polygon key={cell.key} className={`grid-cell ${cell.down ? "is-down" : ""}`} points={cell.points} />
      ))}
      {lines.map((line) => (
        <line
          key={`${line.x1}:${line.y1}:${line.x2}:${line.y2}`}
          className="grid-line"
          x1={line.x1}
          y1={line.y1}
          x2={line.x2}
          y2={line.y2}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      <polygon className="grid-outline" points={outline} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
