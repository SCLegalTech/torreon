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

  /*
    NINGÚN CONTROL PRINCIPAL PUEDE FALLAR EN SILENCIO.

    Las cuatro pruebas que siguen defienden los cuatro no-ops del reporte P0.
    Ninguno era un error de lógica de juego: los cuatro eran la pantalla
    prometiendo una acción que no podía ocurrir.
  */

  it("UX-004: «Batallas libres» lleva a una pantalla, no a un desplazamiento imaginario", async () => {
    const tsx = await readFile(view, "utf8");
    // El no-op original: pedirle al navegador que desplazara un panel anclado en
    // absoluto que YA estaba en pantalla. Tocar el botón no producía nada.
    expect(tsx).not.toContain("querySelector(\".realm-dock\")");
    expect(tsx).not.toMatch(/\?\.scrollIntoView\(/);
    // Ahora existe una pantalla de verdad, y abre con Battles o con un vacío dicho.
    expect(tsx).toContain("function BattlesScreen");
    expect(tsx).toContain("No hay Batallas libres disponibles");
    // Y una Battle de Campaña es alcanzable sin depender de su notificación.
    expect(tsx).toContain("openFronts");
  });

  it("UX-005: el zurrón se dibuja por ENCIMA del velo de derrota", async () => {
    const css = await readFile(stylesheet, "utf8");
    const zIndexOf = (selector: string) => {
      // Gana la última declaración, igual que en la cascada.
      const matches = [...css.matchAll(new RegExp(`\n${selector.replace(".", "\.")} \{([^}]*)\}`, "g"))];
      const values = matches.map((match) => match[1].match(/z-index:\s*(\d+)/)).filter(Boolean);
      return Number(values[values.length - 1]![1]);
    };
    // El bug: mismo z-index y el modal pintado después. El panel se abría y no se veía.
    expect(zIndexOf(".inventory-drawer")).toBeGreaterThan(zIndexOf(".battle-defeat"));

    const tsx = await readFile(view, "utf8");
    // Y además se monta después del diálogo, para que ni un empate lo entierre.
    expect(tsx.indexOf("<InventoryDrawer")).toBeGreaterThan(tsx.indexOf("battle-defeat"));
  });

  it("UX-006: las acciones de Battle apuntan al frente que se está pintando", async () => {
    const tsx = await readFile(view, "utf8");
    const battleProps = tsx.slice(tsx.indexOf("<Battle"));
    // Replanificar, iniciar, aceptar y entregar evidencia iban contra la
    // proyección legada mientras la pantalla dibujaba `battleQuest`. Con las dos
    // apuntando a Quests distintas, el botón no hacía nada visible.
    expect(battleProps).toContain("battleQuestId");
    expect(battleProps).not.toMatch(/quest && void act\(\) =>/);
    expect(battleProps).toContain("battle/recover");
  });

  it("UX-007: ninguna tipografía de la interfaz baja de ~10 px", async () => {
    const css = await readFile(stylesheet, "utf8");
    const tiny = [...css.matchAll(/font(?:-size)?\s*:[^;{}]*?(?<![\d.])(0?\.(\d+)rem)/g)]
      .map((match) => match[1])
      .filter((value) => Number(`0${value.replace("rem", "")}`) < 0.62);
    // Había ochenta y cuatro `clamp()` con mínimos de cuatro y cinco píxeles:
    // eso no es interfaz densa, es texto que el jugador no puede leer.
    expect(tiny).toEqual([]);
  });

  it("UX-008: Campaña, Acto y Orden dejaron de clavar sus paneles en % del arte", async () => {
    const tsx = await readFile(view, "utf8");
    const css = await readFile(stylesheet, "utf8");
    // Cabecera quieta, barra de acción quieta, y el resto en un cuerpo que se desplaza.
    expect(tsx.match(/className="scene-body"/g)?.length).toBeGreaterThanOrEqual(4);
    const body = ruleFor(css, ".scene-body");
    expect(body).toContain("overflow-y: auto");
    expect(body).toContain("min-height: 0");
    expect(body).toContain("touch-action: pan-y");
    /*
      Y se reparte con FLEX. Con una rejilla de filas automáticas dentro de un
      contenedor de altura definida y scroll, Chrome dejaba todas las filas en
      ~55 px y los paneles se derramaban unos sobre otros: el mismo apilamiento,
      mudado al sitio nuevo. Cada fila tiene que medir lo que mide su panel más
      alto, y lo que no cabe se desplaza.
    */
    expect(css).toContain("flex-wrap: wrap;");
    expect(css).toContain(".scene-body > * { flex: 1 1 15rem; min-width: 0; }");
    // Y los paneles vuelven al flujo: la calca en porcentajes queda desactivada.
    expect(css).toContain("position: static;");
    expect(css).toContain("inset: auto;");
  });

  it("UX-009: borrar la partida entera no vive a un toque del juego", async () => {
    const tsx = await readFile(view, "utf8");
    // El botón del engranaje reiniciaba el reino desde la pantalla principal.
    expect(tsx).not.toContain("/api/reset");
    expect(tsx).not.toContain("settings-hotspot");
    expect(tsx).not.toContain("REINICIAR REINO");
  });

  it("UX-010: los avisos están arriba, y sólo arriba", async () => {
    const tsx = await readFile(view, "utf8");
    // La barra inferior sólo lleva lo que no tiene edificio ni franja propia:
    // Notificaciones y Batalla activa salían dos veces en la misma pantalla.
    const placed = tsx.slice(tsx.indexOf("const PLACED = new Set("), tsx.indexOf("const PLACED = new Set(") + 140);
    expect(placed).toContain("notifications");
    expect(placed).toContain("barracks");
    expect(placed).toContain("treasury");
    expect(placed).toContain("battle");
  });

  it("UX-011: Tesorería y Barracas viven sobre su edificio del mapa, no en una barra", async () => {
    const tsx = await readFile(view, "utf8");
    const css = await readFile(stylesheet, "utf8");
    // El Torreón Principal ES las Barracas; la casa de la Tesorería, la Tesorería.
    expect(tsx).toContain("spot-keep");
    expect(tsx).toContain("spot-treasury");
    // Y se colocan en % del ARTE, dentro de la caja del escenario, para que no
    // se despeguen de su edificio en una pantalla que no sea 16:9.
    expect(ruleFor(css, ".stage-hotspot")).toContain("position: absolute");
    expect(css).toMatch(/\.spot-keep \{[^}]*top: [\d.]+%/);
    expect(css).toMatch(/\.spot-treasury \{[^}]*top: [\d.]+%/);
  });

  it("UX-012: el campo de batalla no lleva nada encima, y los ocho cuadros van a las esquinas", async () => {
    const tsx = await readFile(view, "utf8");
    const css = await readFile(stylesheet, "utf8");
    // Las dos barras agregadas —Horda y Marqués— repetían lo que ya dice cada
    // cuadro y tapaban justo lo que el jugador está mirando.
    expect(tsx).not.toContain("enemy-health");
    expect(tsx).not.toContain("player-health");
    expect(tsx).not.toContain("battle-hud");
    // Cuatro abajo a la izquierda, cuatro abajo a la derecha, campo libre en medio.
    expect(css).toContain('"party  center horde"');
    expect(css).toContain('"field  field  field"');
    expect(css).toContain("grid-area: party;");
    expect(css).toContain("grid-area: horde;");
  });

  it("UX-013: toda misión ofrece las dos decisiones: JUGAR y ELIMINAR", async () => {
    const tsx = await readFile(view, "utf8");
    expect(tsx).toContain(">JUGAR<");
    expect(tsx).toContain(">ELIMINAR<");
    // Y eliminar pasa por el Core, que decide si eso es borrar o abandonar.
    expect(tsx).toContain("/discard");
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
