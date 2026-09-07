import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QuestPlanInput } from "./domain.js";
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
 * REPLANIFICAR NO BORRA LAS CICATRICES.
 *
 * El tiempo puede repactarse. El progreso permanece. El daño permanece. Los
 * caídos permanecen caídos. Los objetos se gastan. Y los aliados sólo ayudan
 * si realmente lucharon.
 */

const plan: QuestPlanInput = {
  campaignTitle: "La continuidad del frente",
  title: "Sostener lo empezado",
  intent: "Probar que un replan no cura gratis.",
  outcome: "El frente queda cerrado con lo que costó.",
  rationale: "Las consecuencias reales persisten.",
  durationMinutes: 60,
  wellbeingConstraints: [],
  allowedApps: [],
  steps: [
    { title: "Primer empuje", actor: "user", evidence: "Constancia", evidenceKind: "declaration", weight: 40 },
    { title: "Golpe final", actor: "user", evidence: "Constancia", evidenceKind: "declaration", weight: 60 },
  ],
};

describe("Continuidad entre intentos", () => {
  let directory: string;
  let store: JsonRealmStore;
  let service: QuestService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "torreon-continuity-"));
    store = new JsonRealmStore(join(directory, "state.json"), fixedClock(RELOJ_DEL_REINO));
    await store.init();
    service = new QuestService(store, undefined, directory, "torreon-continuity-test", fixedClock(RELOJ_DEL_REINO));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function ageBattle(questId: string, minutes: number): Promise<void> {
    await store.mutate((state) => {
      const battle = state.quests.find((candidate) => candidate.id === questId)!.battle!;
      const shift = minutes * 60_000;
      battle.startedAt = new Date(Date.parse(battle.startedAt) - shift).toISOString();
      battle.deadlineAt = new Date(Date.parse(battle.deadlineAt) - shift).toISOString();
    });
  }

  /** Deja al grupo herido sin depender del azar de la formación. */
  async function wound(questId: string, roko: number, marques: number, cordera: number, shield = 0): Promise<void> {
    await store.mutate((state) => {
      const party = state.quests.find((candidate) => candidate.id === questId)!.battle!.party;
      party.roko.health = roko;
      party.roko.shield = shield;
      party.roko.status = roko === 0 ? "ko" : "active";
      party.marques.health = marques;
      party.marques.status = marques === 0 ? "ko" : "active";
      party.cordera.health = cordera;
      party.cordera.status = cordera === 0 ? "ko" : "active";
    });
  }

  async function startedQuest(durationMinutes?: number) {
    const draft = await service.createDraft(plan);
    await service.accept(draft.id, true);
    return service.start(draft.id, durationMinutes);
  }

  it("replanificar conserva progreso, Horda, heridas, escudo y formación", async () => {
    const active = await startedQuest(60);
    await service.completeStep(active.id, active.steps[0].id, "Primer empuje entregado");

    // Se deja vencer el plazo y sólo entonces se fija el estado del grupo:
    // lo que se prueba es que el replan lo respeta tal cual quedó.
    await ageBattle(active.id, 61);
    expect((await service.snapshot()).battle?.status).toBe("awaiting_replan");
    await wound(active.id, 12, 72, 80, 3);
    const before = await service.snapshot();
    const enemiesBefore = before.battle!.enemies.map((enemy) => `${enemy.id}:${enemy.health}`);

    const retried = await service.retryBattle(active.id, 30);
    expect(retried.battle.attempt).toBe(2);
    expect(retried.battle.durationMinutes).toBe(30);
    // R-001/R-002/R-003: nada de esto se cura solo.
    expect(retried.battle.progress).toBe(40);
    expect(retried.battle.enemies.map((enemy) => `${enemy.id}:${enemy.health}`)).toEqual(enemiesBefore);
    expect(retried.battle.party.roko.health).toBe(12);
    expect(retried.battle.party.roko.shield).toBe(3);
    expect(retried.battle.party.marques.health).toBe(72);
    expect(retried.battle.party.cordera.health).toBe(80);
    // El intento anterior queda registrado con su motivo.
    expect(retried.battle.attempts[0].endReason).toBe("timeout");
  });

  it("un caído sigue caído tras replanificar, y el Marqués bloquea el reintento", async () => {
    const active = await startedQuest(60);
    await ageBattle(active.id, 61);
    await service.snapshot();
    await wound(active.id, 0, 60, 90);

    // R-004: Roko KO sigue KO.
    const retried = await service.retryBattle(active.id, 20);
    expect(retried.battle.party.roko.health).toBe(0);
    expect(retried.battle.party.roko.status).toBe("ko");
    expect(retried.battle.status).toBe("active");

    // R-005: con el Marqués en el suelo no se abre otro intento.
    await wound(active.id, 0, 0, 90);
    await service.snapshot();
    expect((await service.snapshot()).battle?.status).toBe("awaiting_recovery");
    await expect(service.retryBattle(active.id, 20)).rejects.toThrow(/Tónico de Retorno/);
  });

  it("el zurrón inicial se entrega una sola vez", async () => {
    const first = await service.snapshot();
    expect(first.inventory.items).toEqual([
      { itemId: "revive_tonic", quantity: 1 },
      { itemId: "health_potion", quantity: 2 },
    ]);
    const stamp = first.inventory.initializedAt;
    await service.snapshot();
    const again = await service.snapshot();
    expect(again.inventory.initializedAt).toBe(stamp);
    expect(again.inventory.items).toEqual(first.inventory.items);
  });

  it("el tónico levanta a un caído con parte de su vida y se gasta", async () => {
    const active = await startedQuest(60);
    await service.snapshot();
    await wound(active.id, 0, 80, 80);

    // I-004: la poción no resucita.
    await expect(service.useInventoryItem("health_potion", "roko")).rejects.toThrow(/no resucita/);
    // I-001: el tónico sí, y no al 100%.
    const revived = await service.useInventoryItem("revive_tonic", "roko");
    expect(revived.battle?.party.roko.health).toBe(35);
    expect(revived.battle?.party.roko.status).toBe("active");
    expect(revived.remaining).toBe(0);
    // I-002: sin existencias, se rechaza.
    await wound(active.id, 0, 80, 80);
    await expect(service.useInventoryItem("revive_tonic", "roko")).rejects.toThrow(/No queda/);
  });

  it("la poción cura a quien sigue en pie, sin pasar del máximo, y persiste al recargar", async () => {
    const active = await startedQuest(60);
    await service.snapshot();
    await wound(active.id, 50, 80, 90);

    // I-003: +30 sobre 80.
    const healed = await service.useInventoryItem("health_potion", "marques");
    expect(healed.battle?.party.marques.health).toBe(100);
    // Nunca por encima del máximo.
    const capped = await service.useInventoryItem("health_potion", "cordera");
    expect(capped.battle?.party.cordera.health).toBe(100);
    expect(capped.remaining).toBe(0);

    // I-005: otra lectura del reino conserva las cantidades.
    const reloaded = new QuestService(store, undefined, directory, "torreon-continuity-test", fixedClock(RELOJ_DEL_REINO));
    const snapshot = await reloaded.snapshot();
    expect(snapshot.inventory.items.find((entry) => entry.itemId === "health_potion")?.quantity).toBe(0);
    expect(snapshot.battle?.party.marques.health).toBe(100);
  });

  it("repactar el tiempo antes del plazo no es una derrota", async () => {
    const active = await startedQuest(55);
    await service.completeStep(active.id, active.steps[0].id, "Primer empuje entregado");
    await wound(active.id, 40, 90, 95, 5);

    const proposed = await service.proposeBattleRecontract(active.id, {
      reason: "Opus necesitó actualizar sus tools MCP y staging todavía no las descubre.",
      newDurationMinutes: 30,
    });
    expect(proposed.pendingRecontract?.newDurationMinutes).toBe(30);

    // T6: se sella la propuesta concreta, por su id.
    await expect(service.acceptBattleRecontract(active.id, "00000000-0000-0000-0000-000000000000", true)).rejects.toThrow(/ya no está sobre la mesa/);
    const accepted = await service.acceptBattleRecontract(active.id, proposed.pendingRecontract!.id, true);
    // RC-001: el intento anterior se cierra como repactado, no como vencido.
    expect(accepted.attempts[0].endReason).toBe("recontracted");
    expect(accepted.attempt).toBe(2);
    // RC-003: sigue sin poder pasar de 60. 55 + 30 no son 85.
    expect(accepted.durationMinutes).toBe(30);
    // RC-002: todo el estado de combate se preserva.
    expect(accepted.progress).toBe(40);
    expect(accepted.party.roko.health).toBe(40);
    expect(accepted.party.roko.shield).toBe(5);
    // RC-004: ningún battle_lost falso.
    const snapshot = await service.snapshot();
    expect(snapshot.realm.gameEvents.some((event) => event.type === "battle_lost")).toBe(false);
    expect(snapshot.realm.gameEvents.some((event) => event.type === "battle_recontracted")).toBe(true);
  });

  it("un compañero disponible no da bonus; sólo el que peleó y validó", async () => {
    const active = await startedQuest(60);
    await service.snapshot();

    // AG-001/C-001: sin uso real, el cuarto slot sigue vacío.
    expect((await service.snapshot()).battle?.agent.deployed).toBe(false);

    // C-002: usado pero con evidencia rechazada, no concede nada.
    await service.recordCompanionAssist({
      questId: active.id,
      stepId: active.steps[0].id,
      companion: "opus",
      sourceTool: "update_client_portal",
      contributionSummary: "Opus actualizó el staging de Finaer.",
    });
    const deployed = await service.snapshot();
    // AG-002: el primer compañero real ocupa el slot.
    expect(deployed.battle?.agent.companion).toBe("opus");
    expect(deployed.battle?.agent.status).toBe("assist_ready");

    await service.submitEvidence(active.id, active.steps[0].id, {
      summary: "Nada comprobable todavía.",
      source: "user_declaration",
      verdict: "rejected",
      reasoning: "No llegó ninguna prueba de lo pactado.",
      impactAwarded: 0,
    });
    const rejected = await service.snapshot();
    expect(rejected.realm.gameEvents.some((event) => event.type === "companion_combo_attack")).toBe(false);
    expect(rejected.battle?.agent.comboDamage).toBe(0);

    // C-004: cuatro llamadas más del mismo compañero siguen valiendo un combo.
    for (let index = 0; index < 4; index += 1) {
      await service.recordCompanionAssist({
        questId: active.id,
        stepId: active.steps[0].id,
        companion: "opus",
        contributionSummary: `Ejecución repetida ${index + 1}.`,
      });
    }

    // C-003: con la evidencia aceptada llega exactamente un ataque combinado.
    await service.completeStep(active.id, active.steps[0].id, "Primer empuje entregado");
    const validated = await service.snapshot();
    const combos = validated.realm.gameEvents.filter((event) => event.type === "companion_combo_attack");
    expect(combos).toHaveLength(1);
    expect(validated.battle?.agent.status).toBe("assist_validated");
    expect(validated.battle?.agent.comboDamage).toBeGreaterThan(0);

    // AG-004: un segundo compañero queda como apoyo, sin quinta tarjeta.
    await service.recordCompanionAssist({
      questId: active.id,
      stepId: active.steps[1].id,
      companion: "gemini",
      contributionSummary: "Gemini revisó los datos del portal.",
    });
    const second = await service.snapshot();
    expect(second.battle?.agent.companion).toBe("opus");
    expect(second.battle?.agent.secondaryAssists).toContain("gemini");

    // C-005: releer el reino no duplica el combo.
    expect((await service.snapshot()).realm.gameEvents.filter((event) => event.type === "companion_combo_attack")).toHaveLength(1);
  });

  it("el impacto validado golpea enemigos concretos y desborda sin perderse", async () => {
    const active = await startedQuest(60);
    const before = (await service.snapshot()).battle!.enemies;
    const weakest = before.reduce((lowest, enemy) => (enemy.maxHealth < lowest.maxHealth ? enemy : lowest));

    await service.completeStep(active.id, active.steps[0].id, "Primer empuje entregado");
    const after = await service.snapshot();
    const attack = after.realm.gameEvents.find((event) => event.type === "quest_attack")!;

    // DMG-001: el ataque nombra a quién golpeó.
    expect(attack.enemyAllocations?.length).toBeGreaterThan(0);
    // DMG-002: el sobrante desborda; 40 puntos reparten más allá del primero.
    const dealt = attack.enemyAllocations!.reduce((sum, entry) => sum + entry.damage, 0);
    expect(dealt).toBe(40);
    // DMG-003: quien cae deja de aportar presión.
    const fallen = after.battle!.enemies.filter((enemy) => enemy.status === "ko");
    expect(fallen.length).toBeGreaterThan(0);
    expect(after.battle!.pressureRate).toBeLessThan(
      before.reduce((sum, enemy) => sum + enemy.pressureRate, 0) * 2,
    );
    void weakest;
  });
});
