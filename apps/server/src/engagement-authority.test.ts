import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QuestPlanInput } from "./domain.js";
import { QuestService } from "./quest-service.js";
import { JsonRealmStore } from "./store.js";

/**
 * FOCUS IS NOT ENGAGEMENT. LEGACY STATE MUST NOT CONTROL THE PLAYER.
 *
 * El caso real: «El Archivo del Coloso I» quedó con su frente abierto —el
 * Marqués caído— dentro de la campaña que el jugador tenía en foco. Ninguna
 * Battle corría. Pero la proyección legada elegía «la quest accionable de la
 * campaña en foco», así que en CADA lectura Coloso volvía a presentarse como la
 * batalla vigente, y «La Puerta de Bigle» no podía abrirse.
 *
 * Estas pruebas fijan la autoridad: la Battle visible es la comprometida o la
 * que el jugador enfocó A MANO. Nada más la elige.
 */

function planNamed(title: string): QuestPlanInput {
  return {
    campaignTitle: "",
    title,
    intent: `Probar la autoridad del frente en ${title}.`,
    outcome: "El frente queda donde el jugador lo dejó.",
    rationale: "Un frente en pausa no se reabre solo.",
    durationMinutes: 25,
    wellbeingConstraints: [],
    allowedApps: [],
    steps: [
      { title: "Primer tramo", actor: "user", evidence: "Constancia", evidenceKind: "declaration", weight: 40 },
      { title: "Tramo final", actor: "user", evidence: "Constancia", evidenceKind: "declaration", weight: 60 },
    ],
  };
}

describe("Autoridad del frente", () => {
  let directory: string;
  let store: JsonRealmStore;
  let service: QuestService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "torreon-engagement-"));
    store = new JsonRealmStore(join(directory, "state.json"));
    await store.init();
    service = new QuestService(store, undefined, directory, "torreon-engagement-test");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /**
   * Reproduce el reino real: Coloso dentro de la campaña EN FOCO, con su frente
   * abierto y el Marqués caído; Bigle en otra campaña, también con frente
   * abierto; y ninguna Battle corriendo.
   */
  async function realmWithColosoAndBigle(): Promise<{ coloso: string; bigle: string; colosoCampaign: string }> {
    const forja = await service.createCampaignDraft({ title: "La Forja de Solve & Coagula" });
    await service.acceptCampaign(forja.campaign.id, true);
    const mercado = await service.createCampaignDraft({ title: "La Conquista del Mercado Remoto" });
    await service.acceptCampaign(mercado.campaign.id, true);

    const bigle = await service.createDraft(planNamed("La Puerta de Bigle"), { campaignId: mercado.campaign.id });
    await service.accept(bigle.id, true);
    await service.start(bigle.id);
    // El plazo de Bigle venció: el frente sigue abierto, sin reloj.
    await store.mutate((state) => {
      const battle = state.quests.find((quest) => quest.id === bigle.id)!.battle!;
      battle.status = "awaiting_replan";
      battle.endedAt = new Date().toISOString();
    });

    const coloso = await service.createDraft(planNamed("El Archivo del Coloso I"), { campaignId: forja.campaign.id });
    await service.accept(coloso.id, true);
    await service.start(coloso.id);
    // El Marqués cayó en Coloso: frente abierto, sin reloj.
    await store.mutate((state) => {
      const battle = state.quests.find((quest) => quest.id === coloso.id)!.battle!;
      battle.party.marques.health = 0;
      battle.party.marques.status = "ko";
      battle.status = "awaiting_recovery";
      battle.endedAt = new Date().toISOString();
    });

    // El jugador estaba mirando la campaña de Coloso, y soltó el foco de quest.
    await service.focusCampaign(forja.campaign.id);
    await service.focusQuest(null);

    return { coloso: coloso.id, bigle: bigle.id, colosoCampaign: forja.campaign.id };
  }

  it("CASO A: Coloso no resucita al hidratar ni al pollear", async () => {
    const { coloso, colosoCampaign } = await realmWithColosoAndBigle();

    // Varias lecturas seguidas: exactamente lo que hace el polling de la app.
    for (let poll = 0; poll < 3; poll += 1) {
      const snapshot = await service.snapshot();
      expect(snapshot.hierarchy.engagedQuestId).toBeNull();
      expect(snapshot.battleQuestId).toBeNull();
      expect(snapshot.battle).toBeNull();
      // La campaña sigue en foco: mirar una campaña es navegación, no combate.
      expect(snapshot.hierarchy.focusedCampaignId).toBe(colosoCampaign);
    }

    // Y Coloso conserva intacto todo lo suyo.
    const stored = (await store.read()).quests.find((quest) => quest.id === coloso)!;
    expect(stored.status).toBe("active");
    expect(stored.battle!.status).toBe("awaiting_recovery");
  });

  it("CASO B: iniciar Bigle lo engancha a él y Coloso no pierde nada", async () => {
    const { coloso, bigle } = await realmWithColosoAndBigle();
    const colosoBefore = (await store.read()).quests.find((quest) => quest.id === coloso)!;

    // Bigle vuelve al frente: replanificar es su forma legítima de reabrirse.
    await service.retryBattle(bigle);

    const snapshot = await service.snapshot();
    expect(snapshot.hierarchy.engagedQuestId).toBe(bigle);
    expect(snapshot.battleQuestId).toBe(bigle);
    expect(snapshot.battle!.questId).toBe(bigle);
    expect(snapshot.currentQuest!.id).toBe(bigle);

    // ATOMICIDAD: ninguna proyección se quedó mostrando Coloso.
    expect(snapshot.battleQuest!.id).toBe(bigle);
    expect(snapshot.engagedQuest!.id).toBe(bigle);

    const colosoAfter = (await store.read()).quests.find((quest) => quest.id === coloso)!;
    expect(colosoAfter.status).toBe(colosoBefore.status);
    expect(colosoAfter.steps.map((step) => step.impactAwarded)).toEqual(colosoBefore.steps.map((step) => step.impactAwarded));
    expect(colosoAfter.battle!.attempts).toHaveLength(colosoBefore.battle!.attempts.length);
    expect(colosoAfter.battle!.party.marques.health).toBe(0);
  });

  it("CASO C: el legado no bloquea — una Quest sin dependencias puede iniciarse", async () => {
    const { coloso } = await realmWithColosoAndBigle();
    // Una Quest nueva, aceptada, sin ninguna dependencia declarada.
    const nueva = await service.createDraft(planNamed("El Sello de la Señal"));
    await service.accept(nueva.id, true);

    const before = await service.snapshot();
    const node = before.hierarchy.standaloneQuests.find((candidate) => candidate.id === nueva.id)!;
    expect(node.locked).toBe(false);
    // Ningún frente tiene el reloj, así que nada impide comprometer éste.
    expect(before.hierarchy.engagedQuestId).toBeNull();

    await service.start(nueva.id);
    const after = await service.snapshot();
    expect(after.battleQuestId).toBe(nueva.id);
    expect((await store.read()).quests.find((quest) => quest.id === coloso)!.status).toBe("active");
  });

  it("CASO D: tras recargar, la Battle visible sigue siendo la comprometida", async () => {
    const { coloso, bigle } = await realmWithColosoAndBigle();
    await service.retryBattle(bigle);

    // Otra instancia del servicio sobre el MISMO archivo: eso es recargar.
    const rehydrated = new QuestService(
      new JsonRealmStore(join(directory, "state.json")),
      undefined,
      directory,
      "torreon-engagement-test",
    );
    const snapshot = await rehydrated.snapshot();
    expect(snapshot.battleQuestId).toBe(bigle);
    expect(snapshot.battle!.questId).toBe(bigle);
    expect(snapshot.battle!.status).toBe("active");
    expect(snapshot.realm.quests.find((quest) => quest.id === coloso)!.battle!.status).toBe("awaiting_recovery");
  });

  it("CASO E: enfocar a mano es la ÚNICA forma de volver a mirar un frente en pausa", async () => {
    const { coloso, bigle } = await realmWithColosoAndBigle();

    // El jugador abre Coloso a propósito.
    const looking = await service.focusQuest(coloso);
    expect(looking.battleQuestId).toBe(coloso);
    expect(looking.battle!.status).toBe("awaiting_recovery");

    // Y al mirar Bigle, la proyección se mueve entera con él.
    const moved = await service.focusQuest(bigle);
    expect(moved.battleQuestId).toBe(bigle);
    expect(moved.battle!.questId).toBe(bigle);
    expect(moved.battle!.status).toBe("awaiting_replan");
  });

  it("CASO F: el frente COMPROMETIDO manda sobre el foco, siempre", async () => {
    const { coloso, bigle } = await realmWithColosoAndBigle();
    await service.retryBattle(bigle);

    // Aunque el jugador enfoque Coloso, el reloj de Bigle es el que corre.
    const snapshot = await service.focusQuest(coloso);
    expect(snapshot.hierarchy.engagedQuestId).toBe(bigle);
    expect(snapshot.battleQuestId).toBe(bigle);
    expect(snapshot.focusedQuest!.id).toBe(coloso);
  });
});
