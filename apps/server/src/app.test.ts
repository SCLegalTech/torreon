import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpApp } from "./app.js";
import { QuestService } from "./quest-service.js";
import { JsonRealmStore } from "./store.js";

describe("HTTP app", () => {
  let directory: string;
  let app: ReturnType<typeof createHttpApp>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "torreon-http-"));
    const store = new JsonRealmStore(join(directory, "state.json"));
    await store.init();
    app = createHttpApp(new QuestService(store));
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
});
