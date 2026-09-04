import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QuestPlanInput } from "./domain.js";
import { QuestService } from "./quest-service.js";
import { JsonRealmStore } from "./store.js";

/**
 * UN JUGADOR PUEDE PERDER UNA BATALLA. NO PUEDE PERDER EL ACCESO AL JUEGO.
 *
 * El reporte P0 describía un callejón sin salida real: el Marqués cae, el
 * zurrón se queda sin Tónico de Retorno y `retryBattle` —con toda la razón— se
 * niega a levantarlo gratis. A partir de ahí ese frente no se puede reintentar
 * nunca más, y no existía ninguna otra puerta.
 *
 * Aquí se defiende la puerta que faltaba, y se defiende sobre todo lo que la
 * puerta NO puede regalar: sin ella el juego se cierra, pero con ella mal hecha
 * el juego deja de significar algo.
 */

const plan: QuestPlanInput = {
  campaignTitle: "El frente que no se cierra",
  title: "La Puerta atascada",
  intent: "Probar que un frente perdido no atrapa al jugador.",
  outcome: "El frente sigue abierto y el grupo puede volver.",
  rationale: "Perder una Battle no puede ser perder el juego.",
  durationMinutes: 60,
  wellbeingConstraints: [],
  allowedApps: [],
  steps: [
    { title: "Primer empuje", actor: "user", evidence: "Constancia", evidenceKind: "declaration", weight: 40 },
    { title: "Golpe final", actor: "user", evidence: "Constancia", evidenceKind: "declaration", weight: 60 },
  ],
};

describe("Anti-softlock: la retirada táctica", () => {
  let directory: string;
  let store: JsonRealmStore;
  let service: QuestService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "torreon-softlock-"));
    store = new JsonRealmStore(join(directory, "state.json"));
    await store.init();
    service = new QuestService(store, undefined, directory, "torreon-softlock-test");
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

  async function wound(questId: string, roko: number, marques: number, cordera: number): Promise<void> {
    await store.mutate((state) => {
      const party = state.quests.find((candidate) => candidate.id === questId)!.battle!.party;
      party.roko.health = roko;
      party.roko.status = roko === 0 ? "ko" : "active";
      party.marques.health = marques;
      party.marques.status = marques === 0 ? "ko" : "active";
      party.cordera.health = cordera;
      party.cordera.status = cordera === 0 ? "ko" : "active";
    });
  }

  async function emptyBag(): Promise<void> {
    await store.mutate((state) => {
      state.inventory.items = state.inventory.items.map((entry) => ({ ...entry, quantity: 0 }));
    });
  }

  async function startedQuest(durationMinutes?: number) {
    const draft = await service.createDraft(plan);
    await service.accept(draft.id, true);
    return service.start(draft.id, durationMinutes);
  }

  /** El callejón exacto del reporte: caído, sin tónico y sin poder reintentar. */
  async function cornered() {
    const active = await startedQuest(60);
    await service.completeStep(active.id, active.steps[0].id, "Primer empuje entregado");
    await ageBattle(active.id, 61);
    await service.snapshot();
    await wound(active.id, 55, 0, 26);
    await emptyBag();
    return active;
  }

  it("AS-001: sin Tónico y con el Marqués caído queda EXACTAMENTE una salida, y existe", async () => {
    const quest = await cornered();

    // La puerta cerrada, tal como el Core la defiende: replanificar no resucita.
    await expect(service.retryBattle(quest.id, 30)).rejects.toThrow(/Tónico de Retorno/);
    // Y tampoco hay resurrección por la puerta de atrás del zurrón vacío.
    await expect(service.useInventoryItem("revive_tonic", "marques", quest.id)).rejects.toThrow(/No queda/);

    // La puerta que sí existe.
    const offer = await service.recoveryOffer(quest.id);
    expect(offer.available).toBe(true);
    expect(offer.minHealth).toBeGreaterThan(0);
  });

  it("AS-002: la retirada levanta al caído al mínimo del Core y NO toca nada más", async () => {
    const quest = await cornered();
    const before = await service.snapshot();
    const enemiesBefore = before.battle!.enemies.map((enemy) => `${enemy.id}:${enemy.health}`);
    const bagBefore = JSON.stringify(before.inventory.items);

    const recovered = await service.recoverParty(quest.id);
    const after = await service.snapshot();

    // Vuelve del suelo, y sólo hasta donde el Core declara.
    expect(recovered.raised).toEqual(["marques"]);
    expect(after.battle!.party.marques.health).toBe(recovered.minHealth);
    expect(after.battle!.party.marques.status).toBe("active");
    // Quien seguía en pie conserva SUS heridas: esto no es un descanso completo.
    expect(after.battle!.party.roko.health).toBe(55);
    expect(after.battle!.party.cordera.health).toBe(26);
    // Ni progreso, ni evidencia, ni Horda curada, ni objetos devueltos.
    expect(after.battle!.progress).toBe(40);
    expect(after.realm.evidence.length).toBe(before.realm.evidence.length);
    expect(after.battle!.enemies.map((enemy) => `${enemy.id}:${enemy.health}`)).toEqual(enemiesBefore);
    expect(JSON.stringify(after.inventory.items)).toBe(bagBefore);
    expect(after.stats.xp).toBe(before.stats.xp);
    expect(after.stats.aura).toBe(before.stats.aura);
    // El intento previo sigue en la historia: retirarse no la borra.
    expect(after.battle!.attempt).toBe(before.battle!.attempt);
    // Y el frente sigue pidiendo un pacto nuevo: no se reabre solo.
    expect(after.battle!.status).toBe("awaiting_replan");
  });

  it("AS-003: retirarse no es resucitar dentro del intento — con el reloj corriendo se niega", async () => {
    const active = await startedQuest(60);
    // Cae Roku, no el Marqués: si cayera el Marqués el Core cerraría la Battle,
    // y lo que hay que probar es justo el caso contrario —el reloj SIGUE—.
    await wound(active.id, 0, 80, 40);

    const offer = await service.recoveryOffer(active.id);
    expect(offer.available).toBe(false);
    expect(offer.reason).toMatch(/reloj/i);
    await expect(service.recoverParty(active.id)).rejects.toThrow(/reloj/i);
  });

  it("AS-004: tras la retirada el frente vuelve a ser replanificable, con su progreso intacto", async () => {
    const quest = await cornered();
    await service.recoverParty(quest.id);

    const retried = await service.retryBattle(quest.id, 30);
    expect(retried.battle.attempt).toBe(2);
    expect(retried.battle.progress).toBe(40);
    // Nadie se retira dos veces del mismo agujero: en pie ya no hay a quién levantar.
    const offer = await service.recoveryOffer(quest.id);
    expect(offer.available).toBe(false);
  });

  it("AS-005: nadie entra a un frente desde el suelo — el preflight de start lo dice", async () => {
    const quest = await cornered();
    // Un frente reabierto por otra vía tampoco puede arrancar con el Marqués KO.
    await store.mutate((state) => {
      state.quests.find((candidate) => candidate.id === quest.id)!.status = "accepted";
    });
    await expect(service.start(quest.id)).rejects.toThrow(/KO|suelo|Tónico/i);
  });
});

/**
 * EL FRENTE SE NOMBRA, NO SE ADIVINA.
 *
 * Con dos Battles esperando auxilio, el Core elegía «la primera del archivo».
 * El jugador miraba la pantalla de una y gastaba su único Tónico en la otra.
 */
describe("Objetos: el frente se nombra", () => {
  let directory: string;
  let store: JsonRealmStore;
  let service: QuestService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "torreon-target-"));
    store = new JsonRealmStore(join(directory, "state.json"));
    await store.init();
    service = new QuestService(store, undefined, directory, "torreon-target-test");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function fallenFront(title: string) {
    const draft = await service.createDraft({ ...plan, title });
    await service.accept(draft.id, true);
    await service.start(draft.id, 60);
    await store.mutate((state) => {
      const battle = state.quests.find((candidate) => candidate.id === draft.id)!.battle!;
      const shift = 61 * 60_000;
      battle.startedAt = new Date(Date.parse(battle.startedAt) - shift).toISOString();
      battle.deadlineAt = new Date(Date.parse(battle.deadlineAt) - shift).toISOString();
    });
    await service.snapshot();
    await store.mutate((state) => {
      const party = state.quests.find((candidate) => candidate.id === draft.id)!.battle!.party;
      party.marques.health = 0;
      party.marques.status = "ko";
    });
    return draft.id;
  }

  it("OB-001: el Tónico se gasta en el frente que pidió el jugador, no en el primero del archivo", async () => {
    const primero = await fallenFront("El frente que no mira");
    const segundo = await fallenFront("El frente que sí mira");

    await service.useInventoryItem("revive_tonic", "marques", segundo);

    const state = await store.read();
    const uno = state.quests.find((quest) => quest.id === primero)!.battle!;
    const dos = state.quests.find((quest) => quest.id === segundo)!.battle!;
    expect(dos.party.marques.health).toBeGreaterThan(0);
    expect(uno.party.marques.health).toBe(0);
  });

  it("OB-002: una poción nunca resucita, y el Core lo explica en vez de fallar en silencio", async () => {
    const frente = await fallenFront("El frente de la poción");
    await expect(service.useInventoryItem("health_potion", "marques", frente)).rejects.toThrow(/caído|resucita/i);
  });
});

/**
 * UNA BATTLE NO PUEDE VIVIR SÓLO DENTRO DE SU NOTIFICACIÓN.
 *
 * La Battle de Bigle era de Campaña: no aparecía en Batallas Libres, la pantalla
 * de Campaña sólo pinta la campaña EN FOCO, y su aviso era el único hilo que
 * quedaba. Archivado el aviso, la Battle desaparecía del juego.
 */
describe("Frentes abiertos: la ruta normal a cualquier Battle", () => {
  let directory: string;
  let store: JsonRealmStore;
  let service: QuestService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "torreon-fronts-"));
    store = new JsonRealmStore(join(directory, "state.json"));
    await store.init();
    service = new QuestService(store, undefined, directory, "torreon-fronts-test");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("FR-001: una Battle nacida dentro de una Campaña es alcanzable por navegación normal", async () => {
    const { campaign } = await service.createCampaignDraft({
      title: "La Conquista del Mercado Remoto",
      intent: "Abrir el frente legaltech.",
      objective: "Tres contratos firmados.",
      rationale: "No cabe en una jornada.",
      estimatedActiveMinutes: 900,
    });
    const act = await service.createAct({ campaignId: campaign.id, title: "El Frente LegalTech" });
    const draft = await service.createDraft({ ...plan, title: "La Puerta de Bigle" }, { actId: act.id, campaignId: campaign.id });
    await service.accept(draft.id, true);
    await service.start(draft.id, 45);

    const snapshot = await service.snapshot();
    // No es standalone —tiene padres— y aun así tiene entrada propia.
    expect(snapshot.hierarchy.standaloneQuests.some((node) => node.id === draft.id)).toBe(false);
    const front = snapshot.openFronts.find((candidate) => candidate.questId === draft.id);
    expect(front).toBeDefined();
    expect(front!.engaged).toBe(true);
    // Y dice de qué frente viene, para que el jugador sepa a dónde vuelve.
    expect(front!.campaignTitle).toBe("La Conquista del Mercado Remoto");
    expect(front!.actTitle).toBe("El Frente LegalTech");
  });

  it("FR-002: Batallas Libres declara una pantalla propia, nunca «ya estás aquí»", async () => {
    const snapshot = await service.snapshot();
    const quick = snapshot.worldSystems.find((system) => system.id === "quick_battles")!;
    // `screen: "realm"` era exactamente el botón muerto: no llevaba a ningún sitio.
    expect(quick.screen).not.toBe("realm");
    expect(quick.screen).toBe("quick_battles");
  });

  it("FR-003: una Battle ganada deja de ser un frente abierto", async () => {
    const draft = await service.createDraft(plan);
    await service.accept(draft.id, true);
    await service.start(draft.id, 60);
    await service.completeStep(draft.id, draft.steps[0].id, "Primer empuje");
    expect((await service.snapshot()).openFronts.some((front) => front.questId === draft.id)).toBe(true);

    await service.completeStep(draft.id, draft.steps[1].id, "Golpe final");
    const snapshot = await service.snapshot();
    expect(snapshot.battle?.status).toBe("won");
    expect(snapshot.openFronts.some((front) => front.questId === draft.id)).toBe(false);
  });
});
