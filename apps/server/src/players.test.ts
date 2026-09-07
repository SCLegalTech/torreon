import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "./clock.js";
import type { QuestPlanInput, RealmState } from "./domain.js";
import { DEFAULT_PLAYER_ID } from "./players.js";
import { QuestService } from "./quest-service.js";
import { createInitialState, JsonRealmStore } from "./store.js";

const RELOJ_DEL_REINO = "2026-05-11T09:00:00.000Z";

function plan(title: string): QuestPlanInput {
  return {
    title,
    intent: `Resolver ${title}.`,
    outcome: `${title} queda resuelto y comprobable.`,
    rationale: "Una Battle real de unos diez minutos.",
    durationMinutes: 15,
    wellbeingConstraints: [],
    allowedApps: [],
    steps: [
      { title: "Primer empuje", actor: "user", evidence: "Constancia", evidenceKind: "declaration", weight: 40 },
      { title: "Golpe final", actor: "user", evidence: "Constancia", evidenceKind: "declaration", weight: 60 },
    ],
  };
}

/**
 * EL REINO ES DE ALGUIEN (artículo 10, ADR-0002).
 *
 * Hasta ahora el proceso entero era UN reino sin dueño: no faltaba
 * autenticación, faltaba el sujeto, y no había dónde poner al segundo jugador.
 *
 * Saber QUIÉN pregunta sigue siendo la etapa 5. Lo que estas pruebas defienden
 * es lo anterior a eso: que dos reinos puedan convivir sin verse, y que el
 * Marqués que ya jugaba no pierda nada al estrenar dueño.
 */
describe("Todo reino tiene dueño", () => {
  let directory: string;
  let statePath: string;
  let store: JsonRealmStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "torreon-jugadores-"));
    statePath = join(directory, "torreon-state.json");
    store = new JsonRealmStore(statePath, fixedClock(RELOJ_DEL_REINO));
    await store.init();
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function realmOf(playerId: string): QuestService {
    return new QuestService(store, undefined, directory, "torreon-jugadores-test", fixedClock(RELOJ_DEL_REINO), playerId);
  }

  it("dos jugadores comparten proceso y almacén, y no se ven la campaña", async () => {
    const marques = realmOf(DEFAULT_PLAYER_ID);
    const cordera = realmOf("cordera-la-otra");

    const suya = await marques.createDraft(plan("La deuda del Marqués"));
    const ajena = await cordera.createDraft(plan("El huerto de Cordera"));

    const reinoDelMarques = await marques.snapshot();
    const reinoDeCordera = await cordera.snapshot();

    expect(reinoDelMarques.realm.quests.map((quest) => quest.id)).toEqual([suya.id]);
    expect(reinoDeCordera.realm.quests.map((quest) => quest.id)).toEqual([ajena.id]);
    // Y son reinos distintos, no dos vistas del mismo.
    expect(reinoDelMarques.realm.realmId).not.toBe(reinoDeCordera.realm.realmId);
    expect(reinoDelMarques.realm.playerId).toBe(DEFAULT_PLAYER_ID);
    expect(reinoDeCordera.realm.playerId).toBe("cordera-la-otra");
  });

  it("el frente comprometido de uno no ocupa el frente del otro", async () => {
    const marques = realmOf(DEFAULT_PLAYER_ID);
    const cordera = realmOf("cordera-la-otra");

    const suya = await marques.createDraft(plan("La deuda del Marqués"));
    await marques.accept(suya.id, true);
    await marques.start(suya.id);

    // Un solo frente con reloj POR JUGADOR, no por servidor.
    const ajena = await cordera.createDraft(plan("El huerto de Cordera"));
    await cordera.accept(ajena.id, true);
    const iniciada = await cordera.start(ajena.id);
    expect(iniciada.battle?.status).toBe("active");
  });

  it("borrar el reino de uno no toca el del otro", async () => {
    const marques = realmOf(DEFAULT_PLAYER_ID);
    const cordera = realmOf("cordera-la-otra");
    await marques.createDraft(plan("La deuda del Marqués"));
    const ajena = await cordera.createDraft(plan("El huerto de Cordera"));

    await marques.reset();

    expect((await marques.snapshot()).realm.quests).toHaveLength(0);
    expect((await cordera.snapshot()).realm.quests.map((quest) => quest.id)).toEqual([ajena.id]);
  });

  it("el reino que ya existía estrena dueño sin moverse de archivo ni perder nada", async () => {
    // Un reino escrito ANTES de que existiera el sujeto: sin `playerId`.
    const legado = createInitialState(Date.parse(RELOJ_DEL_REINO)) as RealmState & { playerId?: string };
    const realmIdOriginal = legado.realmId;
    legado.character.xp = 420;
    delete legado.playerId;
    await writeFile(statePath, `${JSON.stringify(legado, null, 2)}\n`, "utf8");

    const adoptado = await realmOf(DEFAULT_PLAYER_ID).snapshot();

    expect(adoptado.realm.playerId).toBe(DEFAULT_PLAYER_ID);
    expect(adoptado.realm.realmId).toBe(realmIdOriginal);
    expect(adoptado.realm.character.xp).toBe(420);
    // Y sigue viviendo donde siempre: ninguna migración movió el volumen.
    expect(JSON.parse(await readFile(statePath, "utf8")).realmId).toBe(realmIdOriginal);
  });

  it("el segundo jugador estrena su propio archivo, junto al del primero", async () => {
    await realmOf("cordera-la-otra").snapshot();
    expect(existsSync(join(directory, "realms", "cordera-la-otra.json"))).toBe(true);
    expect(existsSync(statePath)).toBe(true);
  });

  it("un id de jugador no puede escaparse del directorio del reino", async () => {
    await expect(realmOf("../../etc/passwd").snapshot()).rejects.toThrow(/se nombra con/i);
  });
});
