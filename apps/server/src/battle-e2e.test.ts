import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpApp } from "./app.js";
import { fixedClock } from "./clock.js";
import type { QuestPlanInput } from "./domain.js";
import { QuestService } from "./quest-service.js";
import { JsonRealmStore } from "./store.js";

const RELOJ_DEL_REINO = "2026-05-11T09:00:00.000Z";

/** El fixture real que trajo el bug. No se recrea nada ya completado. */
const LA_DOBLE_RADICACION: QuestPlanInput = {
  campaignTitle: "La Forja de Solve & Coagula",
  title: "La Doble Radicación",
  intent: "Radicar la coadyuvancia y la tutela personal en el mismo frente.",
  outcome: "Ambas actuaciones quedan radicadas y existe comprobante, correo de recepción o número de radicado.",
  rationale: "Dos radicaciones que comparten ventana y sistema: se hacen juntas o se pierde el turno.",
  durationMinutes: 60,
  wellbeingConstraints: [],
  allowedApps: [],
  steps: [
    { title: "Radicar la coadyuvancia", actor: "user", evidence: "Número de radicado o acuse de la coadyuvancia", evidenceKind: "file", weight: 50 },
    { title: "Radicar la tutela personal", actor: "user", evidence: "Número de radicado o acuse de la tutela", evidenceKind: "file", weight: 50 },
  ],
};

const UN_FRENTE_VIEJO: QuestPlanInput = {
  ...LA_DOBLE_RADICACION,
  title: "El Archivo del Coloso I",
  steps: [{ title: "Clasificar la primera tanda", actor: "user", evidence: "Inventario", evidenceKind: "declaration", weight: 100 }],
};

/**
 * LA CADENA COMPLETA, DE PUNTA A PUNTA.
 *
 * El Dungeon Master iniciaba una Battle y el jugador no la veía: ni en Batallas,
 * ni en Avisos, y el Home seguía mostrando el frente anterior. La cadena que
 * esta prueba recorre es exactamente la que se rompía:
 *
 *   DM crea → sella → inicia → Realm → frente comprometido → Home → Batallas → Avisos
 *
 * Lo que se afirma no es «respondió 200»: es que TODAS las pantallas nombran el
 * MISMO frente, y que ese frente es el que se pidió.
 */
describe("Iniciar una Battle se ve en todo el reino", () => {
  let directory: string;
  let service: QuestService;
  let app: ReturnType<typeof createHttpApp>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "torreon-e2e-"));
    const store = new JsonRealmStore(join(directory, "state.json"), fixedClock(RELOJ_DEL_REINO));
    await store.init();
    service = new QuestService(store, undefined, directory, "torreon-e2e-test", fixedClock(RELOJ_DEL_REINO));
    app = createHttpApp(service);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /** El frente viejo que el jugador dejó atrás con el grupo tocado. */
  async function frenteViejoEnPausa(): Promise<string> {
    const viejo = await service.createDraft(UN_FRENTE_VIEJO);
    await service.accept(viejo.id, true);
    await service.start(viejo.id);
    await service.proposeBattleRecontract(viejo.id, { reason: "El plazo se quedó corto y hay que repactarlo.", newDurationMinutes: 30 });
    // Se suelta el frente sin cerrarlo: queda vivo pero sin reloj.
    await service.abandon(viejo.id, "El jugador se fue a otro frente.");
    return viejo.id;
  }

  it("la cadena entera nombra el mismo frente: Realm, Home, Batallas y Avisos", async () => {
    const viejoId = await frenteViejoEnPausa();

    // 1. DM: crear, sellar, iniciar.
    const draft = await service.createDraft(LA_DOBLE_RADICACION);
    expect(draft.id).not.toBe(viejoId);
    await service.accept(draft.id, true);
    const iniciada = await service.start(draft.id, 60);

    // 2. El Realm, tal como lo lee el Dungeon Master.
    const dm = await service.dungeonMasterState();
    expect(dm.activeBattle?.questId).toBe(draft.id);
    expect(dm.activeBattle?.status).toBe("active");
    expect(dm.activeBattle?.startedAt).toBe(iniciada.battle!.startedAt);
    expect(dm.activeBattle?.endsAt).toBe(iniciada.battle!.deadlineAt);
    expect(dm.activeBattle?.remainingMinutes).toBe(60);

    // 3. Home: la Battle visible es la comprometida, no la que quedó atrás.
    const home = await request(app).get("/v1/realm/summary").expect(200);
    expect(home.body.data.battleQuestId).toBe(draft.id);

    // 4. Batallas: el mismo id, y el frente viejo sigue listado pero SIN reloj.
    const frentes: Array<{ questId: string; engaged: boolean }> = home.body.data.openFronts;
    const conReloj = frentes.filter((front) => front.engaged);
    expect(conReloj).toHaveLength(1);
    expect(conReloj[0].questId).toBe(draft.id);

    // 5. El frente de la Battle abierto por id: el mismo, con el mismo reloj.
    const batalla = await request(app).get(`/v1/battle/${draft.id}`).expect(200);
    expect(batalla.body.data.battle.status).toBe("active");
    expect(batalla.body.data.battle.clock.deadlineAt).toBe(dm.activeBattle!.endsAt);

    // 6. Avisos: exactamente UNO de esta Battle, y apunta a esta Quest.
    const avisos = await request(app).get("/v1/notifications").expect(200);
    const suyos = avisos.body.data.notifications.filter(
      (aviso: { type: string; entityId: string }) => aviso.type === "battle_started" && aviso.entityId === draft.id,
    );
    expect(suyos).toHaveLength(1);
  });

  it("un frente en pausa no impide comprometer otro: sólo un reloj a la vez", async () => {
    const viejoId = await frenteViejoEnPausa();
    const draft = await service.createDraft(LA_DOBLE_RADICACION);
    await service.accept(draft.id, true);
    await service.start(draft.id, 60);

    const dm = await service.dungeonMasterState();
    expect(dm.activeBattle?.questId).toBe(draft.id);
    expect(dm.openFronts.filter((front) => front.engaged)).toHaveLength(1);
    expect(dm.openFronts.some((front) => front.questId === viejoId)).toBe(false);
  });

  it("dos relojes a la vez no pueden existir", async () => {
    const primera = await service.createDraft(LA_DOBLE_RADICACION);
    await service.accept(primera.id, true);
    await service.start(primera.id, 60);

    const segunda = await service.createDraft({ ...LA_DOBLE_RADICACION, title: "Otro frente" });
    await service.accept(segunda.id, true);
    await expect(service.start(segunda.id, 60)).rejects.toThrow(/Battle comprometida/);

    const dm = await service.dungeonMasterState();
    expect(dm.activeBattle?.questId).toBe(primera.id);
  });

  it("un reintento del Dungeon Master no duplica la Battle ni el aviso", async () => {
    const draft = await service.createDraft(LA_DOBLE_RADICACION);
    await service.accept(draft.id, true);
    await service.start(draft.id, 60);
    // El DM reintenta porque no vio confirmación: sellar e iniciar otra vez.
    await service.accept(draft.id, true).catch(() => undefined);
    await service.start(draft.id, 60).catch(() => undefined);

    const avisos = await request(app).get("/v1/notifications").expect(200);
    const suyos = avisos.body.data.notifications.filter(
      (aviso: { type: string; entityId: string }) => aviso.type === "battle_started" && aviso.entityId === draft.id,
    );
    expect(suyos).toHaveLength(1);

    const dm = await service.dungeonMasterState();
    expect(dm.openFronts.filter((front) => front.questId === draft.id)).toHaveLength(1);
  });

  it("el reino que lee el Dungeon Master cabe en una respuesta, no en un volcado", async () => {
    const draft = await service.createDraft(LA_DOBLE_RADICACION);
    await service.accept(draft.id, true);
    await service.start(draft.id, 60);

    const completo = JSON.stringify(await service.snapshot()).length;
    const paraElDm = JSON.stringify(await service.dungeonMasterState()).length;
    // Devolvía el snapshot entero —426 KB en el reino real— y el modelo lo
    // recibía truncado o no lo recibía.
    expect(paraElDm).toBeLessThan(completo / 4);
    expect(paraElDm).toBeLessThan(8000);
  });

  it("sin ningún frente con reloj, el Dungeon Master lo dice claro", async () => {
    const dm = await service.dungeonMasterState();
    expect(dm.activeBattle).toBeNull();
  });
});
