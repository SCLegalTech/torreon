import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QuestPlanInput, RealmEvent } from "./domain.js";
import { QuestService } from "./quest-service.js";
import { JsonRealmStore } from "./store.js";
import { fixedClock } from "./clock.js";

/**
 * EL RELOJ DEL REINO SE PLANTA (artículo 8, ADR-0006). Sin esto, la presión y
 * las ventanas críticas dependían del tiempo real que tardara la suite, y la
 * misma prueba pasaba aislada y fallaba bajo carga.
 */
const RELOJ_DEL_REINO = "2026-05-11T09:00:00.000Z";

/**
 * ONE REALM. MANY CAMPAIGNS. ANY CÓDICE BRAIN. NO SHADOW STATE.
 *
 * Si Códice puede imaginar una Campaña pero no escribirla en el Realm, no hay
 * gameplay multisuperficie: hay texto bonito en un chat. Estas pruebas
 * recorren el plano de control completo sin abrir la app.
 */

function planFor(title: string): QuestPlanInput {
  return {
    campaignTitle: "La Forja de Solve & Coagula",
    title,
    intent: `Avanzar ${title}.`,
    outcome: `${title} queda cerrado de forma verificable.`,
    rationale: "Una quest que ya existía antes de que existiera su campaña.",
    durationMinutes: 45,
    wellbeingConstraints: [],
    allowedApps: [],
    steps: [{ title: "Cerrar el frente", actor: "user", evidence: "Constancia", evidenceKind: "declaration", weight: 100 }],
  };
}

const eventsFor = (events: RealmEvent[], type: RealmEvent["type"]) => events.filter((event) => event.type === type);

describe("Plano de control de campañas", () => {
  let directory: string;
  let service: QuestService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "torreon-control-"));
    const store = new JsonRealmStore(join(directory, "state.json"), fixedClock(RELOJ_DEL_REINO));
    await store.init();
    service = new QuestService(store, undefined, directory, "torreon-control-test", fixedClock(RELOJ_DEL_REINO));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("Códice traza una campaña real y el reino la devuelve, sin abrir la app", async () => {
    const { campaign, acts } = await service.createCampaignDraft({
      title: "La Forja de Solve & Coagula",
      intent: "Poner al día los frentes operativos y comerciales de la firma.",
      objective: "Los frentes prioritarios quedan atendidos y la operación vuelve a un estado controlado.",
      estimatedActiveMinutes: 1_200,
      estimatedCalendarDays: 21,
      initialActs: [
        { title: "Los Expedientes Abiertos", outcome: "Los expedientes vivos quedan al día." },
        { title: "Reabrir las Puertas del Mercado", outcome: "La captación vuelve a funcionar." },
      ],
    });

    expect(campaign.status).toBe("draft");
    expect(acts).toHaveLength(2);

    const snapshot = await service.snapshot();
    const view = snapshot.hierarchy.campaigns.find((candidate) => candidate.id === campaign.id)!;
    expect(view.title).toBe("La Forja de Solve & Coagula");
    expect(view.totalActs).toBe(2);
    expect(view.estimatedCalendarDays).toBe(21);
    // Un borrador no está vivo todavía.
    expect(snapshot.hierarchy.activeCampaignIds).not.toContain(campaign.id);
  });

  it("el sello del jugador la activa, y aceptar B no desactiva A", async () => {
    const a = await service.createCampaignDraft({ title: "Búsqueda laboral" });
    const b = await service.createCampaignDraft({ title: "La Forja de Solve & Coagula" });

    await expect(service.acceptCampaign(a.campaign.id, false)).rejects.toThrow(/aceptación explícita/);

    await service.acceptCampaign(a.campaign.id, true);
    await service.acceptCampaign(b.campaign.id, true);

    const snapshot = await service.snapshot();
    expect(snapshot.hierarchy.activeCampaignIds).toEqual(expect.arrayContaining([a.campaign.id, b.campaign.id]));
    expect(snapshot.realm.campaigns.every((campaign) => campaign.status === "active")).toBe(true);
    // Aceptar no arranca ninguna Battle.
    expect(snapshot.hierarchy.engagedQuestId).toBeNull();
  });

  it("aceptar y enfocar son idempotentes y sólo mueven lo que dicen mover", async () => {
    const a = await service.createCampaignDraft({ title: "Búsqueda laboral" });
    const b = await service.createCampaignDraft({ title: "La Forja de Solve & Coagula" });
    await service.acceptCampaign(a.campaign.id, true);
    await service.acceptCampaign(a.campaign.id, true);
    await service.acceptCampaign(b.campaign.id, true);

    const focused = await service.focusCampaign(b.campaign.id);
    await service.focusCampaign(b.campaign.id);
    expect(focused.hierarchy.focusedCampaignId).toBe(b.campaign.id);

    const snapshot = await service.snapshot();
    expect(eventsFor(snapshot.realm.events, "campaign_accepted")).toHaveLength(2);
    expect(eventsFor(snapshot.realm.events, "campaign_focused")).toHaveLength(1);
    expect(snapshot.realm.campaigns.every((campaign) => campaign.status === "active")).toBe(true);
    expect(snapshot.hierarchy.engagedQuestId).toBeNull();
  });

  it("un borrador se reformula sin perder los actos que ya tienen quests", async () => {
    const { campaign, acts } = await service.createCampaignDraft({
      title: "La Forja",
      initialActs: [{ title: "Los Expedientes Abiertos" }, { title: "Acto vacío" }],
    });
    const quest = await service.createDraft(planFor("El Oráculo de la Gaceta"), { actId: acts[0].id });

    const revised = await service.reviseCampaignDraft(campaign.id, {
      title: "La Forja de Solve & Coagula",
      initialActs: [{ title: "Reabrir las Puertas del Mercado" }],
    });

    expect(revised.campaign.title).toBe("La Forja de Solve & Coagula");
    const titles = revised.acts.map((act) => act.title);
    expect(titles).toContain("Los Expedientes Abiertos");
    expect(titles).toContain("Reabrir las Puertas del Mercado");
    expect(titles).not.toContain("Acto vacío");
    // La quest sigue intacta y en su sitio.
    expect((await service.questDetail(quest.id)).id).toBe(quest.id);

    await service.acceptCampaign(campaign.id, true);
    await expect(service.reviseCampaignDraft(campaign.id, { title: "Otra cosa" })).rejects.toThrow(/borrador/);
  });

  it("vincula por ID una quest que ya existía, sin recrearla ni perder su historia", async () => {
    const quest = await service.createDraft(planFor("El Oráculo de la Gaceta"));
    await service.accept(quest.id, true);
    await service.start(quest.id);
    const startedAt = (await service.questDetail(quest.id)).startedAt;

    // Un campaignTitle coincidente NO crea campaña por sí solo.
    expect((await service.snapshot()).realm.campaigns).toHaveLength(0);

    const { campaign, acts } = await service.createCampaignDraft({
      title: "La Forja de Solve & Coagula",
      initialActs: [{ title: "Los Expedientes Abiertos" }],
    });
    await service.acceptCampaign(campaign.id, true);
    const assigned = await service.assignQuest(quest.id, { actId: acts[0].id });

    expect(assigned.quest.id).toBe(quest.id);
    expect(assigned.quest.status).toBe("active");
    expect(assigned.quest.campaignId).toBe(campaign.id);
    expect(assigned.quest.actId).toBe(acts[0].id);

    const detail = await service.questDetail(quest.id);
    expect(detail.startedAt).toBe(startedAt);
    expect(detail.acceptedAt).toBeTruthy();

    // Idempotente: repetirla no duplica la relación.
    await service.assignQuest(quest.id, { actId: acts[0].id });
    const snapshot = await service.snapshot();
    expect(snapshot.realm.acts[0].questIds).toEqual([quest.id]);
  });

  it("una quest puede colgar de la campaña sin acto, y un acto ajeno se rechaza", async () => {
    const a = await service.createCampaignDraft({ title: "La Forja", initialActs: [{ title: "Los Expedientes Abiertos" }] });
    const b = await service.createCampaignDraft({ title: "Búsqueda laboral" });
    await service.acceptCampaign(a.campaign.id, true);
    await service.acceptCampaign(b.campaign.id, true);

    const quest = await service.createDraft(planFor("El Sello de Producción"));
    const direct = await service.assignQuest(quest.id, { campaignId: b.campaign.id });
    expect(direct.quest.campaignId).toBe(b.campaign.id);
    expect(direct.quest.actId).toBeUndefined();

    const snapshot = await service.snapshot();
    const view = snapshot.hierarchy.campaigns.find((candidate) => candidate.id === b.campaign.id)!;
    expect(view.directQuests.map((node) => node.id)).toContain(quest.id);
    expect(view.totalQuests).toBe(1);

    await expect(service.assignQuest(quest.id, { campaignId: b.campaign.id, actId: a.acts[0].id })).rejects.toThrow(/otra campaña/);
    await expect(service.assignQuest(quest.id, {})).rejects.toThrow(/campaña o un acto/);
  });

  it("el planner propone campaña y actos desde la intención, sin inventar frentes", async () => {
    const planned = await service.planCampaignFromIntent({
      intent: "Poner al día Solve & Coagula durante las próximas semanas.",
      activeMinutes: 1_200,
      calendarDays: 21,
      fronts: ["Real Business", "Finaer", "Google Ads"],
    });
    expect(planned.campaign.status).toBe("draft");
    expect(planned.proposal.scale).toBe("campaign");
    expect(planned.acts.map((act) => act.title)).toEqual(["Real Business", "Finaer", "Google Ads"]);

    // Una hora de trabajo no merece una campaña.
    await expect(service.planCampaignFromIntent({ intent: "Enviar este correo pendiente.", activeMinutes: 45 })).rejects.toThrow(/una sola Battle/);
  });
});

/**
 * NOTIFICACIONES DIRIGIDAS.
 *
 * El fallo observado: Códice creó dos borradores y la app abrió el segundo
 * cuando el jugador quería el primero. La causa era elegir la entidad con una
 * heurística —«el último», «la actual»— en vez de con el hecho exacto.
 */
describe("Cada hecho apunta a su entidad", () => {
  let directory: string;
  let service: QuestService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "torreon-notify-"));
    const store = new JsonRealmStore(join(directory, "state.json"), fixedClock(RELOJ_DEL_REINO));
    await store.init();
    service = new QuestService(store, undefined, directory, "torreon-notify-test", fixedClock(RELOJ_DEL_REINO));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("dos borradores seguidos generan dos hechos con destinos distintos", async () => {
    const primera = await service.createDraft(planFor("El Oráculo de la Gaceta"));
    const segunda = await service.createDraft(planFor("El Sello de Producción"));

    const events = eventsFor((await service.snapshot()).realm.events, "quest_created");
    expect(events).toHaveLength(2);
    const targets = events.map((event) => event.entityId);
    expect(targets).toEqual(expect.arrayContaining([primera.id, segunda.id]));
    expect(events.every((event) => event.entityType === "quest")).toBe(true);
    // Y ninguno apunta al otro: abrir la primera abre la primera.
    expect(events.find((event) => event.entityId === primera.id)!.message).toContain("El Oráculo de la Gaceta");
  });

  it("el hecho de campaña apunta al campaignId exacto, no a la quest actual", async () => {
    await service.createDraft(planFor("El Oráculo de la Gaceta"));
    const { campaign } = await service.createCampaignDraft({ title: "La Forja de Solve & Coagula" });
    await service.acceptCampaign(campaign.id, true);

    const events = (await service.snapshot()).realm.events;
    const created = eventsFor(events, "campaign_created")[0];
    const accepted = eventsFor(events, "campaign_accepted")[0];
    expect(created.entityType).toBe("campaign");
    expect(created.entityId).toBe(campaign.id);
    expect(created.questId).toBeUndefined();
    expect(accepted.entityId).toBe(campaign.id);
  });

  it("todo hecho registrado sabe a qué entidad pertenece", async () => {
    const quest = await service.createDraft(planFor("El Oráculo de la Gaceta"));
    await service.accept(quest.id, true);
    await service.start(quest.id);
    await service.completeStep(quest.id, quest.steps[0].id, "Frente cerrado");

    const events = (await service.snapshot()).realm.events;
    expect(events.length).toBeGreaterThan(3);
    expect(events.every((event) => Boolean(event.entityType) && Boolean(event.entityId))).toBe(true);
  });
});
