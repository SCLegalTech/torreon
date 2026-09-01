import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { demoQuest, QuestService } from "./quest-service.js";
import { JsonRealmStore } from "./store.js";

describe("QuestService", () => {
  let directory: string;
  let service: QuestService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "torreon-"));
    const store = new JsonRealmStore(join(directory, "state.json"));
    await store.init();
    service = new QuestService(store);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("requiere aceptación y convierte cada paso en daño real", async () => {
    const draft = await service.createDraft(demoQuest);
    await expect(service.start(draft.id)).rejects.toThrow("aceptada");
    await expect(service.accept(draft.id, false)).rejects.toThrow("explícita");

    await service.accept(draft.id, true);
    const active = await service.start(draft.id);
    expect(active.status).toBe("active");

    let enemyHealth = 100;
    for (const step of active.steps) {
      const result = await service.completeStep(active.id, step.id, `Evidencia de ${step.title}`);
      enemyHealth -= step.weight;
      expect(result.battle.enemyHealth).toBe(enemyHealth);
    }

    const snapshot = await service.snapshot();
    expect(snapshot.currentQuest?.status).toBe("completed");
    expect(snapshot.battle?.isKo).toBe(true);
    expect(snapshot.battle?.progress).toBe(100);
  });

  it("rechaza planes cuyos pesos no suman cien", async () => {
    const invalid = { ...demoQuest, steps: demoQuest.steps.map((step) => ({ ...step, weight: 1 })) };
    await expect(service.createDraft(invalid)).rejects.toThrow("sumar 100");
  });
});

