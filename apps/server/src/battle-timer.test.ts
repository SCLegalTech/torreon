import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QuestPlanInput } from "./domain.js";
import { QuestService } from "./quest-service.js";
import { JsonRealmStore } from "./store.js";

/**
 * EL RELOJ ES PARTE DEL ENEMIGO.
 *
 * Estas pruebas no miden animaciones: comprueban que el tiempo lo manda el
 * Core. Cerrar la app no congela nada, cada umbral cobra una sola vez y el
 * plazo vencido con la Horda viva es una derrota, no un aviso.
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

describe("Battle con tiempo real", () => {
  let directory: string;
  let store: JsonRealmStore;
  let service: QuestService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "torreon-timer-"));
    store = new JsonRealmStore(join(directory, "state.json"));
    await store.init();
    service = new QuestService(store, undefined, directory, "torreon-timer-test");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /** Simula que pasó el tiempo sin tocar el reloj del proceso: envejece la Battle. */
  async function ageBattle(questId: string, minutes: number): Promise<void> {
    await store.mutate((state) => {
      const quest = state.quests.find((candidate) => candidate.id === questId)!;
      const shift = minutes * 60_000;
      quest.battle!.startedAt = new Date(Date.parse(quest.battle!.startedAt) - shift).toISOString();
      quest.battle!.deadlineAt = new Date(Date.parse(quest.battle!.deadlineAt) - shift).toISOString();
      // Envejecer el mundo, no sólo el inicio: una suspensión abierta también corre.
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
    expect((await service.snapshot()).battle?.clock).toBeNull();

    const active = await service.start(draft.id, 45);
    expect(active.battle?.startedAt).toBeTruthy();
    expect(active.battle?.durationMinutes).toBe(45);
    expect(Date.parse(active.battle!.deadlineAt) - Date.parse(active.battle!.startedAt)).toBe(45 * 60_000);

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

  it("cruzar una ventana hace que la Horda ataque exactamente una vez, aunque se refresque", async () => {
    const active = await startedQuest(60);
    // Diez ventanas en 60 min: una cada 6. A los 7 sólo venció la primera.
    await ageBattle(active.id, 7);

    const first = await service.snapshot();
    const attacks = first.realm.gameEvents.filter((event) => event.type === "horde_attack" && event.reason === "time_pressure");
    expect(attacks).toHaveLength(1);
    expect(attacks[0].attackIndex).toBe(1);
    expect([10, 15]).toContain(attacks[0].damage);
    // ROKO PROTEGE: el primer golpe lo come su escudo, no el Marqués.
    expect(attacks[0].target).toBe("roko");
    expect(first.battle?.party.marques.health).toBe(100);

    // Polling y recargas no pueden repetir la misma ventana.
    await service.snapshot();
    await service.snapshot();
    const again = await service.snapshot();
    expect(again.realm.gameEvents.filter((event) => event.reason === "time_pressure")).toHaveLength(1);
    expect(again.battle?.party.roko.shield).toBe(first.battle?.party.roko.shield);
  });

  it("la secuencia de críticos es reproducible: reabrir no vuelve a tirar el dado", async () => {
    const active = await startedQuest(60);
    await ageBattle(active.id, 46);
    const first = await service.snapshot();
    const sequence = (snapshot: typeof first) =>
      snapshot.realm.gameEvents
        .filter((event) => event.reason === "time_pressure")
        .sort((a, b) => (a.attackIndex ?? 0) - (b.attackIndex ?? 0))
        .map((event) => `${event.attackIndex}:${event.damage}:${event.critical}`);

    const before = sequence(first);
    expect(before).toHaveLength(7);
    // Un crítico multiplica por 1.5 y nada más: 10 o 15, nunca otra cosa.
    expect(before.every((entry) => entry.includes(":10:false") || entry.includes(":15:true"))).toBe(true);

    // Releer el reino no reroll: la semilla manda.
    expect(sequence(await service.snapshot())).toEqual(before);
  });

  it("cobra de una sola vez todas las ventanas vencidas mientras la app estaba cerrada", async () => {
    const active = await startedQuest(60);
    await ageBattle(active.id, 46);

    const snapshot = await service.snapshot();
    const indices = snapshot.realm.gameEvents
      .filter((event) => event.reason === "time_pressure")
      .map((event) => event.attackIndex)
      .sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(indices).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(snapshot.battle?.status).toBe("active");
    // El escudo de Roko se consumió antes que su vida.
    expect(snapshot.battle?.party.roko.shield).toBe(0);
    expect(snapshot.battle?.party.roko.health).toBeLessThan(100);
  });

  it("Roko KO no termina la Battle; el Marqués KO sí", async () => {
    const active = await startedQuest(60);
    // 120 de daño consumen escudo y vida de Roko sin tocar al Marqués.
    for (let index = 0; index < 3; index += 1) {
      await service.recordUnexpectedRequirement(active.id, {
        reason: "La contraparte exigió un requisito que no estaba en el pacto.",
        damage: 40,
      });
    }
    const fallen = await service.snapshot();
    expect(fallen.battle?.party.roko.status).toBe("ko");
    expect(fallen.battle?.status).toBe("active");

    // Ahora los golpes caen sobre el Marqués, y su caída sí pierde la Battle.
    for (let index = 0; index < 3; index += 1) {
      await service.recordUnexpectedRequirement(active.id, {
        reason: "La contraparte exigió un requisito que no estaba en el pacto.",
        damage: 40,
      });
    }
    const lost = await service.snapshot();
    expect(lost.battle?.party.marques.status).toBe("ko");
    expect(lost.battle?.status).toBe("lost");
  });

  it("el progreso validado ataca, cura y devuelve escudo; el rechazo no", async () => {
    const active = await startedQuest(60);
    await service.recordUnexpectedRequirement(active.id, {
      reason: "La contraparte exigió un requisito que no estaba en el pacto.",
      damage: 25,
    });
    const hurt = await service.snapshot();
    expect(hurt.battle?.party.roko.shield).toBe(0);
    expect(hurt.battle?.party.roko.health).toBe(95);

    await service.submitEvidence(active.id, active.steps[0].id, {
      summary: "Nada que mostrar todavía.",
      source: "user_declaration",
      verdict: "rejected",
      reasoning: "No llegó ninguna prueba de lo pactado.",
      impactAwarded: 0,
    });
    const afterRejected = await service.snapshot();
    expect(afterRejected.realm.gameEvents.some((event) => event.type === "party_heal")).toBe(false);
    expect(afterRejected.realm.gameEvents.some((event) => event.type === "shield_gained")).toBe(false);

    await service.completeStep(active.id, active.steps[0].id, "Primer empuje entregado");
    const healed = await service.snapshot();
    expect(healed.battle?.party.roko.shield).toBe(5);
    expect(healed.battle?.party.roko.health).toBe(100);
    expect(healed.battle?.enemyHealth).toBe(60);
    expect(healed.realm.gameEvents.filter((event) => event.type === "party_heal")).toHaveLength(1);
    expect(healed.realm.gameEvents.filter((event) => event.type === "shield_gained")).toHaveLength(1);
  });

  it("el plazo vencido con la Horda viva deja al Marqués en KO y la Battle perdida", async () => {
    const active = await startedQuest(60);
    await service.completeStep(active.id, active.steps[0].id, "Primer empuje entregado");
    await ageBattle(active.id, 61);

    const snapshot = await service.snapshot();
    // El plazo vencido con la Horda viva pierde la Battle aunque el grupo viva.
    expect(snapshot.battle?.clock?.expired).toBe(true);
    expect(snapshot.battle?.status).toBe("lost");
    // Perder no borra nada: el impacto validado sigue en pie.
    expect(snapshot.battle?.progress).toBe(40);
    expect(snapshot.realm.gameEvents.some((event) => event.type === "battle_lost")).toBe(true);

    await expect(service.completeStep(active.id, active.steps[1].id, "Tarde")).rejects.toThrow(/tiempo pactado/);
  });

  it("matar a la Horda antes del plazo gana la Battle y detiene los ataques del reloj", async () => {
    const active = await startedQuest(60);
    await service.completeStep(active.id, active.steps[0].id, "Primer empuje");
    await service.completeStep(active.id, active.steps[1].id, "Golpe final");

    const won = await service.snapshot();
    expect(won.battle?.isKo).toBe(true);
    expect(won.battle?.status).toBe("won");
    expect(won.realm.gameEvents.some((event) => event.type === "battle_won")).toBe(true);

    await ageBattle(active.id, 120);
    const later = await service.snapshot();
    expect(later.realm.gameEvents.filter((event) => event.reason === "time_pressure")).toHaveLength(0);
    expect(later.battle?.playerHealth).toBe(100);
  });

  it("waiting_external suspende la presión temporal sin ningún botón de pausa", async () => {
    const active = await startedQuest(60);
    const proposal = await service.proposeAmendment(active.id, {
      reason: "La contraparte todavía no publicó el anexo que este frente necesita.",
      proposedBy: "codice",
      changes: [
        {
          type: "MARK_EXTERNAL_BLOCKER",
          stepId: active.steps[0].id,
          blockedBy: "Contraparte",
          blockedReason: "Debe publicar el anexo antes de poder continuar.",
          playerActionAvailable: false,
        },
        {
          type: "MARK_EXTERNAL_BLOCKER",
          stepId: active.steps[1].id,
          blockedBy: "Contraparte",
          blockedReason: "Depende del anexo anterior.",
          playerActionAvailable: false,
        },
      ],
    });
    const amended = await service.acceptAmendment(active.id, proposal.id, true);
    expect(amended.quest.status).toBe("waiting_external");

    await service.snapshot();
    await ageBattle(active.id, 40);

    const suspended = await service.snapshot();
    expect(suspended.battle?.clock?.suspended).toBe(true);
    expect(suspended.realm.gameEvents.filter((event) => event.reason === "time_pressure")).toHaveLength(0);
    expect(suspended.battle?.playerHealth).toBe(100);
  });

  it("reintentar una Battle perdida devuelve reloj y HP sin borrar el impacto validado", async () => {
    const active = await startedQuest(60);
    await service.completeStep(active.id, active.steps[0].id, "Primer empuje entregado");
    await ageBattle(active.id, 61);
    await service.snapshot();

    const retried = await service.retryBattle(active.id, 30);
    expect(retried.battle.status).toBe("active");
    expect(retried.battle.attempt).toBe(2);
    expect(retried.battle.playerHealth).toBe(100);
    // La Horda conserva el daño que ya recibió: la evidencia no se borra.
    expect(retried.battle.enemyHealth).toBe(60);
    expect(retried.battle.durationMinutes).toBe(30);
  });
});
