import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QuestPlanInput } from "./domain.js";
import { QuestService } from "./quest-service.js";
import { JsonRealmStore } from "./store.js";

/**
 * THE LIVING PARTY.
 *
 * POSITION IS NOT AUTHORIZATION.
 * FOCUS IS NOT ENGAGEMENT.
 * TREASURY IS NOT A QUICK BATTLE.
 * AN AGENT IS A HERO ONLY WHEN IT ACTUALLY PARTICIPATES.
 * LEVEL IS NOT PERMISSION.
 * RETRIES MUST NOT CREATE FAKE HISTORY.
 */

const twoSteps: QuestPlanInput = {
  campaignTitle: "",
  title: "El Llamado de prueba",
  intent: "Probar que la partida recuerda lo que hizo.",
  outcome: "El frente queda cerrado con evidencia comprobable.",
  rationale: "Sólo la evidencia validada causa daño.",
  durationMinutes: 25,
  wellbeingConstraints: [],
  allowedApps: [],
  steps: [
    { title: "Recuperar el hilo", actor: "shared", evidence: "Constancia", evidenceKind: "declaration", weight: 40 },
    { title: "Enviar la solicitud", actor: "user", evidence: "Constancia", evidenceKind: "declaration", weight: 60 },
  ],
};

function planNamed(title: string, minutes = 25): QuestPlanInput {
  return { ...twoSteps, title, durationMinutes: minutes, steps: twoSteps.steps.map((step) => ({ ...step })) };
}

describe("La partida viva", () => {
  let directory: string;
  let store: JsonRealmStore;
  let service: QuestService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "torreon-living-"));
    store = new JsonRealmStore(join(directory, "state.json"));
    await store.init();
    service = new QuestService(store, undefined, directory, "torreon-living-test");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /** Lleva una quest de cero a victoria con evidencia declarada. */
  async function winQuest(plan: QuestPlanInput): Promise<string> {
    const quest = await service.createDraft(plan);
    await service.accept(quest.id, true);
    await service.start(quest.id);
    for (const step of quest.steps) {
      await service.submitEvidence(quest.id, step.id, {
        summary: `Se cumplió ${step.title}.`,
        source: "user_declaration",
        verdict: "accepted",
        reasoning: "El resultado quedó comprobado.",
        impactAwarded: step.weight,
      });
    }
    return quest.id;
  }

  // -------------------------------------------------------------------------
  // UX
  // -------------------------------------------------------------------------

  it("UX-002: Tesorería y Barracas son hermanas de Batallas Libres, no hijas suyas", async () => {
    const snapshot = await service.snapshot();
    const ids = snapshot.worldSystems.map((system) => system.id);
    expect(ids).toContain("quick_battles");
    expect(ids).toContain("treasury");
    expect(ids).toContain("barracks");
    // Hermanas: viven en el MISMO nivel de la navegación del mundo.
    const treasury = snapshot.worldSystems.find((system) => system.id === "treasury")!;
    const quick = snapshot.worldSystems.find((system) => system.id === "quick_battles")!;
    expect(treasury.screen).toBe("treasury");
    expect(quick.screen).not.toBe("treasury");
  });

  it("UX-003: una Quest con locked=false nunca espera turno por su posición", async () => {
    const campaign = await service.createCampaignDraft({ title: "La Forja del Frente" });
    await service.acceptCampaign(campaign.campaign.id, true);
    const act = await service.createAct({ title: "El Acto Único", campaignId: campaign.campaign.id });

    const first = await service.createDraft(planNamed("Primera puerta"), { actId: act.id });
    const second = await service.createDraft(planNamed("El Llamado a la Fiscal"), { actId: act.id });
    const third = await service.createDraft(planNamed("Tercera puerta"), { actId: act.id });

    const snapshot = await service.snapshot();
    const nodes = snapshot.hierarchy.campaigns.flatMap((view) => view.acts.flatMap((view2) => view2.quests));
    for (const questId of [first.id, second.id, third.id]) {
      const node = nodes.find((candidate) => candidate.id === questId)!;
      expect(node.locked).toBe(false);
      expect(node.lockedBy).toBeUndefined();
    }

    // Y el Core deja actuar sobre la segunda sin tocar la primera.
    await service.accept(second.id, true);
    await service.start(second.id);
    expect((await service.snapshot()).hierarchy.engagedQuestId).toBe(second.id);
  });

  it("UX-003b: una dependencia DECLARADA sí bloquea, y dice quién la bloquea", async () => {
    const blocker = await service.createDraft(planNamed("La puerta previa"));
    const dependent = await service.createDraft(planNamed("La puerta siguiente"));
    await store.mutate((state) => {
      state.quests.find((quest) => quest.id === dependent.id)!.dependsOnQuestIds = [blocker.id];
    });

    const node = (await service.snapshot()).hierarchy.standaloneQuests.find((candidate) => candidate.id === dependent.id)!;
    expect(node.locked).toBe(true);
    expect(node.lockedBy).toContain("La puerta previa");
  });

  it("UX-004: la Battle proyectada es la COMPROMETIDA, no la del currentQuest legado", async () => {
    const engaged = await service.createDraft(planNamed("Frente A"));
    await service.accept(engaged.id, true);
    await service.start(engaged.id);
    // Un borrador posterior no puede robarle la proyección al frente con reloj.
    const later = await service.createDraft(planNamed("Borrador C"));
    await service.focusQuest(later.id);

    const snapshot = await service.snapshot();
    expect(snapshot.hierarchy.engagedQuestId).toBe(engaged.id);
    expect(snapshot.focusedQuest?.id).toBe(later.id);
    expect(snapshot.battle?.questId).toBe(engaged.id);
    expect(snapshot.currentQuest?.id).toBe(engaged.id);
  });

  it("UX-005: Quest completada ⇒ TODAS las proyecciones dicen ganada, sin presión", async () => {
    const questId = await winQuest(planNamed("Frente cerrado"));
    const snapshot = await service.snapshot();

    expect(snapshot.currentQuest?.status).toBe("completed");
    expect(snapshot.battle?.status).toBe("won");
    expect(snapshot.realm.quests.find((quest) => quest.id === questId)!.battle!.status).toBe("won");
    expect(snapshot.battle?.hordeNeutralized).toBe(true);
    expect(snapshot.battle?.enemyHealth).toBe(0);
    expect(snapshot.battle?.pressureRate).toBe(0);
    expect(snapshot.hierarchy.engagedQuestId).toBeNull();
    expect(snapshot.hierarchy.standaloneQuests.find((node) => node.id === questId)).toBeUndefined();
  });

  it("UX-005b: una espera externa no puede sobrevivir a la victoria", async () => {
    const quest = await service.createDraft(planNamed("Frente suspendido"));
    await service.accept(quest.id, true);
    await service.start(quest.id);
    // Se fuerza el estado incoherente que el bug real produjo.
    await store.mutate((state) => {
      const target = state.quests.find((candidate) => candidate.id === quest.id)!;
      target.status = "waiting_external";
      target.battle!.status = "suspended_external";
    });
    await store.mutate((state) => {
      state.quests.find((candidate) => candidate.id === quest.id)!.status = "active";
    });
    for (const step of quest.steps) {
      await service.submitEvidence(quest.id, step.id, {
        summary: `Se cumplió ${step.title}.`,
        source: "user_declaration",
        verdict: "accepted",
        reasoning: "Comprobado.",
        impactAwarded: step.weight,
      });
    }
    const snapshot = await service.snapshot();
    expect(snapshot.battle?.status).toBe("won");
    expect(snapshot.realm.quests.find((candidate) => candidate.id === quest.id)!.battle!.status).toBe("won");
  });

  // -------------------------------------------------------------------------
  // ROKU
  // -------------------------------------------------------------------------

  it("ROKU-001/002: se muestra «Roku», el id interno sigue siendo `roko` y la historia resuelve", async () => {
    const quest = await service.createDraft(planNamed("El nombre correcto"));
    await service.accept(quest.id, true);
    await service.start(quest.id);

    const snapshot = await service.snapshot();
    expect(snapshot.battle!.party.roko.name).toBe("Roku");
    expect(snapshot.battle!.party.roko.id).toBe("roko");
    expect(snapshot.barracks.heroes.find((hero) => hero.id === "roko")!.displayName).toBe("Roku");
    expect(JSON.stringify(snapshot.battle!.party)).not.toContain("Roko");
  });

  it("ROKU-002b: una formación persistida como «Roko» se corrige sin tocar sus heridas", async () => {
    const quest = await service.createDraft(planNamed("La cicatriz conservada"));
    await service.accept(quest.id, true);
    await service.start(quest.id);
    await store.mutate((state) => {
      const party = state.quests.find((candidate) => candidate.id === quest.id)!.battle!.party;
      party.roko.name = "Roko";
      party.roko.health = 31;
      party.roko.shield = 4;
    });

    const battle = (await service.snapshot()).battle!;
    expect(battle.party.roko.name).toBe("Roku");
    expect(battle.party.roko.health).toBe(31);
    expect(battle.party.roko.shield).toBe(4);
  });

  // -------------------------------------------------------------------------
  // ASISTENCIAS DE COMPAÑEROS
  // -------------------------------------------------------------------------

  it("AG-001: una ejecución real de Opus ocupa el cuarto slot pendiente de validación", async () => {
    const quest = await service.createDraft(planNamed("El Llamado a la Fiscal"));
    await service.accept(quest.id, true);
    await service.start(quest.id);

    await service.recordCompanionAssist({
      questId: quest.id,
      stepId: quest.steps[0].id,
      companion: "opus",
      sourceTool: "gmail_search_inbox",
      executionRef: "exec-1",
      contributionSummary: "Encontró el hilo histórico exacto con Fiscalía 43.",
    });

    const battle = (await service.snapshot()).battle!;
    expect(battle.agent.deployed).toBe(true);
    expect(battle.agent.companion).toBe("opus");
    expect(battle.agent.status).toBe("assist_ready");
    expect(battle.agent.comboDamage).toBe(0);
  });

  it("AG-002: la MISMA ejecución repetida no crea un segundo assist ni infla nada", async () => {
    const quest = await service.createDraft(planNamed("El reintento técnico"));
    await service.accept(quest.id, true);
    await service.start(quest.id);
    const input = {
      questId: quest.id,
      stepId: quest.steps[0].id,
      companion: "opus" as const,
      sourceTool: "gmail_search_inbox",
      executionRef: "exec-repetida",
      contributionSummary: "Recuperó el hilo histórico de Fiscalía 43.",
    };

    const first = await service.recordCompanionAssist(input);
    const second = await service.recordCompanionAssist(input);
    const third = await service.recordCompanionAssist(input);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(third.duplicate).toBe(true);
    expect(second.assist.id).toBe(first.assist.id);

    const state = await store.read();
    expect(state.companionAssists.filter((assist) => assist.questId === quest.id)).toHaveLength(1);
    expect(state.companionExecutions.filter((execution) => execution.questId === quest.id)).toHaveLength(1);
    // Y la carrera no se infla por un reintento de red.
    expect(state.heroes.opus.stats.executions).toBe(1);
  });

  it("AG-002b: sin executionRef, la misma herramienta sobre el mismo paso es el mismo hecho", async () => {
    const quest = await service.createDraft(planNamed("Sin referencia"));
    await service.accept(quest.id, true);
    await service.start(quest.id);
    const input = {
      questId: quest.id,
      stepId: quest.steps[0].id,
      companion: "opus" as const,
      sourceTool: "gmail_search_inbox",
      contributionSummary: "Buscó el hilo histórico.",
    };
    await service.recordCompanionAssist(input);
    const repeat = await service.recordCompanionAssist(input);
    expect(repeat.duplicate).toBe(true);
    expect((await store.read()).companionAssists).toHaveLength(1);
  });

  it("AG-003: evidencia aceptada concede EXACTAMENTE un combo y una validación", async () => {
    const quest = await service.createDraft(planNamed("Un solo combo"));
    await service.accept(quest.id, true);
    await service.start(quest.id);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await service.recordCompanionAssist({
        questId: quest.id,
        stepId: quest.steps[0].id,
        companion: "opus",
        sourceTool: "gmail_search_inbox",
        executionRef: "exec-unica",
        contributionSummary: "Recuperó el hilo histórico.",
      });
    }
    await service.submitEvidence(quest.id, quest.steps[0].id, {
      summary: "El correo salió y quedó en SENT.",
      source: "mcp",
      verdict: "accepted",
      reasoning: "Comprobado en la bandeja de enviados.",
      impactAwarded: 40,
    });

    const state = await store.read();
    const validated = state.companionAssists.filter((assist) => assist.status === "contribution_validated");
    expect(validated).toHaveLength(1);
    expect(state.heroes.opus.stats.validatedAssists).toBe(1);
    const combos = state.gameEvents.filter((event) => event.type === "companion_combo_attack");
    expect(combos).toHaveLength(1);
    // Techo del combo: el apoyo nunca vale más que la mitad del resultado real.
    expect(combos[0].damage).toBeLessThanOrEqual(20);
    expect(combos[0].damage).toBeGreaterThan(0);
  });

  it("AG-004: evidencia rechazada deja participación pero CERO combo", async () => {
    const quest = await service.createDraft(planNamed("Participó sin validar"));
    await service.accept(quest.id, true);
    await service.start(quest.id);
    await service.recordCompanionAssist({
      questId: quest.id,
      stepId: quest.steps[0].id,
      companion: "opus",
      sourceTool: "gmail_search_inbox",
      executionRef: "exec-rechazada",
      contributionSummary: "Buscó, pero el resultado no servía.",
    });
    await service.submitEvidence(quest.id, quest.steps[0].id, {
      summary: "No hay constancia de envío.",
      source: "mcp",
      verdict: "rejected",
      reasoning: "La prueba no cumple la condición pactada.",
      impactAwarded: 0,
    });

    const state = await store.read();
    expect(state.heroes.opus.stats.executions).toBe(1);
    expect(state.heroes.opus.stats.validatedAssists).toBe(0);
    expect(state.companionAssists[0].status).toBe("used_pending_validation");
    const battle = (await service.snapshot()).battle!;
    expect(battle.agent.deployed).toBe(true);
    expect(battle.agent.comboDamage).toBe(0);
  });

  it("AG-005: dos compañeros en el mismo paso ⇒ un slot primario, uno secundario, cada uno una vez", async () => {
    const quest = await service.createDraft(planNamed("Dos aliados"));
    await service.accept(quest.id, true);
    await service.start(quest.id);
    await service.recordCompanionAssist({
      questId: quest.id,
      stepId: quest.steps[0].id,
      companion: "opus",
      sourceTool: "gmail_search_inbox",
      executionRef: "exec-opus",
      contributionSummary: "Recuperó el hilo histórico.",
    });
    await service.recordCompanionAssist({
      questId: quest.id,
      stepId: quest.steps[0].id,
      companion: "codex",
      sourceTool: "run_tests",
      executionRef: "exec-codex",
      contributionSummary: "Verificó el adjunto generado.",
    });
    await service.submitEvidence(quest.id, quest.steps[0].id, {
      summary: "Correo enviado con el adjunto correcto.",
      source: "mcp",
      verdict: "accepted",
      reasoning: "Comprobado.",
      impactAwarded: 40,
    });

    const battle = (await service.snapshot()).battle!;
    expect(battle.agent.companion).toBe("opus");
    expect(battle.agent.secondaryAssists).toEqual(["codex"]);
    const state = await store.read();
    expect(state.heroes.opus.stats.validatedAssists).toBe(1);
    expect(state.heroes.codex.stats.validatedAssists).toBe(1);
    expect(state.gameEvents.filter((event) => event.type === "companion_combo_attack")).toHaveLength(1);
  });

  it("AG-006: la metadata de origen en la evidencia despliega y valida en UNA sola operación", async () => {
    const quest = await service.createDraft(planNamed("Sin doble llamada"));
    await service.accept(quest.id, true);
    await service.start(quest.id);

    await service.submitEvidence(quest.id, quest.steps[0].id, {
      summary: "Opus verificó el envío en SENT.",
      source: "mcp",
      verdict: "accepted",
      reasoning: "El mensaje aparece en enviados con el asunto exacto.",
      impactAwarded: 40,
      sourceProvider: "opus",
      sourceTool: "gmail_search_inbox",
      executionRef: "exec-coalescida",
    });

    const state = await store.read();
    expect(state.companionAssists).toHaveLength(1);
    expect(state.companionAssists[0].status).toBe("contribution_validated");
    expect(state.heroes.opus.stats.validatedAssists).toBe(1);
    const battle = (await service.snapshot()).battle!;
    expect(battle.agent.companion).toBe("opus");
    expect(battle.agent.comboDamage).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // PROGRESIÓN DE HÉROES
  // -------------------------------------------------------------------------

  it("H-001/H-002: un assist validado da XP una vez, y un reintento no da más", async () => {
    const quest = await service.createDraft(planNamed("XP honesta"));
    await service.accept(quest.id, true);
    await service.start(quest.id);
    const assist = {
      questId: quest.id,
      stepId: quest.steps[0].id,
      companion: "opus" as const,
      sourceTool: "gmail_search_inbox",
      executionRef: "exec-xp",
      contributionSummary: "Recuperó el hilo histórico.",
    };
    await service.recordCompanionAssist(assist);
    const afterExecution = (await store.read()).heroes.opus.xp;

    await service.recordCompanionAssist(assist);
    await service.recordCompanionAssist(assist);
    expect((await store.read()).heroes.opus.xp).toBe(afterExecution);

    await service.submitEvidence(quest.id, quest.steps[0].id, {
      summary: "Correo enviado.",
      source: "mcp",
      verdict: "accepted",
      reasoning: "Comprobado.",
      impactAwarded: 40,
    });
    const afterValidation = (await store.read()).heroes.opus.xp;
    expect(afterValidation).toBeGreaterThan(afterExecution);

    // Repetir la ejecución después de validar tampoco vuelve a pagar.
    await service.recordCompanionAssist(assist);
    expect((await store.read()).heroes.opus.xp).toBe(afterValidation);
  });

  it("H-003: ganar una Battle sube las estadísticas de carrera exactamente una vez", async () => {
    const questId = await winQuest(planNamed("Carrera del grupo"));
    const state = await store.read();
    for (const heroId of ["roko", "marques", "cordera"] as const) {
      expect(state.heroes[heroId].stats.battlesEntered).toBe(1);
      expect(state.heroes[heroId].stats.battlesWon).toBe(1);
      expect(state.heroes[heroId].stats.questsCompleted).toBe(1);
      expect(state.heroes[heroId].stats.validatedImpact).toBe(100);
    }
    // Volver a leer el reino no puede sumar otra victoria.
    await service.snapshot();
    await service.snapshot();
    const again = await store.read();
    expect(again.heroes.roko.stats.battlesWon).toBe(1);
    expect(again.quests.find((quest) => quest.id === questId)!.status).toBe("completed");
  });

  it("H-004: la subida de nivel emite su hecho una sola vez", async () => {
    await winQuest(planNamed("Primera gesta"));
    await winQuest(planNamed("Segunda gesta"));
    await winQuest(planNamed("Tercera gesta"));
    await winQuest(planNamed("Cuarta gesta"));

    const state = await store.read();
    const levelUps = state.gameEvents.filter((event) => event.type === "hero_level_up" && event.heroId === "marques");
    const levels = levelUps.map((event) => event.level);
    expect(new Set(levels).size).toBe(levels.length);
    expect(state.heroes.marques.level).toBeGreaterThan(1);
  });

  it("H-005: el nivel es gameplay y NO cambia ninguna autorización", async () => {
    const quest = await service.createDraft(planNamed("Nivel no es permiso"));
    // Un Opus imposiblemente veterano.
    await store.mutate((state) => {
      state.heroes.opus.xp = 999_999;
      state.heroes.opus.level = 50;
    });

    // Sigue sin poder iniciar sin aceptación explícita.
    await expect(service.accept(quest.id, false)).rejects.toThrow();
    await expect(service.start(quest.id)).rejects.toThrow();
    await service.accept(quest.id, true);
    await service.start(quest.id);

    // Y sigue sin poder conceder impacto sin veredicto admisible.
    await expect(
      service.submitEvidence(quest.id, quest.steps[0].id, {
        summary: "Opus dice que ya está.",
        source: "mcp",
        verdict: "rejected",
        reasoning: "Sin prueba.",
        impactAwarded: 10,
      }),
    ).rejects.toThrow();

    const snapshot = await service.snapshot();
    expect(snapshot.entitlements).toEqual((await store.read()).entitlements);
    expect(snapshot.battle!.progress).toBe(0);
  });

  // -------------------------------------------------------------------------
  // INTEGRIDAD DE EVENTOS
  // -------------------------------------------------------------------------

  it("EV-001: anular un hecho erróneo lo conserva en auditoría y devuelve el daño", async () => {
    const quest = await service.createDraft(planNamed("El golpe que no fue"));
    await service.accept(quest.id, true);
    await service.start(quest.id);

    // Vida y escudo juntos: el golpe puede caer sobre el escudo de Roku, y
    // devolverlo tiene que devolver exactamente lo que quitó, no otra cosa.
    const vitality = (party: { roko: { health: number; shield?: number }; marques: { health: number }; cordera: { health: number } }) =>
      party.roko.health + (party.roko.shield ?? 0) + party.marques.health + party.cordera.health;

    const beforeTotal = vitality((await service.snapshot()).battle!.party);

    const attack = await service.recordUnexpectedRequirement(quest.id, {
      reason: "La Fiscalía exigió un poder notariado adicional.",
      damage: 18,
    });
    expect(vitality((await service.snapshot()).battle!.party)).toBeLessThan(beforeTotal);

    const undone = await service.invalidateEvent({
      eventId: attack.lifeEventId,
      reason: "Se registró por un fallo operativo: nunca existió tal exigencia.",
      invalidatedBy: "codice",
    });
    expect(undone.healed + undone.shieldRestored).toBeGreaterThan(0);
    expect(vitality((await service.snapshot()).battle!.party)).toBe(beforeTotal);

    // AUDIT HISTORY LO CONSERVA.
    const state = await store.read();
    const lifeEvent = state.lifeEvents.find((event) => event.id === attack.lifeEventId)!;
    expect(lifeEvent).toBeDefined();
    expect(lifeEvent.status).toBe("invalidated");
    expect(lifeEvent.invalidatedBy).toBe("codice");
    expect(lifeEvent.invalidationReason).toContain("fallo operativo");
    expect(state.gameEvents.find((event) => event.id === attack.gameEventId)!.status).toBe("invalidated");

    // Y no se puede anular dos veces para curar el doble.
    await expect(
      service.invalidateEvent({ eventId: attack.lifeEventId, reason: "Intento de anular otra vez el mismo hecho." }),
    ).rejects.toThrow();
  });

  it("EV-002: completar dos veces no concede dos recompensas ni dos informes", async () => {
    const quest = await service.createDraft(planNamed("Cierre idempotente"));
    await service.accept(quest.id, true);
    await service.start(quest.id);
    await service.submitEvidence(quest.id, quest.steps[0].id, {
      summary: "Primer tramo.",
      source: "user_declaration",
      verdict: "accepted",
      reasoning: "Comprobado.",
      impactAwarded: 40,
    });
    await service.submitEvidence(quest.id, quest.steps[1].id, {
      summary: "Tramo final.",
      source: "user_declaration",
      verdict: "accepted",
      reasoning: "Comprobado.",
      impactAwarded: 60,
    });

    const xp = (await store.read()).character.xp;
    // El paso ya está cerrado: reintentarlo no puede volver a pagar.
    await expect(
      service.submitEvidence(quest.id, quest.steps[1].id, {
        summary: "Otra vez.",
        source: "user_declaration",
        verdict: "accepted",
        reasoning: "Comprobado.",
        impactAwarded: 60,
      }),
    ).rejects.toThrow();

    const state = await store.read();
    expect(state.character.xp).toBe(xp);
    expect(state.afterActionReports.filter((report) => report.questId === quest.id)).toHaveLength(1);
    expect(state.events.filter((event) => event.type === "quest_completed" && event.entityId === quest.id)).toHaveLength(1);
    expect(state.heroes.marques.stats.questsCompleted).toBe(1);
  });

  it("EV-003: `unexpected_requirement` no puede nacer de un reintento, del reloj ni de un fallo técnico", async () => {
    const quest = await service.createDraft(planNamed("Guardarraíl de la Horda"));
    await service.accept(quest.id, true);
    await service.start(quest.id);

    const excusas = [
      "La herramienta dio timeout y hubo que reintentar la llamada.",
      "El assist quedó duplicado por un error técnico del cliente.",
      "La operación tardó mucho por latencia de la red.",
      "Hubo que depurar un stack trace del servidor.",
    ];
    for (const reason of excusas) {
      await expect(service.recordUnexpectedRequirement(quest.id, { reason, damage: 10 })).rejects.toThrow(
        /no son exigencias nuevas|NO son exigencias/i,
      );
    }

    // Una exigencia REAL sí golpea.
    await expect(
      service.recordUnexpectedRequirement(quest.id, {
        reason: "La Fiscalía pidió además el certificado de existencia y representación.",
        damage: 10,
      }),
    ).resolves.toBeDefined();
  });

  // -------------------------------------------------------------------------
  // MEMORIA DE BATALLA
  // -------------------------------------------------------------------------

  it("BM-001: se guardan la duración pactada y la real de la Battle", async () => {
    const quest = await service.createDraft(planNamed("Despliegue de producción", 25));
    await service.accept(quest.id, true);
    await service.start(quest.id);
    // El intento arrancó hace 42 minutos de reloj activo.
    await store.mutate((state) => {
      const battle = state.quests.find((candidate) => candidate.id === quest.id)!.battle!;
      const shift = 42 * 60_000;
      battle.startedAt = new Date(Date.parse(battle.startedAt) - shift).toISOString();
      battle.attempts[0].startedAt = battle.startedAt;
      battle.deadlineAt = new Date(Date.parse(battle.deadlineAt) - shift).toISOString();
      // La presión ya liquidada no debe volver a cobrarse en este test.
      battle.settledPressureMs = shift;
    });
    for (const step of quest.steps) {
      await service.submitEvidence(quest.id, step.id, {
        summary: `Se cumplió ${step.title}.`,
        source: "user_declaration",
        verdict: "accepted",
        reasoning: "Comprobado.",
        impactAwarded: step.weight,
      });
    }

    const report = await service.afterActionReport(quest.id);
    expect(report).not.toBeNull();
    expect(report!.plannedDurationMinutes).toBe(25);
    expect(Math.round(report!.actualActiveMs / 60_000)).toBeGreaterThanOrEqual(40);
    expect(report!.lessons.join(" ")).toContain("planifica al menos");
  });

  it("BM-002/BM-003: una Quest parecida recupera la duración histórica y sus lecciones", async () => {
    const first = await service.createDraft(planNamed("Despliegue de producción del portal", 20));
    await service.accept(first.id, true);
    await service.start(first.id);
    await store.mutate((state) => {
      const battle = state.quests.find((candidate) => candidate.id === first.id)!.battle!;
      const shift = 47 * 60_000;
      battle.startedAt = new Date(Date.parse(battle.startedAt) - shift).toISOString();
      battle.attempts[0].startedAt = battle.startedAt;
      battle.settledPressureMs = shift;
    });
    for (const step of first.steps) {
      await service.submitEvidence(first.id, step.id, {
        summary: `Se cumplió ${step.title}.`,
        source: "user_declaration",
        verdict: "accepted",
        reasoning: "Comprobado.",
        impactAwarded: step.weight,
      });
    }

    const hint = await service.planningHint("Despliegue de producción del portal nuevo");
    expect(hint.samples).toBe(1);
    expect(hint.historicalMedianMinutes).toBeGreaterThanOrEqual(45);
    expect(hint.plannedMedianMinutes).toBe(20);
    expect(hint.lessons.length).toBeGreaterThan(0);
    expect(hint.playbook).not.toBeNull();
    expect(hint.playbook!.steps).toHaveLength(2);

    // LA PISTA NO MUTA NADA: el contrato de la Quest cerrada sigue igual.
    const stored = (await store.read()).quests.find((quest) => quest.id === first.id)!;
    expect(stored.durationMinutes).toBe(20);
    expect(stored.battle!.attempts[0].durationMinutes).toBe(20);
  });

  // -------------------------------------------------------------------------
  // BARRACAS
  // -------------------------------------------------------------------------

  it("B-001: las Barracas listan a Roku, Marqués y Cordera", async () => {
    const barracks = await service.barracks();
    const party = barracks.heroes.filter((hero) => hero.kind === "party").map((hero) => hero.displayName);
    expect(party).toEqual(["Roku", "Marqués", "Cordera"]);
  });

  it("B-002/B-003: Opus con historia real; Claude conocido y SIN estadísticas inventadas", async () => {
    const quest = await service.createDraft(planNamed("Historia real"));
    await service.accept(quest.id, true);
    await service.start(quest.id);
    await service.recordCompanionAssist({
      questId: quest.id,
      stepId: quest.steps[0].id,
      companion: "opus",
      sourceTool: "gmail_search_inbox",
      executionRef: "exec-historia",
      contributionSummary: "Recuperó el hilo histórico de Fiscalía 43.",
    });
    await service.submitEvidence(quest.id, quest.steps[0].id, {
      summary: "El correo salió.",
      source: "mcp",
      verdict: "accepted",
      reasoning: "Verificado en SENT.",
      impactAwarded: 40,
    });

    const barracks = await service.barracks();
    const opus = barracks.heroes.find((hero) => hero.id === "opus")!;
    expect(opus.deployment).toBe("deployed");
    expect(opus.stats.validatedAssists).toBe(1);
    expect(opus.recentDeeds.some((deed) => deed.outcome === "verified")).toBe(true);
    expect(opus.masteries.length).toBeGreaterThan(0);
    // MASTERY MUST BE EXPLAINABLE.
    expect(opus.masteries[0].evidence.join(" ")).toContain("assist");

    const claude = barracks.heroes.find((hero) => hero.id === "claude")!;
    expect(claude.deployment).toBe("known");
    expect(claude.level).toBe(1);
    expect(claude.xp).toBe(0);
    expect(claude.stats.executions).toBe(0);
    expect(claude.stats.validatedAssists).toBe(0);
    expect(claude.recentDeeds).toHaveLength(0);
    expect(claude.capabilities.length).toBeGreaterThan(0);
  });

  it("B-004: un conector caído NO borra al héroe ni su historia", async () => {
    const quest = await service.createDraft(planNamed("El conector que cayó"));
    await service.accept(quest.id, true);
    await service.start(quest.id);
    await service.recordCompanionAssist({
      questId: quest.id,
      stepId: quest.steps[0].id,
      companion: "opus",
      sourceTool: "gmail_search_inbox",
      executionRef: "exec-caida",
      contributionSummary: "Recuperó el hilo histórico.",
    });

    const barracks = await service.setHeroAvailability("opus", "unavailable");
    const opus = barracks.heroes.find((hero) => hero.id === "opus")!;
    expect(opus.availability).toBe("unavailable");
    expect(opus.deployment).toBe("unavailable");
    expect(opus.stats.executions).toBe(1);
    expect(opus.recentDeeds.length).toBeGreaterThan(0);
    expect(opus.lastDeployedAt).toBeDefined();
  });

  it("B-005: la última formación recuerda quién peleó y cómo terminó", async () => {
    const quest = await service.createDraft(planNamed("La formación recordada"));
    await service.accept(quest.id, true);
    await service.start(quest.id);
    await service.recordCompanionAssist({
      questId: quest.id,
      stepId: quest.steps[0].id,
      companion: "opus",
      sourceTool: "gmail_search_inbox",
      executionRef: "exec-formacion",
      contributionSummary: "Recuperó el hilo histórico.",
    });
    for (const step of quest.steps) {
      await service.submitEvidence(quest.id, step.id, {
        summary: `Se cumplió ${step.title}.`,
        source: "mcp",
        verdict: "accepted",
        reasoning: "Comprobado.",
        impactAwarded: step.weight,
      });
    }

    const formation = (await service.barracks()).lastFormation!;
    expect(formation.questTitle).toBe("La formación recordada");
    expect(formation.result).toBe("victory");
    expect(formation.heroes.map((hero) => hero.displayName)).toEqual(["Roku", "Marqués", "Cordera", "Opus"]);
  });
});
