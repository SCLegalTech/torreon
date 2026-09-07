import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QuestPlanInput } from "./domain.js";
import { QuestService } from "./quest-service.js";
import { classifyScale, MAX_ACTS_PER_CAMPAIGN, MAX_QUESTS_PER_ACT } from "./scale.js";
import { JsonRealmStore } from "./store.js";
import { fixedClock } from "./clock.js";

/**
 * EL RELOJ DEL REINO SE PLANTA (artículo 8, ADR-0006). Sin esto, la presión y
 * las ventanas críticas dependían del tiempo real que tardara la suite, y la
 * misma prueba pasaba aislada y fallaba bajo carga.
 */
const RELOJ_DEL_REINO = "2026-05-11T09:00:00.000Z";

/**
 * LA ESCALA DEL MUNDO SIGUE LA ESCALA DE LA VIDA.
 *
 * Lo que fija la escala son los minutos de TRABAJO ACTIVO. Una espera ajena al
 * jugador alarga el calendario, no la jerarquía.
 */
describe("Códice elige la escala", () => {
  it("45 minutos de trabajo son una Quest", () => {
    const proposal = classifyScale({ activeMinutes: 45 });
    expect(proposal.scale).toBe("quest");
    expect(proposal.suggestedQuests).toBe(1);
  });

  it("4 horas de trabajo activo son un Acto con varias Quests", () => {
    const proposal = classifyScale({ activeMinutes: 240 });
    expect(proposal.scale).toBe("act");
    expect(proposal.suggestedQuests).toBe(4);
    expect(proposal.suggestedActs).toBe(1);
  });

  it("un objetivo de varios días activos, hasta 7 Actos, es una Campaña", () => {
    const proposal = classifyScale({ activeMinutes: 1_500 });
    expect(proposal.scale).toBe("campaign");
    expect(proposal.suggestedActs).toBeLessThanOrEqual(MAX_ACTS_PER_CAMPAIGN);
  });

  it("un objetivo multisemana es una Saga", () => {
    const proposal = classifyScale({ activeMinutes: 6_000 });
    expect(proposal.scale).toBe("saga");
    expect(proposal.suggestedCampaigns).toBeGreaterThanOrEqual(2);
  });

  it("dos campañas naturales ya son una Saga aunque el trabajo sea corto", () => {
    expect(classifyScale({ activeMinutes: 300, naturalCampaigns: 2 }).scale).toBe("saga");
  });

  it("10 minutos de trabajo más 3 días de espera externa NO son una Campaña", () => {
    const proposal = classifyScale({ activeMinutes: 10, externalWaitMinutes: 3 * 24 * 60 });
    expect(proposal.scale).toBe("quest");
    expect(proposal.waitingExternal).toBe(true);
  });

  it("más de 8 Battles obligan a partir en varios Actos", () => {
    const proposal = classifyScale({ activeMinutes: 9 * 60 });
    expect(proposal.suggestedQuests).toBe(9);
    expect(proposal.suggestedActs).toBe(2);
  });

  it("más de 7 Actos obligan a partir en varias Campañas bajo una Saga", () => {
    const proposal = classifyScale({ activeMinutes: 8 * MAX_QUESTS_PER_ACT * 60 + 60 });
    expect(proposal.suggestedActs).toBeGreaterThan(MAX_ACTS_PER_CAMPAIGN);
    expect(proposal.scale).toBe("saga");
  });
});

const microPlan: QuestPlanInput = {
  campaignTitle: "Correspondencia",
  title: "Un correo",
  intent: "Enviar un correo pendiente.",
  outcome: "El correo queda enviado.",
  rationale: "Quince minutos no necesitan ceremonia.",
  durationMinutes: 15,
  wellbeingConstraints: [],
  allowedApps: [],
  steps: [{ title: "Enviar", actor: "user", evidence: "Confirmación", evidenceKind: "declaration", weight: 100 }],
};

describe("Jerarquía Saga → Campaña → Acto → Quest", () => {
  let directory: string;
  let service: QuestService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "torreon-scale-"));
    const store = new JsonRealmStore(join(directory, "state.json"), fixedClock(RELOJ_DEL_REINO));
    await store.init();
    service = new QuestService(store, undefined, directory, "torreon-scale-test", fixedClock(RELOJ_DEL_REINO));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("una microquest vive sin padres y aun así entra en batalla", async () => {
    const quest = await service.createDraft(microPlan);
    expect(quest.actId).toBeUndefined();
    expect(quest.campaignId).toBeUndefined();

    const snapshot = await service.snapshot();
    expect(snapshot.hierarchy.currentActId).toBeNull();
    expect(snapshot.hierarchy.currentCampaignId).toBeNull();
    expect(snapshot.hierarchy.standaloneQuests.map((node) => node.id)).toContain(quest.id);
  });

  it("una Quest dentro de un Acto arrastra su Campaña y su Saga", async () => {
    const saga = await service.createSaga({ title: "Recuperar la Marca" });
    const { campaign } = await service.createCampaignDraft({ title: "The Inbox Siege", sagaId: saga.id, objective: "12 comunicaciones procesadas" });
    await service.acceptCampaign(campaign.id, true);
    const act = await service.createAct({ title: "Acto I", subtitle: "La comunicación bloqueada", campaignId: campaign.id });

    const quest = await service.createDraft(microPlan, { actId: act.id });
    expect(quest.actId).toBe(act.id);
    expect(quest.campaignId).toBe(campaign.id);
    expect(quest.sagaId).toBe(saga.id);

    const snapshot = await service.snapshot();
    expect(snapshot.hierarchy.currentCampaignId).toBe(campaign.id);
    expect(snapshot.hierarchy.currentActId).toBe(act.id);
    const view = snapshot.hierarchy.campaigns.find((candidate) => candidate.id === campaign.id)!;
    expect(view.totalActs).toBe(1);
    expect(view.acts[0].totalQuests).toBe(1);
    expect(view.percent).toBe(0);
  });

  it("el progreso sube sólo con resultados reales y cierra Acto, Campaña y Saga", async () => {
    const saga = await service.createSaga({ title: "Recuperar la Marca" });
    const { campaign } = await service.createCampaignDraft({ title: "The Inbox Siege", sagaId: saga.id });
    await service.acceptCampaign(campaign.id, true);
    const act = await service.createAct({ title: "Acto I", campaignId: campaign.id });
    const quest = await service.createDraft(microPlan, { actId: act.id });

    await service.accept(quest.id, true);
    await service.start(quest.id);
    await service.completeStep(quest.id, quest.steps[0].id, "Correo enviado");

    const snapshot = await service.snapshot();
    const view = snapshot.hierarchy.campaigns.find((candidate) => candidate.id === campaign.id)!;
    expect(view.completedQuests).toBe(1);
    expect(view.percent).toBe(100);
    expect(view.status).toBe("completed");
    expect(snapshot.hierarchy.sagas[0].completedCampaigns).toBe(1);
  });

  it("un Acto no sostiene más de 8 Battles", async () => {
    const act = await service.createAct({ title: "Acto saturado" });
    for (let index = 0; index < MAX_QUESTS_PER_ACT; index += 1) {
      await service.createDraft({ ...microPlan, title: `Correo ${index + 1}` }, { actId: act.id });
    }
    await expect(service.createDraft({ ...microPlan, title: "Uno de más" }, { actId: act.id })).rejects.toThrow(/Battles/);
  });

  it("una Campaña no sostiene más de 7 Actos", async () => {
    const { campaign } = await service.createCampaignDraft({ title: "Campaña llena" });
    for (let index = 0; index < MAX_ACTS_PER_CAMPAIGN; index += 1) {
      await service.createAct({ title: `Acto ${index + 1}`, campaignId: campaign.id });
    }
    await expect(service.createAct({ title: "Acto de más", campaignId: campaign.id })).rejects.toThrow(/Actos/);
  });

  it("el servicio clasifica el objetivo sin crear nada", async () => {
    const proposal = service.classifyObjective("Enviar este correo", { activeMinutes: 15 });
    expect(proposal.scale).toBe("quest");
    expect((await service.snapshot()).realm.quests).toHaveLength(0);
  });
});
