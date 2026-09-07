import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpApp } from "./app.js";
import { demoQuest, QuestService } from "./quest-service.js";
import { JsonRealmStore } from "./store.js";
import { fixedClock } from "./clock.js";

/**
 * EL RELOJ DEL REINO SE PLANTA (artículo 8, ADR-0006). Sin esto, la presión y
 * las ventanas críticas dependían del tiempo real que tardara la suite, y la
 * misma prueba pasaba aislada y fallaba bajo carga.
 */
const RELOJ_DEL_REINO = "2026-05-11T09:00:00.000Z";

describe("HTTP app", () => {
  let directory: string;
  let app: ReturnType<typeof createHttpApp>;
  let service: QuestService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "torreon-http-"));
    const store = new JsonRealmStore(join(directory, "state.json"), fixedClock(RELOJ_DEL_REINO));
    await store.init();
    service = new QuestService(store, undefined, directory, "torreon-test-authoritative", fixedClock(RELOJ_DEL_REINO));
    app = createHttpApp(service);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("crea y recorre la quest demostrativa", async () => {
    const created = await request(app).post("/api/demo/quest").expect(201);
    const quest = created.body.quest;
    expect(quest.status).toBe("draft");

    await request(app).post(`/api/quests/${quest.id}/accept`).send({ userAccepted: true }).expect(200);
    await request(app).post(`/api/quests/${quest.id}/start`).expect(200);

    const first = quest.steps[0];
    const impact = await request(app)
      .post(`/api/quests/${quest.id}/steps/${first.id}/complete`)
      .send({ evidenceNote: "Criterios registrados" })
      .expect(200);
    expect(impact.body.battle.enemyHealth).toBe(90);
  });

  it("gamifica una quest de hojas de vida con pasos específicos", async () => {
    const created = await request(app)
      .post("/api/quests/from-intent")
      .send({ intent: "necesito enviar cinco hojas de vida" })
      .expect(201);

    const quest = created.body.quest;
    expect(quest.title).toBe("Las Cinco Cartas de la Marca");
    expect(quest.outcome).toContain("Enviar 5 candidaturas");
    expect(quest.steps).toHaveLength(6);
    expect(quest.steps.reduce((sum: number, step: { weight: number }) => sum + step.weight, 0)).toBe(100);
    expect(quest.steps.map((step: { title: string }) => step.title)).toContain("Enviar las cinco cartas");
    expect(quest.steps[0].description).toContain("Épica");
    expect(quest.steps[0].description).toContain("Real");
  });

  it("expone salud y rechaza MCP por GET", async () => {
    await request(app).get("/health").expect(200).expect(({ body }) => expect(body.server).toBe("torreon"));
    await request(app).get("/mcp").expect(405);
  });

  it("comparte una sola quest entre el adaptador externo y la App API", async () => {
    const externalDraft = await service.createDraft({
      campaignTitle: "La Marca unificada",
      title: "El Pacto de las Dos Voces",
      intent: "Probar que ChatGPT y la app ven el mismo reino.",
      outcome: "La misma quest aparece en ambas superficies.",
      rationale: "Ambos adaptadores reutilizan QuestService.",
      durationMinutes: 15,
      wellbeingConstraints: [],
      allowedApps: [],
      steps: [{ title: "Cruzar el puente", actor: "shared", evidence: "Realm ID idéntico", evidenceKind: "text", weight: 100 }],
    });

    const appRead = await request(app).get("/api/state").expect(200);
    expect(appRead.body.currentQuest.id).toBe(externalDraft.id);
    expect(appRead.body.consistency.instance).toBe("torreon-test-authoritative");

    await request(app).post(`/api/quests/${externalDraft.id}/accept`).send({ userAccepted: true }).expect(200);
    const externalRead = await service.snapshot();
    expect(externalRead.currentQuest?.status).toBe("accepted");
    expect(externalRead.consistency.realmId).toBe(appRead.body.consistency.realmId);
  });

  it("adapta por HTTP una quest activa sólo tras aceptación y conserva el progreso", async () => {
    const draft = await service.createDraft({
      campaignTitle: "El pliego cambiante",
      title: "La licitación de la Marca",
      intent: "Presentar una propuesta sujeta a requisitos externos.",
      outcome: "Entregar una propuesta válida.",
      rationale: "La realidad puede cambiar después de iniciar.",
      durationMinutes: 30,
      wellbeingConstraints: [],
      allowedApps: [],
      steps: [
        { title: "Leer el pliego", actor: "user", evidence: "Notas verificadas", weight: 20 },
        { title: "Entregar la propuesta", actor: "user", evidence: "Constancia de entrega", weight: 80 },
      ],
    });
    await service.accept(draft.id, true);
    await service.start(draft.id);
    await service.completeStep(draft.id, draft.steps[0].id, "Pliego revisado");

    const proposal = await request(app)
      .post(`/api/quests/${draft.id}/amendments`)
      .send({
        reason: "La entidad publicó una adenda que exige esperar una respuesta externa.",
        proposedBy: "codice",
        changes: [
          {
            type: "MARK_EXTERNAL_BLOCKER",
            stepId: draft.steps[1].id,
            blockedBy: "Entidad contratante",
            blockedReason: "Debe publicar el anexo antes de poder continuar.",
            playerActionAvailable: false,
          },
        ],
      })
      .expect(201);

    expect((await service.snapshot()).currentQuest?.status).toBe("active");
    const accepted = await request(app)
      .post(`/api/quests/${draft.id}/amendments/${proposal.body.amendment.id}/accept`)
      .send({ userAccepted: true })
      .expect(200);
    expect(accepted.body.quest.status).toBe("waiting_external");
    expect(accepted.body.battle.progress).toBe(20);
    expect(accepted.body.battle.enemyHealth).toBe(80);
  });
});

/**
 * EL BORDE TRADUCE, NO DECIDE (artículo 7).
 *
 * Antes todo fallo salía como `400`. Unity no puede reaccionar bien a eso: no
 * es lo mismo «esa Quest ya no existe, vuelve atrás» que «hay un frente con
 * reloj corriendo, muéstraselo al jugador» que «esto es un fallo nuestro».
 */
describe("Cuando el reino dice que no", () => {
  let directory: string;
  let app: ReturnType<typeof createHttpApp>;
  let service: QuestService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "torreon-errores-"));
    const store = new JsonRealmStore(join(directory, "state.json"), fixedClock(RELOJ_DEL_REINO));
    await store.init();
    service = new QuestService(store, undefined, directory, "torreon-errores-test", fixedClock(RELOJ_DEL_REINO));
    app = createHttpApp(service);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /**
   * UN PROPÓSITO NUEVO ES UNA QUEST NUEVA.
   *
   * Esta ruta devolvía la quest viva que hubiera —fuera cual fuera— en vez de
   * trazar la pedida. Con un frente abierto de otra campaña, pedir «pagar la
   * seguridad social de agosto» contestaba con la quest del Coloso: el pacto
   * pedido no llegaba a existir, no aparecía en Batallas, no generaba aviso, y
   * el Dungeon Master no podía confirmar nada porque no había nada.
   */
  it("con un frente ya abierto, un propósito nuevo sigue trazando su propio pacto", async () => {
    const viejo = await service.createDraft(demoQuest);
    await service.accept(viejo.id, true);
    await service.start(viejo.id);

    const response = await request(app)
      .post("/api/quests/from-intent")
      .send({ intent: "Pagar la seguridad social de agosto y guardar el comprobante" })
      .expect(201);

    expect(response.body.reused).toBe(false);
    expect(response.body.quest.id).not.toBe(viejo.id);
    expect(response.body.quest.status).toBe("draft");

    // Y el pacto nuevo se puede sellar y arrancar en cuanto el frente se libere.
    const snapshot = await service.snapshot();
    expect(snapshot.realm.quests.map((quest) => quest.id)).toContain(response.body.quest.id);
  });

  it("la quest demostrativa sí se reutiliza: es una sola y no llena el reino", async () => {
    const primera = await request(app).post("/api/demo/quest").expect(201);
    const segunda = await request(app).post("/api/demo/quest").expect(200);
    expect(segunda.body.reused).toBe(true);
    expect(segunda.body.quest.id).toBe(primera.body.quest.id);
  });

  it("lo que no existe se dice con 404, no con «petición mal formada»", async () => {
    const response = await request(app).get("/api/quests/no-existe-esta-quest").expect(404);
    expect(response.body.kind).toBe("not_found");
    expect(response.body.error).toMatch(/no encontrada/i);
  });

  it("una regla del reino se dice con 409 y con el motivo escrito para el jugador", async () => {
    const draft = await service.createDraft(demoQuest);
    const response = await request(app)
      .post(`/api/quests/${draft.id}/accept`)
      .send({ userAccepted: false })
      .expect(409);
    expect(response.body.kind).toBe("conflict");
    // El mensaje viaja tal cual: el renderer lo muestra, no lo reescribe.
    expect(response.body.error).toMatch(/aceptación explícita/i);
  });

  it("una petición sin forma se rechaza en el borde, diciendo qué campo", async () => {
    const draft = await service.createDraft(demoQuest);
    const response = await request(app)
      .post(`/api/quests/${draft.id}/steps/${draft.steps[0].id}/evidence`)
      .send({ summary: "Hice la tarea", verdict: "milagro", reasoning: "confía en mí", impactAwarded: 40 })
      .expect(422);
    expect(response.body.kind).toBe("invalid");
    expect(response.body.error).toMatch(/verdict/);
  });

  it("el borde comprueba la forma; la regla sigue siendo del Núcleo", async () => {
    const draft = await service.createDraft(demoQuest);
    // Forma correcta, momento equivocado: esto NO lo decide el borde.
    const response = await request(app)
      .post(`/api/quests/${draft.id}/steps/${draft.steps[0].id}/evidence`)
      .send({ summary: "Hice la tarea", verdict: "accepted", reasoning: "sin iniciar la quest", impactAwarded: 40 })
      .expect(409);
    expect(response.body.kind).toBe("conflict");
  });

  it("un frente ya comprometido no es basura del cliente: es el estado del reino", async () => {
    const primera = await service.createDraft(demoQuest);
    await service.accept(primera.id, true);
    await service.start(primera.id);

    const segunda = await service.createDraft({ ...demoQuest, title: "Otro frente" });
    await service.accept(segunda.id, true);
    const response = await request(app).post(`/api/quests/${segunda.id}/start`).expect(409);
    expect(response.body.kind).toBe("conflict");
    expect(response.body.error).toMatch(/Battle comprometida/);
  });
});
