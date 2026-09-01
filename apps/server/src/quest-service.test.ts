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

  it("convierte evidencia en LifeEvent y solo después en GameEvent", async () => {
    const draft = await service.createDraft(demoQuest);
    await service.accept(draft.id, true);
    const active = await service.start(draft.id);
    const step = active.steps[0];

    const rejected = await service.submitEvidence(active.id, step.id, {
      summary: "Solo describí lo que quisiera hacer.", source: "user_declaration", verdict: "rejected",
      reasoning: "Una intención no demuestra que los criterios estén registrados.", impactAwarded: 0,
    });
    expect(rejected.battle.progress).toBe(0);
    expect(rejected.gameEventId).toBeNull();

    const partial = await service.submitEvidence(active.id, step.id, {
      summary: "Definí salario y modalidad; falta horario.", source: "user_declaration", verdict: "partial",
      reasoning: "Dos de los tres criterios requeridos ya son concretos.", impactAwarded: 6,
    });
    expect(partial.battle.progress).toBe(6);
    expect(partial.gameEventId).not.toBeNull();

    const accepted = await service.submitEvidence(active.id, step.id, {
      summary: "Añadí el horario máximo aceptable.", source: "user_declaration", verdict: "accepted",
      reasoning: "Los tres criterios pactados están completos.", impactAwarded: 4,
    });
    expect(accepted.quest.steps[0].status).toBe("completed");
    expect(accepted.battle.progress).toBe(10);

    const snapshot = await service.snapshot();
    expect(snapshot.realm.evidence).toHaveLength(3);
    expect(snapshot.realm.lifeEvents).toHaveLength(3);
    expect(snapshot.realm.gameEvents).toHaveLength(2);
    const gameEvent = snapshot.realm.gameEvents[0];
    expect(snapshot.realm.lifeEvents.some((event) => event.id === gameEvent.sourceLifeEventId)).toBe(true);
  });

  it("acepta quests de dominios no financieros con el mismo contrato", async () => {
    const householdQuest = {
      campaignTitle: "Hogar en orden",
      title: "La cámara despejada",
      intent: "Quiero ordenar mi estudio.",
      outcome: "El escritorio queda despejado y los documentos clasificados.",
      rationale: "Define un final visible en vez de premiar solo tiempo de limpieza.",
      durationMinutes: 30,
      wellbeingConstraints: ["No desechar documentos sin revisarlos"],
      allowedApps: [],
      steps: [
        { title: "Despejar la mesa", actor: "user" as const, evidence: "Foto del escritorio despejado", weight: 60 },
        { title: "Clasificar documentos", actor: "user" as const, evidence: "Tres grupos etiquetados", weight: 40 },
      ],
    };
    const quest = await service.createDraft(householdQuest);
    expect(quest.intent).toContain("estudio");
    expect(quest.steps.reduce((sum, step) => sum + step.weight, 0)).toBe(100);
  });
});
