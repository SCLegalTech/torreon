import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { distributeWeights } from "./codice.js";
import { demoQuest, enforceArtifactRule, QuestService } from "./quest-service.js";
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

  it("convierte un documento entregado al MCP en un ataque de la batalla", async () => {
    const draft = await service.createDraft(demoQuest);
    await service.accept(draft.id, true);
    const active = await service.start(draft.id);
    const step = active.steps[0];

    const documentPath = join(directory, "hoja-de-vida.md");
    await writeFile(documentPath, "# Hoja de vida — Marqués Phi, perfil y fortalezas.", "utf8");

    const artifact = await service.attachArtifact(active.id, step.id, { kind: "file", path: documentPath });
    expect(artifact.verification.verified).toBe(true);
    expect(artifact.sha256).toHaveLength(64);
    expect(artifact.excerpt).toContain("Hoja de vida");

    // El artefacto por sí solo todavía no causa daño.
    const beforeVerdict = await service.snapshot();
    expect(beforeVerdict.battle?.progress).toBe(0);

    const verdict = await service.verifyStep(active.id, step.id, { note: "Adjunté mi hoja de vida base." });
    expect(verdict.judgement.verdict).toBe("accepted");
    expect(verdict.battle.progress).toBe(step.weight);
    expect(verdict.gameEventId).not.toBeNull();

    const snapshot = await service.snapshot();
    expect(snapshot.realm.evidence[0].artifactIds).toContain(artifact.id);
    expect(snapshot.realm.artifacts[0].id).toBe(artifact.id);
    expect(snapshot.realm.gameEvents[0].damage).toBe(step.weight);
  });

  it("guarda en el reino una captura entregada desde el juego", async () => {
    const draft = await service.createDraft(demoQuest);
    await service.accept(draft.id, true);
    const active = await service.start(draft.id);
    const step = active.steps[0];

    // Un PNG mínimo válido, como el que llega al pegar una captura.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const artifact = await service.attachArtifact(active.id, step.id, {
      kind: "file",
      dataBase64: png.toString("base64"),
      filename: "captura.png",
      mimeType: "image/png",
    });

    expect(artifact.verification.verified).toBe(true);
    expect(artifact.mimeType).toBe("image/png");
    expect(artifact.bytes).toBe(png.length);
    expect(artifact.storedPath).toBeTruthy();
  });

  it("no concede impacto completo a una declaracion sin artefacto", async () => {
    const draft = await service.createDraft(demoQuest);
    await service.accept(draft.id, true);
    const active = await service.start(draft.id);
    const step = active.steps[0];

    const verdict = await service.verifyStep(active.id, step.id, { note: "Ya definí mis criterios de búsqueda." });
    expect(verdict.judgement.verdict).toBe("partial");
    expect(verdict.battle.progress).toBeLessThan(step.weight);
    expect(verdict.quest.steps[0].status).toBe("in_progress");
  });

  it("ningun juez puede cerrar con una declaracion un paso que pacto una prueba", () => {
    const step = {
      id: "s1",
      title: "Cargar en la plataforma",
      actor: "user" as const,
      evidence: "Captura de pantalla de la carga",
      evidenceKind: "screenshot" as const,
      weight: 20,
      status: "pending" as const,
      impactAwarded: 0,
      evidenceIds: [],
      artifactIds: [],
    };
    const generoso = { verdict: "accepted" as const, impactAwarded: 20, reasoning: "El jugador afirma haberlo hecho." };

    const sinPrueba = enforceArtifactRule(generoso, step, [], 20);
    expect(sinPrueba.verdict).toBe("partial");
    expect(sinPrueba.impactAwarded).toBeLessThan(20);
    expect(sinPrueba.reasoning).toContain("una prueba");

    const comprobado = [
      {
        id: "a1",
        questId: "q",
        stepId: "s1",
        kind: "file" as const,
        label: "captura.png",
        verification: { verified: true, detail: "ok", checkedAt: "now" },
        createdAt: "now",
      },
    ];
    expect(enforceArtifactRule(generoso, step, comprobado, 20).verdict).toBe("accepted");

    // Un paso que solo pactó una declaración sí puede cerrarse con palabras.
    const soloTexto = { ...step, evidenceKind: "declaration" as const };
    expect(enforceArtifactRule(generoso, soloTexto, [], 20).verdict).toBe("accepted");
  });

  it("reparte cualquier importancia relativa en exactamente cien puntos de dano", () => {
    for (const importances of [[3, 3, 3], [1, 2, 3, 4, 5, 6, 7, 8], [10, 1], [7]]) {
      const weights = distributeWeights(importances);
      expect(weights).toHaveLength(importances.length);
      expect(weights.reduce((sum, value) => sum + value, 0)).toBe(100);
      expect(Math.min(...weights)).toBeGreaterThanOrEqual(1);
    }
  });
});
