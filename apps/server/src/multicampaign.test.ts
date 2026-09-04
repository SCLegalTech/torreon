import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QuestPlanInput } from "./domain.js";
import { QuestService } from "./quest-service.js";
import { JsonRealmStore } from "./store.js";

/**
 * MANY CAMPAIGNS. ONE ENGAGED BATTLE.
 *
 * El jugador sostiene trabajo, firma, desarrollo y vida personal a la vez. Lo
 * que no puede es tener dos relojes corriendo: varios frentes no lo matan
 * simultáneamente.
 */

function planFor(title: string, minutes = 30): QuestPlanInput {
  return {
    campaignTitle: title,
    title,
    intent: `Avanzar ${title}.`,
    outcome: `${title} queda cerrado de forma verificable.`,
    rationale: "Un frente por vez, pero varios frentes vivos.",
    durationMinutes: minutes,
    wellbeingConstraints: [],
    allowedApps: [],
    steps: [
      { title: "Primer empuje", actor: "user", evidence: "Constancia", evidenceKind: "declaration", weight: 40 },
      { title: "Golpe final", actor: "user", evidence: "Constancia", evidenceKind: "declaration", weight: 60 },
    ],
  };
}

describe("Multicampaña y frente único", () => {
  let directory: string;
  let service: QuestService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "torreon-multi-"));
    const store = new JsonRealmStore(join(directory, "state.json"));
    await store.init();
    service = new QuestService(store, undefined, directory, "torreon-multi-test");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function campaignWithQuest(title: string) {
    const { campaign } = await service.createCampaignDraft({ title });
    await service.acceptCampaign(campaign.id, true);
    const act = await service.createAct({ title: `Acto de ${title}`, campaignId: campaign.id });
    const quest = await service.createDraft(planFor(title), { actId: act.id });
    return { campaign, act, quest };
  }

  it("tres campañas pueden estar activas a la vez", async () => {
    const trabajo = await campaignWithQuest("Búsqueda laboral");
    const firma = await campaignWithQuest("Solve & Coagula");
    const torreon = await campaignWithQuest("Torreón");

    const snapshot = await service.snapshot();
    expect(snapshot.hierarchy.activeCampaignIds).toHaveLength(3);
    expect(snapshot.hierarchy.activeCampaignIds).toEqual(
      expect.arrayContaining([trabajo.campaign.id, firma.campaign.id, torreon.campaign.id]),
    );
    expect(snapshot.realm.quests).toHaveLength(3);
  });

  it("cambiar la campaña en foco no cierra ni reinicia las demás", async () => {
    const trabajo = await campaignWithQuest("Búsqueda laboral");
    const firma = await campaignWithQuest("Solve & Coagula");

    const focused = await service.focusCampaign(firma.campaign.id);
    expect(focused.hierarchy.focusedCampaignId).toBe(firma.campaign.id);
    expect(focused.hierarchy.activeCampaignIds).toHaveLength(2);
    expect(focused.realm.campaigns.every((campaign) => campaign.status === "active")).toBe(true);
    // ENFOCAR UNA CAMPAÑA ES MOVER LA MIRADA, NO ELEGIR UN FRENTE.
    // Cuando además elegía «la quest accionable de esa campaña», un frente que
    // el jugador había dejado en pausa volvía a presentarse como la batalla
    // vigente en cada lectura y bloqueaba abrir otro.
    expect(focused.battleQuestId).toBeNull();
    expect(focused.battle).toBeNull();

    const back = await service.focusCampaign(trabajo.campaign.id);
    expect(back.battleQuestId).toBeNull();
    expect(back.realm.quests.find((quest) => quest.id === firma.quest.id)?.status).toBe("draft");
  });

  it("con una Battle comprometida, otra quest puede consultarse pero no iniciar", async () => {
    const trabajo = await campaignWithQuest("Búsqueda laboral");
    const firma = await campaignWithQuest("Solve & Coagula");

    await service.accept(trabajo.quest.id, true);
    await service.start(trabajo.quest.id);
    await service.accept(firma.quest.id, true);

    // Consultarla sí: el contrato sigue siendo legible.
    expect((await service.questDetail(firma.quest.id)).status).toBe("accepted");
    await expect(service.start(firma.quest.id)).rejects.toThrow(/Battle comprometida/);

    const snapshot = await service.snapshot();
    expect(snapshot.hierarchy.engagedQuestId).toBe(trabajo.quest.id);
    // El frente comprometido manda sobre el foco: es lo que exige atención.
    await service.focusCampaign(firma.campaign.id);
    expect((await service.snapshot()).currentQuest?.id).toBe(trabajo.quest.id);
  });

  it("terminar la Battle libera el frente", async () => {
    const trabajo = await campaignWithQuest("Búsqueda laboral");
    const firma = await campaignWithQuest("Solve & Coagula");

    await service.accept(trabajo.quest.id, true);
    await service.start(trabajo.quest.id);
    for (const step of trabajo.quest.steps) {
      await service.completeStep(trabajo.quest.id, step.id, `Evidencia de ${step.title}`);
    }
    expect((await service.snapshot()).hierarchy.engagedQuestId).toBeNull();

    await service.accept(firma.quest.id, true);
    const second = await service.start(firma.quest.id);
    expect(second.battle?.status).toBe("active");
    expect((await service.snapshot()).hierarchy.engagedQuestId).toBe(firma.quest.id);
  });

  it("una espera externa legítima libera el frente sin cerrar la quest", async () => {
    const trabajo = await campaignWithQuest("Búsqueda laboral");
    const firma = await campaignWithQuest("Solve & Coagula");

    await service.accept(trabajo.quest.id, true);
    const active = await service.start(trabajo.quest.id);
    const proposal = await service.proposeAmendment(active.id, {
      reason: "La contraparte todavía no publicó el anexo que este frente necesita.",
      proposedBy: "codice",
      changes: active.steps.map((step) => ({
        type: "MARK_EXTERNAL_BLOCKER" as const,
        stepId: step.id,
        blockedBy: "Contraparte",
        blockedReason: "Debe publicar el anexo antes de poder continuar.",
        playerActionAvailable: false,
      })),
    });
    const amended = await service.acceptAmendment(active.id, proposal.id, true);
    expect(amended.quest.status).toBe("waiting_external");
    expect((await service.snapshot()).hierarchy.engagedQuestId).toBeNull();

    await service.accept(firma.quest.id, true);
    await service.start(firma.quest.id);
    expect((await service.snapshot()).hierarchy.engagedQuestId).toBe(firma.quest.id);
  });

  it("la Battle empieza con Roko, Marqués y Cordera en pie", async () => {
    const trabajo = await campaignWithQuest("Búsqueda laboral");
    await service.accept(trabajo.quest.id, true);
    await service.start(trabajo.quest.id);

    const battle = (await service.snapshot()).battle!;
    expect(battle.party.roko).toMatchObject({ health: 100, shield: 20, maxShield: 20, status: "active" });
    expect(battle.party.marques).toMatchObject({ health: 100, status: "active" });
    expect(battle.party.cordera).toMatchObject({ health: 100, status: "active" });
    expect(battle.party.marques.shield).toBeUndefined();
  });

  it("Cordera KO deja de curar y ni la cura ni el escudo pasan de su máximo", async () => {
    const trabajo = await campaignWithQuest("Búsqueda laboral");
    await service.accept(trabajo.quest.id, true);
    const active = await service.start(trabajo.quest.id);

    // El grupo intacto no puede curarse por encima del máximo.
    await service.completeStep(active.id, active.steps[0].id, "Primer empuje entregado");
    const full = await service.snapshot();
    expect(full.battle?.party.marques.health).toBe(100);
    expect(full.battle?.party.roko.shield).toBe(20);
    expect(full.realm.gameEvents.some((event) => event.type === "party_heal")).toBe(false);
  });
});
