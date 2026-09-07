import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * FUNCIONES DE APTITUD ARQUITECTÓNICA.
 *
 * La constitución de Torreón (docs/arquitectura/01-CONSTITUCION.md) declara
 * límites. Este archivo los HACE CUMPLIR: una constitución que sólo vive en un
 * markdown la deroga el primer agente con prisa.
 *
 * Cada prueba cita el artículo que defiende. Si una falla, la respuesta por
 * defecto NO es relajar la prueba: es respetar el límite. Mover un límite es un
 * cambio de constitución y exige un ADR nuevo en docs/arquitectura/adr/.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = resolve(here, "../../..");
const read = (relative: string) => readFileSync(resolve(repo, relative), "utf8");
const serverSource = (file: string) => read(`apps/server/src/${file}`);

/**
 * El Núcleo: las reglas del juego. No sabe quién lo llama ni dónde se guarda.
 * `artifacts.ts` queda deliberadamente FUERA: hoy escribe en disco directamente
 * y es la única fuga de infraestructura del Núcleo (ADR-0006 la cierra).
 */
const CORE_MODULES = [
  "domain.ts",
  "read-models.ts",
  "realm-events.ts",
  "treasury-flow.ts",
  "battle.ts",
  "party.ts",
  "horde.ts",
  "finance.ts",
  "scale.ts",
  "product.ts",
  "progression.ts",
  "inventory.ts",
  "companions.ts",
  "barracks.ts",
  "battle-memory.ts",
  "notifications.ts",
  "codice.ts",
];

/** Adaptadores de transporte: traducen un protocolo, no deciden reglas. */
const TRANSPORT_MODULES = ["app.ts", "mcp.ts"];

function importsOf(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /^\s*import\s[\s\S]*?from\s+"([^"]+)"/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) specifiers.push(match[1]);
  return specifiers;
}

describe("Artículo I — el Núcleo no conoce el transporte", () => {
  it.each(CORE_MODULES)("%s no importa Express ni el SDK de MCP", (file) => {
    const specifiers = importsOf(serverSource(file));
    const leaks = specifiers.filter(
      (specifier) =>
        specifier === "express" ||
        specifier.startsWith("@modelcontextprotocol") ||
        specifier === "./app.js" ||
        specifier === "./mcp.js",
    );
    expect(leaks, `${file} arrastra transporte al Núcleo: ${leaks.join(", ")}`).toEqual([]);
  });
});

describe("Artículo II — el Núcleo no conoce la persistencia", () => {
  it.each(CORE_MODULES)("%s no importa el almacén", (file) => {
    const leaks = importsOf(serverSource(file)).filter((specifier) => specifier === "./store.js");
    expect(leaks, `${file} depende del almacén: el Núcleo debe recibir estado, no ir a buscarlo`).toEqual([]);
  });

  it("domain.ts es vocabulario puro: no importa absolutamente nada", () => {
    expect(importsOf(serverSource("domain.ts"))).toEqual([]);
  });

  it("read-models.ts es proyección de lectura: no lee del almacén ni llama al servicio", () => {
    const specifiers = importsOf(serverSource("read-models.ts"));
    expect(specifiers).not.toContain("./store.js");
    expect(specifiers).not.toContain("./quest-service.js");
  });
});

describe("Artículo III — el transporte no toca la verdad directamente", () => {
  it.each(TRANSPORT_MODULES)("%s pasa por el servicio y nunca por el almacén", (file) => {
    const leaks = importsOf(serverSource(file)).filter((specifier) => specifier === "./store.js");
    expect(leaks, `${file} escribe el reino por su cuenta y se salta las reglas`).toEqual([]);
  });
});

describe("Artículo IV — el monolito sólo puede encoger", () => {
  /**
   * TRINQUETE. `quest-service.ts` acumuló quests, batalla, inventario,
   * tesorería, notificaciones, barracas y campañas en una sola clase. Este
   * presupuesto es su marca máxima histórica: cada extracción debe BAJARLO.
   * Nunca se sube. Si una función nueva no cabe, es que no vive aquí.
   */
  const BUDGET = 2767;

  it(`quest-service.ts no supera las ${BUDGET} líneas`, () => {
    const lines = serverSource("quest-service.ts").split("\n").length;
    expect(
      lines,
      `quest-service.ts tiene ${lines} líneas y el presupuesto es ${BUDGET}. ` +
        "Extrae un módulo del Núcleo en vez de ensanchar el servicio, y baja este número.",
    ).toBeLessThanOrEqual(BUDGET);
  });
});

describe("Artículo VIII — el Núcleo recibe el instante, no lo consulta", () => {
  /**
   * `new Date()` y `Date.now()` dentro del Núcleo son un reloj cableado: el
   * dominio deja de poder probarse en cualquier fecha —`F-001` pasaba los días
   * 1 a 5 del mes y fallaba los otros 25— y las pruebas de tiempo real resbalan
   * bajo carga. El instante ENTRA como dato (ADR-0006).
   *
   * `clock.ts` es la excepción evidente: es el sitio donde vive el reloj.
   */
  const CLOCK_FREE = [...CORE_MODULES, "artifacts.ts", "quest-service.ts"];

  it.each(CLOCK_FREE)("%s no consulta el reloj de pared", (file) => {
    const source = serverSource(file);
    const leaks = [...source.matchAll(/(new Date\(\)|Date\.now\(\))/g)].map((match) => match[1]);
    expect(
      leaks,
      `${file} lee el reloj por su cuenta (${leaks.join(", ")}). Recibe \`nowMs\` o usa el Clock inyectado.`,
    ).toEqual([]);
  });

  it("clock.ts es el único sitio donde vive el reloj de pared", () => {
    expect(serverSource("clock.ts")).toContain("Date.now()");
  });
});

describe("Artículo V — un solo vocabulario para todos los clientes", () => {
  /**
   * `apps/web/src/types.ts` es hoy una COPIA A MANO de `domain.ts`. Mientras
   * exista (ADR-0005 la sustituye por contrato generado), ninguna de las dos
   * puede desviarse en silencio: el renderer no redefine el vocabulario del
   * Núcleo para que le compile. Unity será el tercer cliente; con tres copias a
   * mano la deriva deja de ser detectable a ojo.
   */
  function literalUnions(source: string): Map<string, string> {
    const unions = new Map<string, string>();
    const pattern = /^export type ([A-Za-z]+) = ((?:"[^"]*"\s*\|?\s*)+);/gm;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) {
      const members = (match[2].match(/"[^"]*"/g) ?? []).sort();
      unions.set(match[1], members.join(" | "));
    }
    return unions;
  }

  const core = literalUnions(read("apps/server/src/domain.ts"));
  const web = literalUnions(read("apps/web/src/types.ts"));
  const shared = [...core.keys()].filter((name) => web.has(name));

  it("hay vocabulario compartido que vigilar", () => {
    expect(shared.length).toBeGreaterThan(5);
  });

  it.each(shared)("%s significa lo mismo en el Núcleo y en el cliente", (name) => {
    expect(web.get(name), `el cliente redefinió ${name}`).toBe(core.get(name));
  });
});
