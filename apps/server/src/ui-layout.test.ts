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
