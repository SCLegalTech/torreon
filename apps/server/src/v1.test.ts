import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpApp } from "./app.js";
import { fixedClock } from "./clock.js";
import { demoQuest, QuestService } from "./quest-service.js";
import { JsonRealmStore } from "./store.js";

const RELOJ_DEL_REINO = "2026-05-11T09:00:00.000Z";

/**
 * EL CONTRATO QUE CONSUMIRÁ UNITY (03-CONTRATO-DE-CLIENTE.md).
 *
 * Lo que estas pruebas defienden no es «que responda»: es que el contrato tenga
 * las propiedades por las que existe. Cada pantalla pide lo suyo, el estado
 * persistido NO viaja, el sobre es estable, y el cursor ata la foto al
 * expediente para que una suscripción no se pierda nada.
 */
describe("El contrato /v1", () => {
  let directory: string;
  let app: ReturnType<typeof createHttpApp>;
  let service: QuestService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "torreon-v1-"));
    const store = new JsonRealmStore(join(directory, "state.json"), fixedClock(RELOJ_DEL_REINO));
    await store.init();
    service = new QuestService(store, undefined, directory, "torreon-v1-test", fixedClock(RELOJ_DEL_REINO));
    app = createHttpApp(service);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("toda vista viaja en el mismo sobre, con la versión y el reloj del servidor", async () => {
    const response = await request(app).get("/v1/realm/summary").expect(200);
    expect(response.body.schemaVersion).toBe(1);
    expect(response.body.serverTime).toBe(RELOJ_DEL_REINO);
    expect(response.body).toHaveProperty("cursor");
    expect(response.body).toHaveProperty("data");
  });

  it("el bastión entrega lo suyo y NUNCA el estado persistido", async () => {
    await service.createDraft(demoQuest);
    const { body } = await request(app).get("/v1/realm/summary").expect(200);

    expect(body.data.stats.displayName).toBeTruthy();
    expect(body.data.treasury).toBeTruthy();
    expect(body.data.openFronts).toBeInstanceOf(Array);
    // Lo que ninguna pantalla necesita no viaja: ni el documento del reino, ni
    // los razonamientos del juez, ni las rutas de artefactos en disco.
    expect(body.data).not.toHaveProperty("realm");
    expect(body.data).not.toHaveProperty("evidence");
    expect(body.data).not.toHaveProperty("artifacts");
    expect(JSON.stringify(body)).not.toContain("gameEvents");
  });

  it("el frente entrega la Battle y su contrato, no el reino entero", async () => {
    const draft = await service.createDraft(demoQuest);
    await service.accept(draft.id, true);
    await service.start(draft.id);

    const { body } = await request(app).get(`/v1/battle/${draft.id}`).expect(200);
    expect(body.data.questId).toBe(draft.id);
    expect(body.data.battle.status).toBe("active");
    expect(body.data.progress.validatedImpact).toBe(0);
    expect(body.data.currentStep.title).toBe(draft.steps[0].title);
  });

  it("una Battle que no existe se dice con 404, no con un sobre vacío", async () => {
    const response = await request(app).get("/v1/battle/no-existe").expect(404);
    expect(response.body.kind).toBe("not_found");
  });

  it("un comando devuelve el resultado autoritativo dentro del mismo sobre", async () => {
    const draft = await service.createDraft(demoQuest);
    const { body } = await request(app)
      .post(`/v1/quests/${draft.id}/accept`)
      .send({ userAccepted: true })
      .expect(200);
    expect(body.schemaVersion).toBe(1);
    expect(body.data.status).toBe("accepted");
  });

  it("un comando sin forma se rechaza en el borde, igual que en /api", async () => {
    const draft = await service.createDraft(demoQuest);
    const response = await request(app).post(`/v1/quests/${draft.id}/accept`).send({ userAccepted: "claro" }).expect(422);
    expect(response.body.kind).toBe("invalid");
  });

  it("una regla del reino sigue siendo del Núcleo, y llega con su motivo", async () => {
    const draft = await service.createDraft(demoQuest);
    const response = await request(app).post(`/v1/quests/${draft.id}/accept`).send({ userAccepted: false }).expect(409);
    expect(response.body.error).toMatch(/aceptación explícita/i);
  });

  it("el cursor de una vista permite pedir sólo lo que pasó después", async () => {
    await service.createDraft(demoQuest);
    const primera = await request(app).get("/v1/realm/summary").expect(200);
    expect(primera.body.cursor).toBeTruthy();

    const otra = await service.createDraft({ ...demoQuest, title: "Otro pacto" });
    const segunda = await request(app).get("/v1/realm/summary").expect(200);
    expect(segunda.body.cursor).not.toBe(primera.body.cursor);
    expect(otra.id).toBeTruthy();
  });

  it("la vista de una pantalla pesa una fracción del estado completo", async () => {
    const draft = await service.createDraft(demoQuest);
    await service.accept(draft.id, true);
    await service.start(draft.id);

    const completo = JSON.stringify((await request(app).get("/api/state")).body).length;
    const porPantalla = JSON.stringify((await request(app).get("/v1/battle/" + draft.id)).body).length;
    expect(porPantalla).toBeLessThan(completo / 2);
  });
});
