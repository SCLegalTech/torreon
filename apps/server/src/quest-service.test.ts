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
    // Dos ataques por evidencia validada, más el battle_started que abre el reloj.
    expect(snapshot.realm.gameEvents.filter((event) => event.type === "quest_attack")).toHaveLength(2);
    expect(snapshot.realm.gameEvents.filter((event) => event.type === "battle_started")).toHaveLength(1);
    const gameEvent = snapshot.realm.gameEvents[0];
    expect(snapshot.realm.lifeEvents.some((event) => event.id === gameEvent.sourceLifeEventId)).toBe(true);
  });

  it("concede XP y Aura una sola vez, y nunca inventa Tesoro", async () => {
    const draft = await service.createDraft(demoQuest);
    await service.accept(draft.id, true);
    const active = await service.start(draft.id);

    const before = await service.snapshot();
    expect(before.stats.xp).toBe(0);
    expect(before.stats.aura).toBe(0);

    for (const step of active.steps) {
      await service.completeStep(active.id, step.id, `Evidencia de ${step.title}`);
    }

    const won = await service.snapshot();
    expect(won.currentQuest?.status).toBe("completed");
    // 60 minutos pactados y dos cuidados declarados en el contrato.
    expect(won.stats.xp).toBe(30);
    expect(won.stats.aura).toBe(3);
    expect(won.stats.treasure.amount).toBe(before.stats.treasure.amount);
    expect(won.realm.events.filter((event) => event.type === "reward_granted")).toHaveLength(1);

    // Recargar el reino no puede volver a pagar la misma victoria.
    const reloaded = await service.snapshot();
    expect(reloaded.stats.xp).toBe(30);
    expect(reloaded.stats.aura).toBe(3);
    expect(reloaded.realm.character.rewardedQuestIds).toEqual([active.id]);
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

  it("convierte una foto móvil en Artifact, evidencia e impacto", async () => {
    const draft = await service.createDraft({
      campaignTitle: "La Cámara del Testigo",
      title: "La Prueba de Luz",
      intent: "Fotografiar el estado real de un espacio.",
      outcome: "Existe una fotografía verificable del espacio.",
      rationale: "La cámara prueba un hecho físico.",
      durationMinutes: 10,
      wellbeingConstraints: [],
      allowedApps: ["Cámara"],
      steps: [{
        title: "Capturar el recinto",
        actor: "user",
        evidence: "Foto actual del espacio",
        evidenceKind: "photo",
        verificationHint: "La imagen muestra el espacio actual.",
        weight: 100,
      }],
    });
    await service.accept(draft.id, true);
    const active = await service.start(draft.id);
    const step = active.steps[0];
    const photo = Buffer.from("evidencia-fotografica-real");
    const artifact = await service.attachArtifact(active.id, step.id, {
      kind: "file",
      dataBase64: photo.toString("base64"),
      filename: "camara.jpg",
      mimeType: "image/jpeg",
    });

    expect(artifact.verification.verified).toBe(true);
    const result = await service.verifyStep(active.id, step.id, { artifactIds: [artifact.id], note: "Foto tomada desde Torreon." });
    expect(result.judgement.verdict).toBe("accepted");
    expect(result.battle.progress).toBe(100);
    expect(result.artifacts[0].id).toBe(artifact.id);
    expect((await service.snapshot()).realm.evidence[0].artifactIds).toContain(artifact.id);
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

  it("adapta una quest activa sin borrar los 52 puntos ni la historia", async () => {
    const draft = await service.createDraft({
      campaignTitle: "SECOP",
      title: "La Ofrenda de las Siete Pruebas",
      intent: "Cargar evidencias mensuales.",
      outcome: "Evidencias disponibles cargadas y meses futuros preparados.",
      rationale: "El contrato inicial era una hipótesis del flujo.",
      durationMinutes: 60,
      wellbeingConstraints: [],
      allowedApps: ["SECOP"],
      steps: [
        { title: "Reunir", actor: "user", evidence: "Archivos", evidenceKind: "declaration", weight: 9 },
        { title: "Ingresar", actor: "user", evidence: "Módulo", evidenceKind: "declaration", weight: 13 },
        { title: "Anexar", actor: "user", evidence: "Carga", evidenceKind: "declaration", weight: 35 },
        { title: "Enviar", actor: "user", evidence: "Publicación", evidenceKind: "declaration", weight: 43 },
      ],
    });
    await service.accept(draft.id, true);
    const active = await service.start(draft.id);
    await service.submitEvidence(active.id, active.steps[0].id, { summary: "Archivos reunidos", source: "api", verdict: "accepted", reasoning: "Comprobado", impactAwarded: 9 });
    await service.submitEvidence(active.id, active.steps[1].id, { summary: "Módulo abierto", source: "api", verdict: "accepted", reasoning: "Comprobado", impactAwarded: 13 });
    await service.submitEvidence(active.id, active.steps[2].id, { summary: "Meses disponibles cargados", source: "api", verdict: "partial", reasoning: "Julio y agosto esperan firma", impactAwarded: 30 });
    const before = await service.snapshot();
    expect(before.battle?.progress).toBe(52);
    const historicalEvents = before.realm.gameEvents.map((event) => event.id);

    const amendment = await service.proposeAmendment(active.id, {
      proposedBy: "codice",
      reason: "SECOP demostró que anexar ya deja publicado el archivo y la firma restante depende del supervisor.",
      changes: [
        { type: "SUPERSEDE_STEP", stepId: active.steps[3].id, reason: "No existe un envío independiente después de anexar." },
        { type: "MODIFY_STEP", stepId: active.steps[2].id, patch: { title: "Recuperar y cargar julio/agosto", weight: 78 } },
        { type: "MARK_EXTERNAL_BLOCKER", stepId: active.steps[2].id, blockedBy: "Supervisor del contrato", blockedReason: "Falta firma en CISEC", playerActionAvailable: false },
      ],
    });
    expect((await service.snapshot()).battle?.progress).toBe(52);
    const accepted = await service.acceptAmendment(active.id, amendment.id, true);
    expect(accepted.quest.version).toBe(2);
    expect(accepted.quest.status).toBe("waiting_external");
    expect(accepted.battle.progress).toBe(52);
    expect(accepted.quest.steps[3].status).toBe("superseded");
    expect(accepted.quest.steps[2].status).toBe("blocked");
    const after = await service.snapshot();
    expect(after.currentStep).toBeNull();
    expect(historicalEvents.every((id) => after.realm.gameEvents.some((event) => event.id === id))).toBe(true);
    await expect(service.recordUnexpectedRequirement(active.id, { reason: "El supervisor todavía no firma los informes.", damage: 7 })).rejects.toThrow("espera externa");
  });

  it("reutiliza un Artifact en dos pasos con veredictos independientes", async () => {
    const draft = await service.createDraft(demoQuest);
    await service.accept(draft.id, true);
    const active = await service.start(draft.id);
    const artifact = await service.attachArtifact(active.id, active.steps[0].id, { kind: "text", text: "Una prueba observable reutilizable", label: "captura-A" });
    await service.verifyStep(active.id, active.steps[0].id, { artifactIds: [artifact.id], note: "Demuestra los criterios." });
    await service.reuseArtifact(active.id, artifact.id, active.steps[1].id);
    await service.verifyStep(active.id, active.steps[1].id, { artifactIds: [artifact.id], note: "La misma captura demuestra las puertas." });
    const snapshot = await service.snapshot();
    expect(snapshot.realm.artifacts).toHaveLength(1);
    expect(snapshot.realm.artifacts[0].stepIds).toEqual(expect.arrayContaining([active.steps[0].id, active.steps[1].id]));
    expect(snapshot.realm.evidence.filter((record) => record.artifactIds.includes(artifact.id))).toHaveLength(2);
  });

  it("deriva HP bilateral y sólo deja contraatacar por una complicación real explícita", async () => {
    const draft = await service.createDraft(demoQuest);
    await service.accept(draft.id, true);
    const active = await service.start(draft.id);
    const attack = await service.recordUnexpectedRequirement(active.id, {
      stepId: active.steps[0].id,
      reason: "La entidad exigió un certificado adicional no contemplado.",
      damage: 7,
    });
    // ROKO PROTEGE: el golpe cae sobre él y su escudo lo absorbe entero.
    expect(attack.battle.party.roko.shield).toBe(13);
    expect(attack.battle.party.roko.health).toBe(100);
    expect(attack.battle.playerHealth).toBe(100);
    expect(attack.battle.enemyHealth).toBe(100);
    const snapshot = await service.snapshot();
    expect(snapshot.realm.lifeEvents[0].type).toBe("unexpected_requirement");
    expect(snapshot.realm.gameEvents.some((event) => event.type === "shield_absorbed")).toBe(true);
    expect(snapshot.battle?.party.marques.health).toBe(100);
  });
});
