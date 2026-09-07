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
 * LOS AVISOS DE UNA BATTLE MUEREN CON LA BATTLE.
 *
 * El caso real: «La puerta de Bigle sigue abierta» seguía en la bandeja después
 * de GANARLA. El aviso había nacido correcto —el plazo venció de verdad— pero
 * nada lo cerraba cuando el frente se cerró: el Centro de Notificaciones sabía
 * crear registros y no sabía jubilarlos.
 *
 * UN AVISO ACTIVO ES UNA COSA QUE TODAVÍA PIDE ALGO. Estas pruebas defienden
 * las dos mitades: que se jubile solo, y que el historial no se pierda.
 */

const plan: QuestPlanInput = {
  campaignTitle: "La Conquista del Mercado Remoto",
  title: "La Puerta de Bigle",
  intent: "Probar que un frente cerrado deja de llamar a la puerta.",
  outcome: "La candidatura queda enviada y confirmada.",
  rationale: "Un aviso activo tiene que significar algo pendiente.",
  durationMinutes: 60,
  wellbeingConstraints: [],
  allowedApps: [],
  steps: [
    { title: "Preparar", actor: "user", evidence: "Constancia", evidenceKind: "declaration", weight: 40 },
    { title: "Enviar", actor: "user", evidence: "Constancia", evidenceKind: "declaration", weight: 60 },
  ],
};

describe("Ciclo de vida de una misión y sus avisos", () => {
  let directory: string;
  let store: JsonRealmStore;
  let service: QuestService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "torreon-lifecycle-"));
    store = new JsonRealmStore(join(directory, "state.json"), fixedClock(RELOJ_DEL_REINO));
    await store.init();
    service = new QuestService(store, undefined, directory, "torreon-lifecycle-test", fixedClock(RELOJ_DEL_REINO));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /** Deja el plazo vencido: es lo que crea el aviso «el frente sigue abierto». */
  async function expire(questId: string): Promise<void> {
    await store.mutate((state) => {
      const battle = state.quests.find((candidate) => candidate.id === questId)!.battle!;
      const shift = 61 * 60_000;
      battle.startedAt = new Date(Date.parse(battle.startedAt) - shift).toISOString();
      battle.deadlineAt = new Date(Date.parse(battle.deadlineAt) - shift).toISOString();
    });
    await service.snapshot();
  }

  /** Una hora de presión deja al grupo en el suelo; aquí sólo importa el aviso. */
  async function backOnTheirFeet(questId: string): Promise<void> {
    await store.mutate((state) => {
      const party = state.quests.find((candidate) => candidate.id === questId)!.battle!.party;
      for (const id of ["roko", "marques", "cordera"] as const) {
        party[id].health = party[id].maxHealth;
        party[id].status = "active";
      }
    });
  }

  async function started() {
    const draft = await service.createDraft(plan);
    await service.accept(draft.id, true);
    return service.start(draft.id, 60);
  }

  const activeFor = async (questId: string) =>
    (await service.getNotifications({ limit: 200 })).notifications.filter((notice) => notice.entityId === questId);

  it("NL-001: el aviso «el frente sigue abierto» se jubila al ganar la Battle", async () => {
    const quest = await started();
    await expire(quest.id);

    // El aviso existe y está activo: el plazo venció de verdad.
    const pending = await activeFor(quest.id);
    expect(pending.some((notice) => notice.type === "battle_lost")).toBe(true);

    // Se replanifica y se gana.
    await backOnTheirFeet(quest.id);
    await service.retryBattle(quest.id, 30);
    await service.completeStep(quest.id, quest.steps[0].id, "Preparado");
    await service.completeStep(quest.id, quest.steps[1].id, "Enviado");
    expect((await service.snapshot()).battleQuest?.status).toBe("completed");

    // Y a partir de ahí no queda NADA suyo reclamando atención.
    expect(await activeFor(quest.id)).toEqual([]);
  });

  it("NL-002: jubilar no es borrar — el historial sigue consultable", async () => {
    const quest = await started();
    await expire(quest.id);
    await backOnTheirFeet(quest.id);
    await service.retryBattle(quest.id, 30);
    await service.completeStep(quest.id, quest.steps[0].id, "Preparado");
    await service.completeStep(quest.id, quest.steps[1].id, "Enviado");

    const history = (await service.getNotifications({ limit: 200, includeArchived: true })).notifications
      .filter((notice) => notice.entityId === quest.id);
    expect(history.length).toBeGreaterThan(0);
    expect(history.every((notice) => notice.archived)).toBe(true);
  });

  it("NL-003: el backfill no resucita el aviso de una Quest cerrada en la siguiente lectura", async () => {
    const quest = await started();
    await expire(quest.id);
    await service.abandon(quest.id, "Ya no la quiero.");

    // Tres lecturas: el backfill corre en cada normalización del estado.
    await service.snapshot();
    await service.snapshot();
    expect(await activeFor(quest.id)).toEqual([]);
  });

  it("NL-004: el contador de no leídas deja de contar un frente ya cerrado", async () => {
    const quest = await started();
    await expire(quest.id);
    const before = (await service.snapshot()).unreadNotifications;

    await service.abandon(quest.id, "Descartada.");
    const after = (await service.snapshot()).unreadNotifications;
    expect(after).toBeLessThan(before);
  });
});

/**
 * JUGAR O ELIMINAR.
 *
 * Torreón no puede obligar al jugador a sostener una misión abierta sólo porque
 * alguna vez fue detectada. Descartar tiene que sacarla de lo pendiente SIN
 * romper la historia de la partida.
 */
describe("Descartar una misión", () => {
  let directory: string;
  let store: JsonRealmStore;
  let service: QuestService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "torreon-discard-"));
    store = new JsonRealmStore(join(directory, "state.json"), fixedClock(RELOJ_DEL_REINO));
    await store.init();
    service = new QuestService(store, undefined, directory, "torreon-discard-test", fixedClock(RELOJ_DEL_REINO));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("DQ-001: un borrador nunca sellado se borra de raíz y se lleva sus avisos", async () => {
    const draft = await service.createDraft(plan);
    let snapshot = await service.snapshot();
    expect(snapshot.hierarchy.standaloneQuests.some((node) => node.id === draft.id)).toBe(true);
    expect(snapshot.notifications.some((notice) => notice.entityId === draft.id)).toBe(true);

    const result = await service.discardQuest(draft.id, "No me interesa esta vacante.");
    expect(result.outcome).toBe("deleted");

    snapshot = await service.snapshot();
    expect(snapshot.realm.quests.some((quest) => quest.id === draft.id)).toBe(false);
    expect(snapshot.hierarchy.standaloneQuests.some((node) => node.id === draft.id)).toBe(false);
    expect(snapshot.notifications.some((notice) => notice.entityId === draft.id)).toBe(false);
  });

  it("DQ-002: una Quest ya iniciada se abandona: sale de lo pendiente y CONSERVA su historia", async () => {
    const draft = await service.createDraft(plan);
    await service.accept(draft.id, true);
    await service.start(draft.id, 60);
    await service.completeStep(draft.id, draft.steps[0].id, "Preparado");

    const result = await service.discardQuest(draft.id, "Cambió la prioridad.");
    expect(result.outcome).toBe("abandoned");

    const snapshot = await service.snapshot();
    const quest = snapshot.realm.quests.find((candidate) => candidate.id === draft.id)!;
    // La historia sigue en pie: el registro, el impacto validado y la evidencia.
    expect(quest.status).toBe("abandoned");
    expect(quest.steps[0].impactAwarded).toBe(40);
    expect(snapshot.realm.evidence.some((record) => record.questId === draft.id)).toBe(true);
    // Y deja de reclamar: ni frente abierto, ni Quick Battle, ni avisos activos.
    expect(snapshot.openFronts.some((front) => front.questId === draft.id)).toBe(false);
    expect(snapshot.hierarchy.standaloneQuests.some((node) => node.id === draft.id)).toBe(false);
    expect(snapshot.notifications.some((notice) => notice.entityId === draft.id)).toBe(false);
  });

  it("DQ-003: lo completado no se descarta", async () => {
    const draft = await service.createDraft(plan);
    await service.accept(draft.id, true);
    await service.start(draft.id, 60);
    await service.completeStep(draft.id, draft.steps[0].id, "Preparado");
    await service.completeStep(draft.id, draft.steps[1].id, "Enviado");

    await expect(service.discardQuest(draft.id, "Ya no")).rejects.toThrow(/completada|historia/i);
  });

  it("DQ-004: descartar dos veces no rompe nada", async () => {
    const draft = await service.createDraft(plan);
    await service.accept(draft.id, true);
    await service.start(draft.id, 60);
    await service.discardQuest(draft.id, "Cambió la prioridad.");
    const second = await service.discardQuest(draft.id, "Otra vez.");
    expect(second.outcome).toBe("abandoned");
  });
});
