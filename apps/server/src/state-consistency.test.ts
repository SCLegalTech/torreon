import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QuestPlanInput, RealmState } from "./domain.js";
import { backfillEncounter } from "./horde.js";
import { QuestService } from "./quest-service.js";
import { JsonRealmStore } from "./store.js";

/**
 * UNA MIGRACIÓN NO PUEDE RESUCITAR AL ENEMIGO.
 * LO SUSPENDIDO NO PUEDE PARECER ACTIVO.
 *
 * Dos formas de mentir que el reino no puede permitirse: devolverle la vida a
 * una Horda que el jugador ya había derribado a golpes reales, y mostrar un
 * combate vivo cuando el Core ya soltó el frente.
 */

const plan: QuestPlanInput = {
  campaignTitle: "La coherencia del reino",
  title: "El Oráculo de la Gaceta",
  intent: "Probar que el estado no miente.",
  outcome: "El portal queda actualizado y comprobable.",
  rationale: "Lo que el reino dice tiene que ser lo que el reino es.",
  durationMinutes: 55,
  wellbeingConstraints: [],
  allowedApps: [],
  steps: [
    { title: "Leer el estado real", actor: "user", evidence: "Constancia", evidenceKind: "declaration", weight: 90 },
    { title: "Cerrar el frente", actor: "user", evidence: "Constancia", evidenceKind: "declaration", weight: 10 },
  ],
};

describe("Consistencia de estado", () => {
  let directory: string;
  let statePath: string;
  let store: JsonRealmStore;
  let service: QuestService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "torreon-consistency-"));
    statePath = join(directory, "state.json");
    store = new JsonRealmStore(statePath);
    await store.init();
    service = new QuestService(store, undefined, directory, "torreon-consistency-test");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("T1: migrar una Battle al 90% no devuelve la vida a la Horda", async () => {
    const draft = await service.createDraft(plan);
    await service.accept(draft.id, true);
    const active = await service.start(draft.id);
    await service.completeStep(active.id, active.steps[0].id, "Estado real leído");

    const before = await service.snapshot();
    expect(before.battle?.progress).toBe(90);
    const remaining = before.battle!.enemyHealth;
    expect(remaining).toBe(10);

    // Se simula un reino escrito ANTES de que existiera la formación 4v4.
    const raw = JSON.parse(await readFile(statePath, "utf8")) as RealmState;
    delete (raw.quests[0].battle as { enemies?: unknown }).enemies;
    await writeFile(statePath, JSON.stringify(raw, null, 2), "utf8");

    const migrated = await new QuestService(new JsonRealmStore(statePath), undefined, directory, "torreon-consistency-test").snapshot();
    expect(migrated.battle?.enemies).toHaveLength(4);
    // El invariante: la suma de la formación es la vida histórica, no 100.
    expect(migrated.battle!.enemies.reduce((sum, enemy) => sum + enemy.health, 0)).toBe(10);
    expect(migrated.battle?.enemyHealth).toBe(10);
    expect(migrated.battle!.enemies.reduce((sum, enemy) => sum + enemy.maxHealth, 0)).toBe(100);
    // Y nada del historial se toca.
    expect(migrated.battle?.progress).toBe(90);
    expect(migrated.battle?.attempt).toBe(before.battle?.attempt);
  });

  it("T1c: repara una formación que ya había nacido resucitada", async () => {
    const draft = await service.createDraft(plan);
    await service.accept(draft.id, true);
    const active = await service.start(draft.id);
    await service.completeStep(active.id, active.steps[0].id, "Estado real leído");

    // Un despliegue anterior dejó a los cuatro enemigos con su vida entera
    // pese a que el jugador ya había validado 90 puntos de impacto.
    const raw = JSON.parse(await readFile(statePath, "utf8")) as RealmState;
    for (const enemy of raw.quests[0].battle!.enemies) enemy.health = enemy.maxHealth;
    await writeFile(statePath, JSON.stringify(raw, null, 2), "utf8");

    const repaired = await new QuestService(new JsonRealmStore(statePath), undefined, directory, "torreon-consistency-test").snapshot();
    expect(repaired.battle!.enemies.reduce((sum, enemy) => sum + enemy.health, 0)).toBe(10);
    expect(repaired.battle?.progress).toBe(90);
  });

  it("T1b: el backfill reparte la vida restante y deja caídos a los que ya no la tienen", () => {
    const enemies = backfillEncounter("semilla-fija", 10);
    expect(enemies.reduce((sum, enemy) => sum + enemy.health, 0)).toBe(10);
    expect(enemies.some((enemy) => enemy.status === "ko")).toBe(true);
    expect(backfillEncounter("semilla-fija", 0).every((enemy) => enemy.status === "ko")).toBe(true);
    expect(backfillEncounter("semilla-fija", 100).every((enemy) => enemy.health === enemy.maxHealth)).toBe(true);
  });

  it("T2: waiting_external nunca expone una Battle activa", async () => {
    const draft = await service.createDraft(plan);
    await service.accept(draft.id, true);
    const active = await service.start(draft.id);
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
    await service.acceptAmendment(active.id, proposal.id, true);

    const suspended = await service.snapshot();
    expect(suspended.currentQuest?.status).toBe("waiting_external");
    expect(suspended.hierarchy.engagedQuestId).toBeNull();
    // Lo que no puede pasar: quest suspendida y Battle diciendo «active».
    expect(suspended.battle?.status).toBe("suspended_external");
    expect(suspended.battle?.clock?.suspended).toBe(true);
    const node = suspended.hierarchy.standaloneQuests.find((candidate) => candidate.id === active.id);
    expect(node?.battleStatus).toBe("suspended_external");
    // Y la presión está de verdad detenida.
    expect(suspended.realm.gameEvents.filter((event) => event.type === "horde_pressure")).toHaveLength(0);

    // Al desbloquear se reanuda el MISMO combate.
    const healthBefore = suspended.battle!.party.marques.health;
    const enemiesBefore = suspended.battle!.enemies.map((enemy) => `${enemy.id}:${enemy.health}`);
    const unblock = await service.proposeAmendment(active.id, {
      reason: "La contraparte publicó por fin el anexo y el frente vuelve a abrirse.",
      proposedBy: "codice",
      changes: active.steps.map((step) => ({ type: "UNBLOCK_STEP" as const, stepId: step.id, reason: "El anexo ya está publicado." })),
    });
    await service.acceptAmendment(active.id, unblock.id, true);
    const resumed = await service.snapshot();
    expect(resumed.battle?.status).toBe("active");
    expect(resumed.hierarchy.engagedQuestId).toBe(active.id);
    expect(resumed.battle?.party.marques.health).toBe(healthBefore);
    expect(resumed.battle!.enemies.map((enemy) => `${enemy.id}:${enemy.health}`)).toEqual(enemiesBefore);
  });

  it("T4/T5: el toolset describe el juego que existe y no ofrece atajos", async () => {
    // Se lee el contrato tal como lo ve Códice: los textos de las tools.
    const source = await readFile(new URL("./mcp.ts", import.meta.url), "utf8");
    // T4: el modelo de cuatro golpes al 25/50/75/100 ya no existe.
    expect(source).not.toMatch(/25%, 50%, 75%/);
    expect(source).toMatch(/presión es CONTINUA/i);
    // T5: no hay atajo para cerrar un paso sin veredicto razonado.
    expect(source).not.toMatch(/"complete_quest_step"/);
    // Y el foco vuelve a ser operable por Códice.
    expect(source).toMatch(/"focus_campaign"/);
  });

  it("T3: enfocar una campaña no desactiva otras ni inicia ninguna batalla", async () => {
    const a = await service.createCampaignDraft({ title: "Búsqueda laboral" });
    const b = await service.createCampaignDraft({ title: "La Forja de Solve & Coagula" });
    await service.acceptCampaign(a.campaign.id, true);
    await service.acceptCampaign(b.campaign.id, true);

    const focused = await service.focusCampaign(b.campaign.id);
    expect(focused.hierarchy.focusedCampaignId).toBe(b.campaign.id);
    expect(focused.hierarchy.activeCampaignIds).toEqual(expect.arrayContaining([a.campaign.id, b.campaign.id]));
    expect(focused.realm.campaigns.every((campaign) => campaign.status === "active")).toBe(true);
    expect(focused.hierarchy.engagedQuestId).toBeNull();
    expect(focused.battle).toBeNull();

    // Idempotente: repetirlo no cambia nada ni duplica el hecho.
    const again = await service.focusCampaign(b.campaign.id);
    expect(again.hierarchy.focusedCampaignId).toBe(b.campaign.id);
    expect(again.realm.events.filter((event) => event.type === "campaign_focused")).toHaveLength(1);
  });
});
