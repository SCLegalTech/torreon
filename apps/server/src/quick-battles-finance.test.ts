import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QuestPlanInput } from "./domain.js";
import { QuestService } from "./quest-service.js";
import { JsonRealmStore } from "./store.js";

/**
 * NOT EVERY REAL ACTION IS A CAMPAIGN.
 * BACKLOG IS NOT FOCUS. FOCUS IS NOT ENGAGEMENT.
 * REAL MONEY IS NOT GAME CURRENCY.
 */

function quickBattle(title: string): QuestPlanInput {
  return {
    title,
    intent: `Resolver ${title}.`,
    outcome: `${title} queda resuelto y comprobable.`,
    rationale: "Una Battle real de ~10 minutos. No es Campaña, Acto ni Saga.",
    durationMinutes: 10,
    wellbeingConstraints: [],
    allowedApps: [],
    steps: [{ title: "Ejecutar el pago", actor: "user", evidence: "Comprobante", evidenceKind: "declaration", weight: 100 }],
  };
}

describe("Quick Battles y foco", () => {
  let directory: string;
  let service: QuestService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "torreon-qb-"));
    const store = new JsonRealmStore(join(directory, "state.json"));
    await store.init();
    service = new QuestService(store, undefined, directory, "torreon-qb-test");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("Q-001: una Quest standalone vive sin campaignId ni actId y aparece en Quick Battles", async () => {
    const draft = await service.createDraft(quickBattle("El Tributo del Refugio"));
    expect(draft.campaignId).toBeUndefined();
    expect(draft.actId).toBeUndefined();
    expect(draft.campaignTitle).toBe("");

    const snapshot = await service.snapshot();
    const node = snapshot.hierarchy.standaloneQuests.find((candidate) => candidate.id === draft.id);
    expect(node).toBeTruthy();
    expect(node!.scope).toBe("standalone");
  });

  it("create_quest_draft ya no exige campaignTitle", async () => {
    const draft = await service.createDraft({ ...quickBattle("El Sello de la Señal"), campaignTitle: undefined });
    expect(draft.id).toBeTruthy();
    expect(draft.campaignTitle).toBe("");
  });

  it("Q-002: cinco borradores no comprometen ningún frente ni vuelven «actual» a ninguno", async () => {
    for (let i = 0; i < 5; i += 1) await service.createDraft(quickBattle(`Batalla ${i}`));
    const snapshot = await service.snapshot();
    expect(snapshot.hierarchy.engagedQuestId).toBeNull();
    expect(snapshot.engagedQuest).toBeNull();
    expect(snapshot.currentQuest).toBeNull();
    expect(snapshot.realm.quests.every((quest) => quest.status === "draft")).toBe(true);
    expect(snapshot.hierarchy.standaloneQuests).toHaveLength(5);
  });

  it("Q-003/Q-004: focus_quest sólo mira; start compromete", async () => {
    const a = await service.createDraft(quickBattle("El Tributo del Refugio"));
    const b = await service.createDraft(quickBattle("El Sello de la Señal"));

    const focused = await service.focusQuest(a.id);
    expect(focused.hierarchy.focusedQuestId).toBe(a.id);
    expect(focused.focusedQuest?.id).toBe(a.id);
    expect(focused.currentQuest?.id).toBe(a.id);
    // Mirar un borrador no arranca ningún reloj.
    expect(focused.battle?.clock).toBeNull();
    expect(focused.hierarchy.engagedQuestId).toBeNull();

    await service.accept(b.id, true);
    const started = await service.start(b.id);
    void started;
    const snapshot = await service.snapshot();
    expect(snapshot.hierarchy.engagedQuestId).toBe(b.id);
    expect(snapshot.engagedQuest?.id).toBe(b.id);
    // El frente comprometido manda sobre el foco explícito.
    expect(snapshot.currentQuest?.id).toBe(b.id);
  });
});

describe("Actos en paralelo", () => {
  let directory: string;
  let service: QuestService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "torreon-acts-"));
    const store = new JsonRealmStore(join(directory, "state.json"));
    await store.init();
    service = new QuestService(store, undefined, directory, "torreon-acts-test");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("A-001: un Acto sin dependencia está disponible aunque otro anterior siga incompleto", async () => {
    const { campaign } = await service.createCampaignDraft({ title: "La Forja de Solve & Coagula" });
    await service.acceptCampaign(campaign.id, true);
    const actII = await service.createAct({ title: "Reabrir el Mercado", campaignId: campaign.id });
    const actIII = await service.createAct({ title: "Automatizaciones", campaignId: campaign.id });
    void actII;

    const snapshot = await service.snapshot();
    const view = snapshot.hierarchy.campaigns.find((candidate) => candidate.id === campaign.id)!;
    expect(view.acts.every((act) => !act.locked)).toBe(true);
    expect(view.acts.find((act) => act.id === actIII.id)?.locked).toBe(false);
  });

  it("A-002: un Acto con dependencia explícita incompleta está bloqueado", async () => {
    const { campaign } = await service.createCampaignDraft({ title: "La Forja de Solve & Coagula" });
    await service.acceptCampaign(campaign.id, true);
    const actII = await service.createAct({ title: "Reabrir el Mercado", campaignId: campaign.id });
    const actIV = await service.createAct({
      title: "Real Business",
      campaignId: campaign.id,
      dependsOnActIds: [actII.id],
    });

    const snapshot = await service.snapshot();
    const view = snapshot.hierarchy.campaigns.find((candidate) => candidate.id === campaign.id)!;
    expect(view.acts.find((act) => act.id === actIV.id)?.locked).toBe(true);
  });
});

describe("Borrado de borradores", () => {
  let directory: string;
  let service: QuestService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "torreon-del-"));
    const store = new JsonRealmStore(join(directory, "state.json"));
    await store.init();
    service = new QuestService(store, undefined, directory, "torreon-del-test");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("D-001: un borrador nunca aceptado se elimina de raíz", async () => {
    const draft = await service.createDraft(quickBattle("Borrador irrelevante"));
    await service.deleteQuestDraft(draft.id);
    const snapshot = await service.snapshot();
    expect(snapshot.realm.quests).toHaveLength(0);
    expect(snapshot.realm.notifications.filter((n) => n.entityId === draft.id)).toHaveLength(0);
  });

  it("D-002: una Quest aceptada NO se borra; abandon sí funciona", async () => {
    const draft = await service.createDraft(quickBattle("El Tributo del Refugio"));
    await service.accept(draft.id, true);
    await expect(service.deleteQuestDraft(draft.id)).rejects.toThrow(/abandon_quest/i);
    const abandoned = await service.abandon(draft.id, "Cambió la realidad.");
    expect(abandoned.status).toBe("abandoned");
  });

  it("D-003: una Quest completada es inmutable y su historia permanece", async () => {
    const draft = await service.createDraft(quickBattle("El Tributo del Refugio"));
    await service.accept(draft.id, true);
    const active = await service.start(draft.id);
    await service.completeStep(active.id, active.steps[0].id, "Pago ejecutado y comprobado.");
    await expect(service.deleteQuestDraft(draft.id)).rejects.toThrow(/borrador/i);
    const snapshot = await service.snapshot();
    expect(snapshot.realm.quests.find((quest) => quest.id === draft.id)?.status).toBe("completed");
  });
});

describe("Tesorería viva", () => {
  let directory: string;
  let service: QuestService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "torreon-treasury-"));
    const store = new JsonRealmStore(join(directory, "state.json"));
    await store.init();
    service = new QuestService(store, undefined, directory, "torreon-treasury-test");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("F-001: una obligación mensual de arriendo nace con período pendiente", async () => {
    const obligation = await service.createRecurringObligation({
      name: "Arriendo apartamento",
      direction: "expense",
      category: "housing",
      frequency: "monthly",
      provider: "Home",
      dueRule: { type: "day_of_month", day: 5 },
    });
    expect(obligation.lastPaidPeriod).toBeNull();
    const { obligations } = await service.getFinancialObligations();
    expect(obligations.find((o) => o.id === obligation.id)?.periodStatus).toBe("pending");
  });

  it("F-002/F-003: un pago validado concilia el período y la misma evidencia no lo duplica", async () => {
    const obligation = await service.createRecurringObligation({
      name: "Factura de Claro",
      direction: "expense",
      category: "utilities",
      frequency: "monthly",
      dueRule: { type: "day_of_month", day: 10 },
    });

    const first = await service.recordFinancialTransaction({
      direction: "expense",
      amount: 89_900,
      recurringObligationId: obligation.id,
      evidenceArtifactId: "b3ef0fde-0ddc-4873-a343-14560a17d1fd",
      note: "Pago PSE confirmado.",
    });
    expect(first.duplicate).toBe(false);
    expect(first.transaction.amount).toBe(89_900);

    const { obligations } = await service.getFinancialObligations();
    const view = obligations.find((o) => o.id === obligation.id)!;
    expect(view.periodStatus).toBe("paid");
    expect(view.lastPaidPeriod).toBe(new Date().toISOString().slice(0, 7));

    const replay = await service.recordFinancialTransaction({
      direction: "expense",
      amount: 89_900,
      recurringObligationId: obligation.id,
      evidenceArtifactId: "b3ef0fde-0ddc-4873-a343-14560a17d1fd",
    });
    expect(replay.duplicate).toBe(true);
    const snapshot = await service.snapshot();
    expect(snapshot.realm.financialTransactions).toHaveLength(1);
  });

  it("F-004: el monto NO se infiere del impacto de la Quest", async () => {
    await expect(
      service.recordFinancialTransaction({ direction: "expense", amount: 0, questId: "00000000-0000-0000-0000-000000000000" }),
    ).rejects.toThrow(/monto real es obligatorio/i);
  });

  it("el pago mueve el dinero real y jamás fabrica moneda de juego", async () => {
    const before = (await service.snapshot()).stats.treasure.amount;
    await service.recordFinancialTransaction({ direction: "expense", amount: 50_000, note: "Gasto suelto." });
    const after = await service.snapshot();
    expect(after.stats.treasure.amount).toBe(before - 50_000);
    // XP y Aura no cambian por gastar dinero real.
    expect(after.stats.xp).toBe(0);
    expect(after.stats.aura).toBe(0);
  });
});

describe("Entitlements y telemetría de uso", () => {
  let directory: string;
  let store: JsonRealmStore;
  let service: QuestService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "torreon-plan-"));
    store = new JsonRealmStore(join(directory, "state.json"));
    await store.init();
    service = new QuestService(store, undefined, directory, "torreon-plan-test");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("E-001: el plan dev no tiene tope de Battles y cuenta los inicios", async () => {
    const snapshot = await service.snapshot();
    expect(snapshot.entitlements.plan).toBe("dev");
    expect(snapshot.entitlements.dailyBattleLimit).toBeNull();

    const draft = await service.createDraft(quickBattle("El Tributo del Refugio"));
    await service.accept(draft.id, true);
    await service.start(draft.id);
    const after = await service.snapshot();
    expect(after.usage.battlesStartedToday).toBe(1);
  });

  it("E-002: con tope, un reintento no consume otro cupo pero abrir otro frente sí", async () => {
    // Se fuerza el plan free directamente en el estado persistido.
    await store.mutate((state) => {
      state.entitlements.dailyBattleLimit = 1;
      return null;
    });

    const a = await service.createDraft(quickBattle("El Tributo del Refugio"));
    await service.accept(a.id, true);
    await service.start(a.id);
    expect((await service.snapshot()).usage.battlesStartedToday).toBe(1);

    // Se cierra el intento como plazo vencido, sin tocar al grupo.
    await store.mutate((state) => {
      const record = state.quests.find((quest) => quest.id === a.id)!.battle!;
      record.status = "awaiting_replan";
      record.endedAt = new Date().toISOString();
      return null;
    });

    // REPLANIFICAR NO ES UNA BATALLA NUEVA PAGADA: el cupo no se toca.
    await service.retryBattle(a.id, 10);
    expect((await service.snapshot()).usage.battlesStartedToday).toBe(1);

    const b = await service.createDraft(quickBattle("El Sello de la Señal"));
    await service.accept(b.id, true);
    // El primer frente sigue comprometido; el frente único ya impide abrir otro.
    await expect(service.start(b.id)).rejects.toThrow();
  });
});
