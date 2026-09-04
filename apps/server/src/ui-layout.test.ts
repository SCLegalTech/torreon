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
 * EL ESCENARIO Y EL GRUPO.
 *
 * Las medidas declaradas en `PartySprite.tsx` no son decorativas: de ellas
 * salen el recorte del lienzo, la escala de cada personaje y el sitio exacto de
 * cada casilla. Si alguien cambia un GIF o un fondo sin volver a medirlo, el
 * recorte enseñaría transparencia y las piezas se despegarían del suelo pintado.
 * Esta prueba lee los archivos REALES y los confronta con lo declarado.
 */
describe("El escenario, el grupo y las dos cuadrículas", () => {
  const spritesDir = resolve(here, "../../web/public/assets/sprites/party");
  const artDir = resolve(here, "../../web/public/assets/art");
  const component = resolve(here, "../../web/src/PartySprite.tsx");

  /** Ancho y alto lógicos del GIF: bytes 6..9 del encabezado, little endian. */
  async function gifCanvas(file: string): Promise<{ w: number; h: number }> {
    const bytes = await readFile(file);
    expect(bytes.subarray(0, 3).toString("ascii")).toBe("GIF");
    return { w: bytes.readUInt16LE(6), h: bytes.readUInt16LE(8) };
  }

  /** Ancho y alto del PNG: los ocho bytes que siguen a la cabecera IHDR. */
  async function pngSize(file: string): Promise<{ w: number; h: number }> {
    const bytes = await readFile(file);
    expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
    return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
  }

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
      // La caja visible cabe dentro del lienzo, o el recorte enseñaría vacío.
      expect(spec.box.x + spec.box.w).toBeLessThanOrEqual(canvas.w);
      expect(spec.box.y + spec.box.h).toBeLessThanOrEqual(canvas.h);
    }
  });

  /**
   * LAS PROPORCIONES SALEN DEL MOCKUP, NO DE UNA TABLA.
   *
   * Medidas sobre los mockups que compuso el jugador: en `MAIN MOCKUP.png` el
   * Marqués mide 306 px, Cordera 300 y Roku 136; en el de Battle, 356 / 370 /
   * 140. Sustituyen al 0.90 / 0.30 del documento anterior.
   */
  it("Cordera es casi tan alta como el Marqués y Roku es un perro grande", async () => {
    const source = await readFile(component, "utf8");
    const marques = declared(source, "marques");
    const cordera = declared(source, "cordera");
    const roku = declared(source, "roku");

    expect(marques.scale).toBe(1);
    expect(cordera.scale).toBeGreaterThanOrEqual(0.95);
    expect(cordera.scale).toBeLessThanOrEqual(1);
    expect(roku.scale).toBeGreaterThanOrEqual(0.38);
    expect(roku.scale).toBeLessThanOrEqual(0.46);

    // Se mide por altura VISIBLE: por el lienzo, Roku saldría al doble.
    expect(roku.canvas.h / marques.canvas.h).toBeGreaterThan(0.45);
  });

  it("una sola escala gobierna ancho y alto: nada se estira en X/Y por separado", async () => {
    const source = await readFile(component, "utf8");
    expect(source).toContain("const factor = `calc(${heroHeight} * ${metrics.scale} / ${metrics.box.h})`");
    expect(source).toContain("width: `calc(${factor} * ${metrics.canvas.w})`");
    expect(source).toContain("height: `calc(${factor} * ${metrics.canvas.h})`");
    // Sólo se espeja si lo pedido no coincide con cómo viene el asset.
    expect(source).toContain("const mirrored = Boolean(facing) && facing !== metrics.nativeFacing");

    const css = await readFile(stylesheet, "utf8");
    expect(ruleFor(css, ".party-sprite img")).toContain("image-rendering: pixelated");
    // Los pies caen en el punto indicado; el cuerpo crece hacia arriba.
    expect(ruleFor(css, ".stage-piece")).toContain("translate(-50%, -100%)");
  });

  /**
   * EL ESCENARIO SIGUE AL ARTE, NO A LA PANTALLA.
   *
   * El fondo se dibuja con `cover`: en una pantalla que no sea 16:9 se recorta.
   * Si el grupo se colocara en % de la pantalla, se despegaría del suelo pintado
   * en cuanto cambiara la proporción. La caja del escenario reproduce la
   * geometría de `cover` con longitudes concretas, y todo lo de dentro va en %
   * del ARTE. Por eso el lienzo del fondo no puede cambiar sin volver a medir.
   */
  it("el escenario reproduce `cover` y el arte conserva el lienzo medido", async () => {
    const css = await readFile(stylesheet, "utf8");
    const scene = ruleFor(css, ".realm-scene, .battle-scene");
    expect(scene).toContain("--stage-w: max(100vw, 100dvh * 1672 / 941)");
    expect(scene).toContain("--stage-h: max(100dvh, 100vw * 941 / 1672)");

    for (const file of ["realm-menu-mockup.png", "battle-realm.png"]) {
      expect(await pngSize(resolve(artDir, file))).toEqual({ w: 1672, h: 941 });
    }
  });

  it("en el Reino: Marqués a la izquierda, Roku en medio, Cordera enfrente", async () => {
    const source = await readFile(component, "utf8");
    const spots = source.slice(source.indexOf("export const REALM_SPOTS"), source.indexOf("BATTLE_HERO_HEIGHT"));
    const parsed = [...spots.matchAll(/id: "(\w+)", centerX: ([\d.]+), depth: (\d)/g)].map((match) => ({
      id: match[1],
      centerX: Number(match[2]),
      depth: Number(match[3]),
    }));
    expect(parsed).toHaveLength(3);

    const byX = [...parsed].sort((a, b) => a.centerX - b.centerX).map((spot) => spot.id);
    expect(byX).toEqual(["marques", "roku", "cordera"]);

    // Son un grupo, no tres figuras en fila: Cordera detrás, Roku delante.
    const depth = Object.fromEntries(parsed.map((spot) => [spot.id, spot.depth]));
    expect(depth.cordera).toBeLessThan(depth.marques);
    expect(depth.marques).toBeLessThan(depth.roku);
  });

  /**
   * DOS CUADRÍCULAS INDEPENDIENTES DE 2×2, no un tablero único de 4×4: una del
   * grupo y otra de la Horda, enfrentadas. Los vértices están calcados del
   * trazo del mockup y se inclinan en sentidos opuestos porque se miran.
   */
  it("hay dos cuadrículas 2×2 enfrentadas, calcadas del mockup", async () => {
    const source = await readFile(component, "utf8");
    expect(source).toContain("export const GRID_COLS = 2");
    expect(source).toContain("export const GRID_ROWS = 2");

    const quad = (name: string) => {
      const block = source.slice(source.indexOf(`export const ${name}: Quad = {`));
      return Object.fromEntries(
        [...block.slice(0, 220).matchAll(/(tl|tr|br|bl): \[([\d.]+), ([\d.]+)\]/g)].map((match) => [
          match[1],
          [Number(match[2]), Number(match[3])],
        ]),
      ) as Record<string, [number, number]>;
    };
    const ally = quad("ALLY_QUAD");
    const horde = quad("HORDE_QUAD");
    for (const corners of [ally, horde]) {
      expect(Object.keys(corners).sort()).toEqual(["bl", "br", "tl", "tr"]);
    }

    // Independientes: la del grupo termina antes de que empiece la de la Horda.
    expect(Math.max(ally.tr[0], ally.br[0])).toBeLessThan(Math.min(horde.tl[0], horde.bl[0]));

    // Enfrentadas: el lado del grupo se inclina a la izquierda al bajar y el de
    // la Horda a la derecha. Si las dos cayeran igual, no se estarían mirando.
    expect(ally.bl[0] - ally.tl[0]).toBeLessThan(0);
    expect(horde.bl[0] - horde.tl[0]).toBeGreaterThan(0);
  });

  it("la columna que da a la Horda la ocupan Roku y el agente", async () => {
    const source = await readFile(component, "utf8");
    const cells = source.slice(source.indexOf("export const ALLY_CELLS"));
    const parsed = Object.fromEntries(
      [...cells.slice(0, 260).matchAll(/(\w+): \{ col: (\d), row: (\d) \}/g)].map((match) => [
        match[1],
        { col: Number(match[2]), row: Number(match[3]) },
      ]),
    );
    expect(Object.keys(parsed).sort()).toEqual(["agent", "cordera", "marques", "roku"]);

    // Cuatro combatientes, cuatro casillas distintas: es un tablero, no un montón.
    const taken = Object.values(parsed).map((cell) => `${cell.col},${cell.row}`);
    expect(new Set(taken).size).toBe(4);

    // Roku se interpone y el cuarto slot entra a su lado; detrás, los dos humanos.
    expect(parsed.roku.col).toBe(1);
    expect(parsed.agent.col).toBe(1);
    expect(parsed.marques.col).toBe(0);
    expect(parsed.cordera.col).toBe(0);
  });
});
