import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "./clock.js";
import type { QuestPlanInput } from "./domain.js";
import { DEFAULT_PLAYER_ID } from "./players.js";
import { QuestService } from "./quest-service.js";
import type { RealmStore } from "./realm-store.js";
import { SqliteRealmStore, sqliteAvailable } from "./sqlite-store.js";
import { JsonRealmStore } from "./store.js";

const RELOJ_DEL_REINO = "2026-05-11T09:00:00.000Z";

function plan(title: string): QuestPlanInput {
  return {
    title,
    intent: `Resolver ${title}.`,
    outcome: `${title} queda resuelto y comprobable.`,
    rationale: "Una Battle real de unos diez minutos.",
    durationMinutes: 15,
    wellbeingConstraints: [],
    allowedApps: [],
    steps: [
      { title: "Primer empuje", actor: "user", evidence: "Constancia", evidenceKind: "declaration", weight: 40 },
      { title: "Golpe final", actor: "user", evidence: "Constancia", evidenceKind: "declaration", weight: 60 },
    ],
  };
}

/**
 * EL REINO NO CAMBIA DE VERDAD AL CAMBIAR DE ALMACÉN (artículo 6, ADR-0003).
 *
 * Las mismas reglas, contra los dos adaptadores. Si el juego se comporta
 * distinto según dónde se guarde, el puerto está mal y la etapa 3 no se puede
 * dar por buena.
 */
const ALMACENES: Array<{ nombre: string; disponible: boolean; crear: (directory: string) => RealmStore }> = [
  {
    nombre: "documento JSON",
    disponible: true,
    crear: (directory) => new JsonRealmStore(join(directory, "torreon-state.json"), fixedClock(RELOJ_DEL_REINO)),
  },
  {
    nombre: "SQLite",
    // `node:sqlite` es de Node 22.5+. Con Node 20 esta mitad se salta en vez de
    // romper: el adaptador JSON sigue siendo el camino soportado ahí.
    disponible: sqliteAvailable(),
    crear: (directory) => new SqliteRealmStore(join(directory, "torreon.db"), fixedClock(RELOJ_DEL_REINO)),
  },
];

for (const almacen of ALMACENES) {
  describe.skipIf(!almacen.disponible)(`El reino sobre ${almacen.nombre}`, () => {
    let directory: string;
    let store: RealmStore;

    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), "torreon-almacen-"));
      store = almacen.crear(directory);
      await store.init();
    });

    afterEach(async () => {
      (store as { close?: () => void }).close?.();
      await rm(directory, { recursive: true, force: true });
    });

    const servicio = (playerId = DEFAULT_PLAYER_ID) =>
      new QuestService(store, undefined, directory, "torreon-almacen-test", fixedClock(RELOJ_DEL_REINO), playerId);

    it("recorre el contrato completo: pacto, reloj, evidencia y KO", async () => {
      const service = servicio();
      const draft = await service.createDraft(plan("La deuda del Marqués"));
      await service.accept(draft.id, true);
      await service.start(draft.id);

      for (const step of draft.steps) {
        await service.submitEvidence(draft.id, step.id, {
          summary: "Constancia entregada",
          source: "user_declaration",
          verdict: "accepted",
          reasoning: "El paso pactó una declaración y la declaración llegó.",
          impactAwarded: step.weight,
        });
      }

      const snapshot = await service.snapshot();
      expect(snapshot.progress?.validatedImpact).toBe(100);
      expect(snapshot.realm.quests[0].status).toBe("completed");
    });

    it("lo escrito sobrevive a releer el reino desde cero", async () => {
      const draft = await servicio().createDraft(plan("La deuda del Marqués"));
      const otroServicio = servicio();
      const snapshot = await otroServicio.snapshot();
      expect(snapshot.realm.quests.map((quest) => quest.id)).toEqual([draft.id]);
    });

    it("dos jugadores no se ven la campaña", async () => {
      const suya = await servicio().createDraft(plan("La deuda del Marqués"));
      const ajena = await servicio("cordera-la-otra").createDraft(plan("El huerto de Cordera"));
      expect((await servicio().snapshot()).realm.quests.map((q) => q.id)).toEqual([suya.id]);
      expect((await servicio("cordera-la-otra").snapshot()).realm.quests.map((q) => q.id)).toEqual([ajena.id]);
    });

    it("dos escrituras simultáneas sobre el mismo reino no se pierden", async () => {
      const service = servicio();
      await Promise.all([
        service.createDraft(plan("Frente A")),
        service.createDraft(plan("Frente B")),
        service.createDraft(plan("Frente C")),
      ]);
      const snapshot = await service.snapshot();
      expect(snapshot.realm.quests).toHaveLength(3);
    });
  });
}

/**
 * EL EXPEDIENTE NO SE BORRA (artículo 3).
 *
 * El documento JSON recorta los hechos a 100/200 porque el log vive dentro del
 * mismo archivo que el estado. Un almacén que sepa guardar historia tiene que
 * guardarla ENTERA: es la razón de ser de la etapa 3.
 */
describe.skipIf(!sqliteAvailable())("El expediente en SQLite", () => {
  let directory: string;
  let store: SqliteRealmStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "torreon-expediente-"));
    store = new SqliteRealmStore(join(directory, "torreon.db"), fixedClock(RELOJ_DEL_REINO));
    await store.init();
  });

  afterEach(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("archiva cada hecho aunque el reino sólo conserve los últimos", async () => {
    const service = new QuestService(store, undefined, directory, "torreon-expediente-test", fixedClock(RELOJ_DEL_REINO));
    for (let i = 0; i < 60; i += 1) {
      await service.createDraft(plan(`Frente ${i}`));
    }
    const state = await store.read();
    const expediente = await store.history(DEFAULT_PLAYER_ID, { limit: 5000 });
    const hechosDeReino = expediente.filter((entry) => entry.source === "realm");

    // El documento recorta; el expediente NO.
    expect(state.events.length).toBeLessThanOrEqual(100);
    expect(hechosDeReino.length).toBeGreaterThanOrEqual(60);
    expect(new Set(hechosDeReino.map((entry) => entry.eventId)).size).toBe(hechosDeReino.length);
  });

  it("reiniciar el reino no borra lo que ya ocurrió", async () => {
    const service = new QuestService(store, undefined, directory, "torreon-expediente-test", fixedClock(RELOJ_DEL_REINO));
    await service.createDraft(plan("La deuda del Marqués"));
    const antes = await store.history(DEFAULT_PLAYER_ID);
    expect(antes.length).toBeGreaterThan(0);

    await store.reset();

    expect((await store.read()).quests).toHaveLength(0);
    // Anular no es borrar: el expediente sigue entero.
    expect(await store.history(DEFAULT_PLAYER_ID)).toHaveLength(antes.length);
  });

  it("el expediente se puede reanudar desde donde se dejó", async () => {
    const service = new QuestService(store, undefined, directory, "torreon-expediente-test", fixedClock(RELOJ_DEL_REINO));
    await service.createDraft(plan("Primero"));
    const primeraTanda = await store.history(DEFAULT_PLAYER_ID);
    const cursor = primeraTanda[primeraTanda.length - 1].seq;

    await service.createDraft(plan("Segundo"));
    const siguientes = await store.history(DEFAULT_PLAYER_ID, { since: cursor });

    expect(siguientes.length).toBeGreaterThan(0);
    expect(siguientes.every((entry) => entry.seq > cursor)).toBe(true);
  });
});
