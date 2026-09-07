import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { backfillHeroCareer, ensureRoster } from "./barracks.js";
import { reconcileBattleProjection } from "./battle.js";
import { emptyAgentSlot } from "./companions.js";
import type { RealmState } from "./domain.js";
import { backfillEncounter } from "./horde.js";
import { backfillNotifications, settleClosedNotifications } from "./notifications.js";
import { freshParty, refreshPartyDisplay } from "./party.js";
import { DEV_ENTITLEMENTS, freshUsage, rolloverUsage } from "./product.js";
import { isoAt, systemClock, type Clock } from "./clock.js";
import { DEFAULT_PLAYER_ID, requirePlayerId, type PlayerId } from "./players.js";
import type { RealmStore } from "./realm-store.js";


export function createInitialState(nowMs: number, playerId: PlayerId = DEFAULT_PLAYER_ID): RealmState {
  return {
    version: 1,
    realmId: randomUUID(),
    /** DE ALGUIEN. Ningún reino existe sin dueño (artículo 10). */
    playerId,
    player: {
      displayName: "Marqués Phi",
      title: "Guardián de la Marca",
    },
    inventory: { items: [], initializedAt: undefined },
    companionAssists: [],
    companionExecutions: [],
    heroes: {},
    progressionLedger: [],
    afterActionReports: [],
    battleLessons: [],
    playbooks: [],
    character: {
      xp: 0,
      aura: 0,
      mastery: {},
      rewardedQuestIds: [],
    },
    financial: {
      currency: "COP",
      availableBalance: 400_000,
      expectedIncome: 2_400_000,
      committedExpenses: 2_100_000,
      reserveTarget: 500_000,
    },
    sagas: [],
    campaigns: [],
    acts: [],
    quests: [],
    events: [],
    notifications: [],
    recurringObligations: [],
    financialTransactions: [],
    entitlements: { ...DEV_ENTITLEMENTS },
    usage: freshUsage(nowMs),
    evidence: [],
    artifacts: [],
    lifeEvents: [],
    gameEvents: [],
    updatedAt: isoAt(nowMs),
  };
}

/**
 * MIGRACIÓN DE LECTURA — compartida por todos los almacenes.
 *
 * Vivía dentro del lector del JSON, así que cada almacén nuevo la habría
 * duplicado o la habría perdido. Sigue ejecutándose en cada lectura y sigue sin
 * versionar: eso es deuda conocida (hallazgo B-5) que cierra el esquema
 * versionado de SQLite. Lo que ya NO puede pasar es que un adaptador nuevo se
 * la salte.
 *
 * Regla que no se toca (artículo 20): una migración NUNCA resucita lo que el
 * jugador ya mató. Sólo baja, nunca sube.
 */
export function migrateRealm(state: RealmState, nowMs: number): RealmState {
  // Reinos creados antes de que existiera la identidad reciben una al leerse.
  state.realmId ??= randomUUID();
  state.evidence ??= [];
  // Reinos anteriores a la jerarquía no tenían padres: la microquest es válida.
  state.sagas ??= [];
  state.campaigns ??= [];
  state.acts ??= [];
  // Los actos nacían «pending»; ahora la disponibilidad se llama por su nombre.
  for (const act of state.acts) {
    if ((act.status as string) === "pending") act.status = "available";
  }
  // Reinos anteriores al pacto de campaña ya estaban vivos: se respetan.
  for (const campaign of state.campaigns) {
    campaign.status ??= "active";
  }
  // Actos anteriores a la ejecución en paralelo no declaran dependencias.
  for (const act of state.acts) {
    act.dependsOnActIds ??= [];
  }
  // Un hecho sin entidad no se puede abrir: los históricos apuntan a su quest.
  for (const event of state.events) {
    event.entityType ??= "quest";
    event.entityId ??= event.questId ?? "";
  }
  state.artifacts ??= [];
  state.lifeEvents ??= [];
  state.gameEvents ??= [];
  // CENTRO DE NOTIFICACIONES y TESORERÍA: reinos anteriores nacen vacíos.
  state.notifications ??= [];
  state.recurringObligations ??= [];
  state.financialTransactions ??= [];
  // Capa de producto: se completan los campos que falten sin pisar los puestos.
  state.entitlements = { ...DEV_ENTITLEMENTS, ...(state.entitlements ?? {}) };
  // La telemetría nueva empieza en cero sin pisar lo ya contado hoy.
  state.usage = { ...freshUsage(nowMs), ...(state.usage ?? {}) };
  rolloverUsage(state.usage, nowMs);
  // Reinos anteriores a la hoja de personaje empiezan en cero, no en inventado.
  state.character ??= { xp: 0, aura: 0, mastery: {}, rewardedQuestIds: [] };
  state.inventory ??= { items: [] };
  state.inventory.items ??= [];
  state.companionAssists ??= [];
  // BARRACAS y MEMORIA DE BATALLA: un reino anterior nace sin ellas y las
  // estrena vacías. NO se fabrican estadísticas retroactivas de la nada.
  state.companionExecutions ??= [];
  state.heroes ??= {};
  state.progressionLedger ??= [];
  state.afterActionReports ??= [];
  state.battleLessons ??= [];
  state.playbooks ??= [];
  state.character.mastery ??= {};
  state.character.rewardedQuestIds ??= [];
  for (const quest of state.quests) {
    quest.version ??= 1;
    quest.amendments ??= [];
    // Una Quest Libre no tiene texto de campaña: se normaliza a cadena vacía.
    quest.campaignTitle ??= "";
    if (quest.battle) {
      const battle = quest.battle;
      battle.attempt ??= 1;
      battle.suspendedMs ??= 0;
      // Sin semilla no hay secuencia reproducible: se le da una estable.
      battle.combatSeed ||= `${quest.id}:${battle.startedAt}`;
      battle.encounterSeed ||= `${quest.id}:encounter`;
      battle.settledPressureMs ??= 0;
      battle.appliedCriticalWindows ??= [];
      battle.attempts ??= [
        { attempt: battle.attempt, startedAt: battle.startedAt, durationMinutes: battle.durationMinutes, deadlineAt: battle.deadlineAt },
      ];
      // Una Battle anterior al grupo y a la formación 4v4 los estrena ahora.
      battle.party ??= freshParty(state.player);
      battle.agent ??= emptyAgentSlot();
      // UNA MIGRACIÓN NO PUEDE RESUCITAR AL ENEMIGO.
      // Antes de la formación 4v4 la Horda era una barra: si estaba en 10 HP
      // porque el jugador la había bajado a golpes reales, la formación nueva
      // tiene que nacer con esos mismos 10 repartidos, no con 100.
      const validatedImpact = quest.steps.reduce((sum, step) => sum + (step.impactAwarded ?? 0), 0);
      const historicHealth = Math.max(0, 100 - validatedImpact);
      if (!battle.enemies || battle.enemies.length === 0) {
        battle.enemies = backfillEncounter(battle.encounterSeed, historicHealth);
      } else if (battle.enemies.reduce((sum, enemy) => sum + enemy.health, 0) > historicHealth) {
        // Repara una formación que YA nació resucitada por una migración
        // anterior. Sólo baja, nunca sube: si el combo de un compañero dejó a
        // la Horda por debajo del contrato, ese daño extra se respeta.
        battle.enemies = backfillEncounter(battle.encounterSeed, historicHealth);
      }
      if ((battle.status as string) === "lost") battle.status = "awaiting_replan";
      // NOMBRE VISIBLE ≠ ID INTERNO: una formación guardada antes de la
      // corrección canónica lleva «Roko» dentro. Se corrige el nombre y NADA
      // más: id, HP, escudo y cicatrices siguen exactamente igual.
      refreshPartyDisplay(battle.party, state.player);
      // UNA SOLA FUENTE AUTORITATIVA. Nunca `won` en una vista y `active` en
      // otra: si el contrato está validado, la Battle está ganada aquí también.
      reconcileBattleProjection(quest, nowMs);
    }
    for (const step of quest.steps) {
      step.impactAwarded ??= step.status === "completed" ? step.weight : 0;
      step.evidenceIds ??= [];
      step.artifactIds ??= [];
    }
  }
  for (const artifact of state.artifacts) {
    artifact.stepIds ??= [artifact.stepId];
  }
  // El roster base se reconoce siempre; sus contadores siguen en cero hasta
  // que alguien pelee de verdad. B-003: conocido no es haber participado.
  ensureRoster(state, isoAt(nowMs));
  // Un reino con historia previa recupera su carrera UNA vez, desde datos
  // autoritativos y deduplicando reintentos. Nunca inventa lo que no consta.
  backfillHeroCareer(state, nowMs);
  // BACKFILL SEGURO: sólo estado accionable ahora, idempotente por `key`.
  // Los registros nuevos persisten en la siguiente mutación; mientras tanto
  // el snapshot ya los ve, así que el jugador nunca «pierde» un pacto.
  backfillNotifications(state, nowMs);
  // Y lo contrario del backfill: lo que ya no pide nada se jubila. Un frente
  // ganado o abandonado no puede seguir llamando a la puerta.
  settleClosedNotifications(state, nowMs);
  return state;
}

export class JsonRealmStore implements RealmStore {
  /**
   * UNA COLA POR JUGADOR.
   *
   * La cola serializa las escrituras de un mismo reino; una sola cola global
   * haría que el reino de un jugador esperara al de otro sin ninguna razón.
   *
   * Sigue siendo una cola EN MEMORIA: con dos procesos, dos escrituras se
   * pisan. Eso lo cierra la etapa 3 (ADR-0003), y por eso `fly.toml` fija
   * `max_machines_running = 1`.
   */
  private readonly queues = new Map<PlayerId, Promise<unknown>>();

  constructor(
    /**
     * Archivo del jugador por defecto. Los demás cuelgan de `realms/` junto a
     * él, así que el reino que ya existe en producción NO se mueve de sitio.
     */
    private readonly statePath: string,
    /** El reloj es una dependencia: el almacén tampoco lo consulta por su cuenta. */
    private readonly clock: Clock = systemClock,
  ) {}

  /** Dónde vive el reino de cada jugador. El de siempre, donde siempre. */
  private pathFor(playerId: PlayerId): string {
    if (playerId === DEFAULT_PLAYER_ID) return this.statePath;
    return resolve(dirname(this.statePath), "realms", `${requirePlayerId(playerId)}.json`);
  }

  private queueFor(playerId: PlayerId): Promise<unknown> {
    return this.queues.get(playerId) ?? Promise.resolve();
  }

  async init(playerId: PlayerId = DEFAULT_PLAYER_ID): Promise<void> {
    const path = this.pathFor(playerId);
    await mkdir(dirname(path), { recursive: true });
    try {
      await readFile(path, "utf8");
    } catch {
      await this.write(createInitialState(this.clock.now(), playerId), playerId);
    }
  }

  async read(playerId: PlayerId = DEFAULT_PLAYER_ID): Promise<RealmState> {
    const nowMs = this.clock.now();
    const raw = await readFile(this.pathFor(playerId), "utf8").catch(async (error) => {
      // Un jugador nuevo estrena reino en su primera lectura, no antes.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.init(playerId);
      return readFile(this.pathFor(playerId), "utf8");
    });
    const state = JSON.parse(raw) as RealmState;
    // El reino que existía antes del sujeto se adopta al leerse. NO se mueve de
    // archivo y no pierde nada: sólo pasa a tener dueño (artículo 10).
    state.playerId ??= playerId;
    return migrateRealm(state, nowMs);
  }

  async mutate<T>(
    mutation: (state: RealmState) => T | Promise<T>,
    playerId: PlayerId = DEFAULT_PLAYER_ID,
  ): Promise<{ result: T; state: RealmState }> {
    const operation = this.queueFor(playerId).then(async () => {
      const state = await this.read(playerId);
      const result = await mutation(state);
      state.updatedAt = this.clock.iso();
      await this.write(state, playerId);
      return { result, state };
    });

    this.queues.set(playerId, operation.then(() => undefined, () => undefined));
    return operation;
  }

  async reset(playerId: PlayerId = DEFAULT_PLAYER_ID): Promise<RealmState> {
    const operation = this.queueFor(playerId).then(async () => {
      const state = createInitialState(this.clock.now(), playerId);
      await this.write(state, playerId);
      return state;
    });
    this.queues.set(playerId, operation.then(() => undefined, () => undefined));
    return operation;
  }

  /** Borra el reino de un jugador. El del jugador por defecto también. */
  async forget(playerId: PlayerId = DEFAULT_PLAYER_ID): Promise<boolean> {
    const operation = this.queueFor(playerId).then(async () => {
      try {
        await rm(this.pathFor(playerId), { force: true });
        return true;
      } catch {
        return false;
      }
    });
    this.queues.set(playerId, operation.then(() => undefined, () => undefined));
    return operation;
  }

  private async write(state: RealmState, playerId: PlayerId): Promise<void> {
    const path = this.pathFor(playerId);
    await mkdir(dirname(path), { recursive: true });
    const tempPath = `${path}.${process.pid}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
  }
}
