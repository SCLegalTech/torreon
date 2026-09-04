import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * UX-001 — EL SCROLL VERTICAL DEL CENTRO DE NOTIFICACIONES.
 *
 * Con nueve avisos sólo se veían los de arriba: `.notif-scene` heredaba de
 * `.scene` un `overflow: hidden` y, en horizontal, una altura fija, así que las
 * tarjetas inferiores quedaban recortadas y era imposible alcanzarlas.
 *
 * El arreglo NO puede ser archivar avisos, subir una altura fija ni renderizar
 * menos elementos: la cabecera se queda quieta y la LISTA se desplaza. Esta
 * prueba defiende esa forma del layout, porque es la única que sobrevive a
 * veinte avisos en un teléfono.
 *
 * Es una prueba de hoja de estilos a propósito: aquí no hay DOM que montar, y
 * el bug vivía exactamente en estas cuatro declaraciones.
 */

const here = dirname(fileURLToPath(import.meta.url));
const stylesheet = resolve(here, "../../web/src/styles.css");
const view = resolve(here, "../../web/src/main.tsx");

/** Devuelve el cuerpo de una regla CSS por su selector exacto. */
function ruleFor(css: string, selector: string): string {
  const index = css.indexOf(`\n${selector} {`);
  if (index === -1) return "";
  const open = css.indexOf("{", index);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

describe("Layout móvil de las pantallas con lista", () => {
  it("UX-001: la lista de notificaciones es la que se desplaza, no la pantalla", async () => {
    const css = await readFile(stylesheet, "utf8");
    const list = ruleFor(css, ".notif-list");

    expect(list).toContain("overflow-y: auto");
    // Sin `min-height: 0` un hijo de flex no encoge y el scroll nunca aparece.
    expect(list).toContain("min-height: 0");
    // Sin esto el gesto vertical se lo queda el contenedor equivocado.
    expect(list).toContain("touch-action: pan-y");
    expect(list).toContain("overscroll-behavior: contain");
    // El último aviso no puede quedar debajo del borde inferior del teléfono.
    expect(list).toContain("env(safe-area-inset-bottom)");

    const scene = ruleFor(css, ".notif-scene");
    expect(scene).toContain("display: flex");
    expect(scene).toContain("flex-direction: column");
    // La cabecera no se desplaza con la lista.
    expect(ruleFor(css, ".notif-top")).toContain("flex: 0 0 auto");
  });

  it("UX-001b: Tesorería y Barracas usan el mismo patrón de cabecera fija y cuerpo desplazable", async () => {
    const css = await readFile(stylesheet, "utf8");
    for (const selector of [".treasury-body", ".barracks-body"]) {
      const rule = ruleFor(css, selector);
      expect(rule).toContain("overflow-y: auto");
      expect(rule).toContain("min-height: 0");
      expect(rule).toContain("touch-action: pan-y");
    }
  });

  it("UX-002: Tesorería no se dibuja dentro de la cabecera de Batallas Libres", async () => {
    const tsx = await readFile(view, "utf8");
    // El botón que colgaba Tesorería de Batallas Libres ya no existe.
    expect(tsx).not.toContain("dock-treasury");
    // Ahora la navegación del mundo la declara el Core y la pantalla la pinta.
    expect(tsx).toContain("world-systems");
    expect(tsx).toContain("snapshot.worldSystems");
  });

  it("UX-003: la pantalla ya no apaga una Quest por no ser la `currentQuest` legada", async () => {
    const tsx = await readFile(view, "utf8");
    expect(tsx).not.toContain("ESTA QUEST ESPERA SU TURNO");
    // El único bloqueo posible viene del Core, con su motivo explícito.
    expect(tsx).toContain("lockedByDependency");
    expect(tsx).toContain("node?.lockedBy");
  });
});

/**
 * CASO E — SPRITES IDLE DEL GRUPO.
 *
 * ROKU IS SMALL: ~30% OF THE MARQUÉS. THE PARTY MUST LOOK LIKE ONE PARTY.
 *
 * Las medidas declaradas en `PartySprite.tsx` no son decorativas: de ellas sale
 * el recorte del lienzo y la escala de cada personaje. Si alguien cambia un GIF
 * sin volver a medirlo, el recorte enseñaría transparencia o cortaría la capa,
 * el arco o la cola. Esta prueba lee los archivos REALES y los confronta con lo
 * declarado.
 */
describe("Sprites idle del grupo", () => {
  const spritesDir = resolve(here, "../../web/public/assets/sprites/party");
  const component = resolve(here, "../../web/src/PartySprite.tsx");

  /** Ancho y alto lógicos del GIF: bytes 6..9 del encabezado, little endian. */
  async function gifCanvas(file: string): Promise<{ w: number; h: number }> {
    const bytes = await readFile(file);
    expect(bytes.subarray(0, 3).toString("ascii")).toBe("GIF");
    return { w: bytes.readUInt16LE(6), h: bytes.readUInt16LE(8) };
  }

  /** Las medidas declaradas para un personaje, leídas del propio componente. */
  function declared(source: string, id: string) {
    const block = source.slice(source.indexOf(`  ${id}: {`));
    const canvas = block.match(/canvas: \{ w: (\d+), h: (\d+) \}/)!;
    const box = block.match(/box: \{ x: (\d+), y: (\d+), w: (\d+), h: (\d+) \}/)!;
    const scale = block.match(/scale: ([\d.]+),/)!;
    return {
      canvas: { w: Number(canvas[1]), h: Number(canvas[2]) },
      box: { x: Number(box[1]), y: Number(box[2]), w: Number(box[3]), h: Number(box[4]) },
      scale: Number(scale[1]),
    };
  }

  it("los tres GIF idle existen y su lienzo es el declarado", async () => {
    const source = await readFile(component, "utf8");
    for (const [id, file] of [
      ["marques", "marques-idle.gif"],
      ["cordera", "cordera-idle.gif"],
      ["roku", "roku-idle.gif"],
    ] as const) {
      const canvas = await gifCanvas(resolve(spritesDir, file));
      const spec = declared(source, id);
      expect(canvas).toEqual(spec.canvas);
      // La caja visible tiene que caber dentro del lienzo, o el recorte
      // enseñaría vacío o cortaría al personaje.
      expect(spec.box.x + spec.box.w).toBeLessThanOrEqual(canvas.w);
      expect(spec.box.y + spec.box.h).toBeLessThanOrEqual(canvas.h);
    }
  });

  it("las proporciones del grupo se miden por altura VISIBLE, no por el lienzo", async () => {
    const source = await readFile(component, "utf8");
    const marques = declared(source, "marques");
    const cordera = declared(source, "cordera");
    const roku = declared(source, "roku");

    expect(marques.scale).toBe(1);
    // Cordera conserva estatura humana, algo por debajo del Marqués.
    expect(cordera.scale).toBeGreaterThanOrEqual(0.89);
    expect(cordera.scale).toBeLessThanOrEqual(0.92);
    // Roku es pequeño: eso es parte de la composición, no un descuido.
    expect(roku.scale).toBeCloseTo(0.3, 2);

    // Escalar por el LIENZO daría proporciones muy distintas: por eso no se hace.
    const byCanvas = roku.canvas.h / marques.canvas.h;
    expect(byCanvas).toBeGreaterThan(0.45);
  });

  it("el grupo se dibuja con una sola escala y sin estirar en X/Y por separado", async () => {
    const source = await readFile(component, "utf8");
    // Un único factor gobierna ancho y alto: es lo que preserva el aspect ratio.
    expect(source).toContain("const factor = `calc(${heroHeight} * ${metrics.scale} / ${metrics.box.h})`");
    expect(source).toContain("width: `calc(${factor} * ${metrics.canvas.w})`");
    expect(source).toContain("height: `calc(${factor} * ${metrics.canvas.h})`");

    const css = await readFile(stylesheet, "utf8");
    // Pixel art nítido: nada de suavizado al escalar.
    expect(ruleFor(css, ".party-sprite img")).toContain("image-rendering: pixelated");
    // Una sola línea de suelo: las ventanas se alinean por su borde inferior.
    expect(ruleFor(css, ".realm-party")).toContain("align-items: flex-end");
  });

  it("en el Reino el Marqués va a la izquierda, Roku en medio y Cordera enfrente", async () => {
    const tsx = await readFile(view, "utf8");
    const band = tsx.slice(tsx.indexOf('<div className="realm-party"'), tsx.indexOf("</div>", tsx.indexOf('<div className="realm-party"')));
    const order = [...band.matchAll(/id="(marques|roku|cordera)"/g)].map((match) => match[1]);
    expect(order).toEqual(["marques", "roku", "cordera"]);
    // Cordera mira hacia el Marqués; él y Roku miran hacia el otro lado.
    expect(band).toContain('id="cordera" heroHeight="var(--party-hero-h)" facing="left"');
    expect(band).toContain('id="marques" heroHeight="var(--party-hero-h)" facing="right"');
  });

  /**
   * EL TABLERO 4×4 EN ISOMÉTRICO.
   *
   * Marqués y Cordera en las casillas del rey y la reina de nuestra fila de
   * fondo; Roku en la casilla de peón que hay DELANTE del Marqués. La caja va
   * en proporción 2:1 para que cada casilla sea un rombo del doble de ancho que
   * de alto: sin eso el plano deja de ser isométrico.
   */
  it("el tablero coloca al rey, la reina y el peón donde dice el ajedrez", async () => {
    const source = await readFile(component, "utf8");
    const cells = source.slice(source.indexOf("export const PARTY_CELLS"));
    expect(cells).toContain("marques: { file: 0, rank: 1 }");
    expect(cells).toContain("cordera: { file: 0, rank: 2 }");
    // Un file más adelante que el Marqués, en su mismo rank: peón enfrente.
    expect(cells).toContain("roku: { file: 1, rank: 1 }");

    const css = await readFile(stylesheet, "utf8");
    const board = ruleFor(css, ".battle-board");
    expect(board).toContain("aspect-ratio: 2 / 1");
    // El plano se dibuja tenue, pero se dibuja: tiene suelo, damero y borde.
    expect(css).toContain(".iso-floor");
    expect(css).toContain(".iso-cell");
    expect(css).toContain(".iso-outline");
  });
});
