import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QuestPlanInput } from "./domain.js";
import { buildEncounter, HORDE_POOL, HORDE_TOTAL_HEALTH } from "./horde.js";
import { QuestService } from "./quest-service.js";
import { JsonRealmStore } from "./store.js";
import { fixedClock } from "./clock.js";

/**
 * EL RELOJ ES PARTE DEL ENEMIGO — Y LA HORDA NO DESCANSA.
 *
 * Estas pruebas no miden animaciones: comprueban que el tiempo lo manda el
 * Core, que la presión es continua y atribuible, y que el plazo vencido cierra
 * el intento sin borrar nada.
 */

const plan: QuestPlanInput = {
  campaignTitle: "El asedio del reloj",
  title: "Cruzar la puerta antes del plazo",
  intent: "Probar que el tiempo pactado es parte del enemigo.",
  outcome: "La puerta queda cruzada antes de que venza el plazo.",
  rationale: "Una Battle sin reloj no es una Battle.",
  durationMinutes: 60,
  wellbeingConstraints: [],
  allowedApps: [],
  steps: [
    { title: "Primer empuje", actor: "user", evidence: "Constancia", evidenceKind: "declaration", weight: 40 },
    { title: "Golpe final", actor: "user", evidence: "Constancia", evidenceKind: "declaration", weight: 60 },
  ],
};

describe("El encuentro de la Horda", () => {
  it("genera exactamente cuatro enemigos que suman cien de vida", () => {
    const enemies = buildEncounter("semilla-fija");
    expect(enemies).toHaveLength(4);
    expect(enemies.reduce((sum, enemy) => sum + enemy.maxHealth, 0)).toBe(HORDE_TOTAL_HEALTH);
  });

  it("la misma semilla produce siempre la misma formación", () => {
    const first = buildEncounter("semilla-fija").map((enemy) => enemy.archetypeId);
    expect(buildEncounter("semilla-fija").map((enemy) => enemy.archetypeId)).toEqual(first);
    expect(buildEncounter("otra-semilla").map((enemy) => enemy.archetypeId)).not.toEqual(first);
  });

  it("nunca junta cuatro chamanes: un apoyo, un capitán, y siempre hay frente y retaguardia", () => {
    for (let index = 0; index < 60; index += 1) {
      const enemies = buildEncounter(`semilla-${index}`);
      expect(new Set(enemies.map((enemy) => enemy.archetypeId)).size).toBe(4);
      expect(enemies.filter((enemy) => enemy.role === "support").length).toBeLessThanOrEqual(1);
      const uniques = enemies.filter((enemy) => HORDE_POOL.find((archetype) => archetype.id === enemy.archetypeId)?.unique);
      expect(uniques.length).toBeLessThanOrEqual(1);
      expect(enemies.some((enemy) => enemy.position === "front")).toBe(true);
      expect(enemies.some((enemy) => enemy.position === "back")).toBe(true);
    }
  });
});

describe("Battle con tiempo real", () => {
  let directory: string;
  let store: JsonRealmStore;
  let service: QuestService;

  /**
   * EL RELOJ DEL REINO SE PLANTA (artículo 8, ADR-0006).
   *
   * Estas pruebas medían el reloj de pared y resbalaban bajo carga: la misma
   * prueba pasaba aislada y fallaba en la suite completa. Con el instante
   * inyectado, «pasaron cinco minutos» significa exactamente cinco minutos.
   */
  const INSTANTE = "2026-05-11T09:00:00.000Z";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "torreon-timer-"));
    store = new JsonRealmStore(join(directory, "state.json"), fixedClock(INSTANTE));
    await store.init();
    service = new QuestService(store, undefined, directory, "torreon-timer-test", fixedClock(INSTANTE));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /** Simula que pasó el tiempo sin tocar el reloj del proceso. */
  async function ageBattle(questId: string, minutes: number): Promise<void> {
    await store.mutate((state) => {
      const quest = state.quests.find((candidate) => candidate.id === questId)!;
      const shift = minutes * 60_000;
      quest.battle!.startedAt = new Date(Date.parse(quest.battle!.startedAt) - shift).toISOString();
      quest.battle!.deadlineAt = new Date(Date.parse(quest.battle!.deadlineAt) - shift).toISOString();
      if (quest.battle!.suspendedAt) {
        quest.battle!.suspendedAt = new Date(Date.parse(quest.battle!.suspendedAt) - shift).toISOString();
      }
    });
  }

  async function startedQuest(durationMinutes?: number) {
    const draft = await service.createDraft(plan);
    await service.accept(draft.id, true);
    return service.start(draft.id, durationMinutes);
  }

  it("persiste startedAt y deadlineAt sólo al iniciar la Battle", async () => {
    const draft = await service.createDraft(plan);
    expect(draft.battle).toBeUndefined();

    const accepted = await service.accept(draft.id, true);
    expect(accepted.battle).toBeUndefined();
    // Sin compromiso y sin foco explícito no hay ningún frente que proyectar:
    // el reino no elige una Battle por su cuenta.
    expect((await service.snapshot()).battle).toBeNull();
    // Y mirándola a propósito, el contrato ya se ve pero el reloj sigue quieto.
    expect((await service.focusQuest(draft.id)).battle?.clock).toBeNull();

    const active = await service.start(draft.id, 45);
    expect(active.battle?.durationMinutes).toBe(45);
    expect(Date.parse(active.battle!.deadlineAt) - Date.parse(active.battle!.startedAt)).toBe(45 * 60_000);
    // La formación nace con la Battle, no con la primera consulta.
    expect(active.battle?.enemies).toHaveLength(4);
    expect(active.battle?.agent.deployed).toBe(false);

    const snapshot = await service.snapshot();
    expect(snapshot.battle?.status).toBe("active");
    expect(snapshot.battle?.clock?.remainingMs).toBeGreaterThan(44 * 60_000);
  });

  it("una Battle nunca puede pactar más de 60 minutos", async () => {
    await expect(service.createDraft({ ...plan, durationMinutes: 90 })).rejects.toThrow(/60 minutos/);
    const active = await startedQuest(600);
    expect(active.battle?.durationMinutes).toBe(60);
  });

  it("cerrar la app no congela el tiempo: el Core lo recalcula al volver", async () => {
    const active = await startedQuest(60);
    await ageBattle(active.id, 20);

    const snapshot = await service.snapshot();
    expect(snapshot.battle!.clock!.elapsedMs).toBeGreaterThanOrEqual(20 * 60_000);
    expect(snapshot.battle!.clock!.remainingMs).toBeLessThanOrEqual(40 * 60_000);
  });

  it("la presión es continua y atribuible, y no se cobra dos veces", async () => {
    const active = await startedQuest(60);
    await ageBattle(active.id, 5);

    const first = await service.snapshot();
    const pressure = first.realm.gameEvents.filter((event) => event.type === "horde_pressure");
    // Una ventana por minuto de reloj activo, no un golpe cada cinco minutos.
    expect(pressure).toHaveLength(5);
    const party = first.battle!.party;
    const lost = 300 - party.roko.health - party.marques.health - party.cordera.health + (20 - (party.roko.shield ?? 0));
    expect(lost).toBeGreaterThan(0);
    // Cada línea dice quién golpeó y a quién.
    expect(pressure[0].allocations?.every((entry) => Boolean(entry.sourceName) && Boolean(entry.target))).toBe(true);

    // Consultar más veces no cambia el HP autoritativo.
    await service.snapshot();
    await service.snapshot();
    const again = await service.snapshot();
    expect(again.realm.gameEvents.filter((event) => event.type === "horde_pressure")).toHaveLength(5);
    expect(again.battle!.party.roko.health).toBe(party.roko.health);
    expect(again.battle!.party.marques.health).toBe(party.marques.health);
  });

  it("Roko aguanta más, pero no lo aguanta todo", async () => {
    const active = await startedQuest(60);
    await ageBattle(active.id, 25);
    const party = (await service.snapshot()).battle!.party;
    const untouched = [party.marques, party.cordera].filter((member) => member.health === member.maxHealth);
    expect(untouched.length).toBeLessThan(2);
    expect(party.roko.shield).toBeLessThan(20);
  });

  it("la secuencia de presión es reproducible: reabrir no vuelve a tirar el dado", async () => {
    const active = await startedQuest(60);
    await ageBattle(active.id, 6);
    const first = await service.snapshot();
    const signature = (snapshot: typeof first) =>
      snapshot.realm.gameEvents
        .filter((event) => event.type === "horde_pressure")
        .map((event) => `${event.attackIndex}:${event.damage}:${event.critical}`)
        .join("|");
    const before = signature(first);
    expect(before.length).toBeGreaterThan(0);
    expect(signature(await service.snapshot())).toBe(before);
  });

  it("el plazo vencido con la Horda viva cierra el intento sin borrar nada", async () => {
    const active = await startedQuest(60);
    await service.completeStep(active.id, active.steps[0].id, "Primer empuje entregado");
    await ageBattle(active.id, 61);

    const snapshot = await service.snapshot();
    expect(snapshot.battle?.clock?.expired).toBe(true);
    expect(snapshot.battle?.status).toBe("awaiting_replan");
    // El frente sigue abierto: el impacto validado permanece.
    expect(snapshot.battle?.progress).toBe(40);
    expect(snapshot.realm.gameEvents.some((event) => event.type === "battle_lost")).toBe(true);

    await expect(service.completeStep(active.id, active.steps[1].id, "Tarde")).rejects.toThrow(/intento se cerró/);
  });

  it("neutralizar a toda la Horda detiene la presión, y el contrato firma la victoria", async () => {
    const active = await startedQuest(60);
    await service.completeStep(active.id, active.steps[0].id, "Primer empuje");
    const partial = await service.snapshot();
    // 40 de impacto ya deberían haber tumbado a alguien de la formación.
    expect(partial.battle!.enemies.some((enemy) => enemy.status === "ko")).toBe(true);
    expect(partial.battle?.status).toBe("active");

    await service.completeStep(active.id, active.steps[1].id, "Golpe final");
    const won = await service.snapshot();
    expect(won.battle?.hordeNeutralized).toBe(true);
    expect(won.battle?.status).toBe("won");
    expect(won.realm.quests[0].status).toBe("completed");

    await ageBattle(active.id, 120);
    const later = await service.snapshot();
    expect(later.battle?.party.marques.health).toBe(won.battle?.party.marques.health);
  });

  it("waiting_external suspende la presión temporal sin ningún botón de pausa", async () => {
    const active = await startedQuest(60);
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

    await service.snapshot();
    await ageBattle(active.id, 40);

    const suspended = await service.snapshot();
    expect(suspended.battle?.clock?.suspended).toBe(true);
    expect(suspended.realm.gameEvents.filter((event) => event.type === "horde_pressure")).toHaveLength(0);
    expect(suspended.battle?.party.marques.health).toBe(100);
  });
});
