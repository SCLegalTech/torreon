import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { backfillHeroCareer, ensureRoster } from "./barracks.js";
import { reconcileBattleProjection } from "./battle.js";
import { emptyAgentSlot } from "./companions.js";
import type { RealmState } from "./domain.js";
import { backfillEncounter } from "./horde.js";
import { backfillNotifications, settleClosedNotifications } from "./notifications.js";
import { freshParty, refreshPartyDisplay } from "./party.js";
import { DEV_ENTITLEMENTS, freshUsage, rolloverUsage } from "./product.js";
import { isoAt, systemClock, type Clock } from "./clock.js";


export function createInitialState(nowMs: number): RealmState {
  return {
    version: 1,
    realmId: randomUUID(),
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

export class JsonRealmStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly statePath: string,
    /** El reloj es una dependencia: el almacén tampoco lo consulta por su cuenta. */
    private readonly clock: Clock = systemClock,
  ) {}

  async init(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    try {
      await readFile(this.statePath, "utf8");
    } catch {
      await this.write(createInitialState(this.clock.now()));
    }
  }

  async read(): Promise<RealmState> {
    const nowMs = this.clock.now();
    const raw = await readFile(this.statePath, "utf8");
    const state = JSON.parse(raw) as RealmState;
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
        battle.party ??= freshParty();
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
        refreshPartyDisplay(battle.party);
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

  async mutate<T>(mutation: (state: RealmState) => T | Promise<T>): Promise<{ result: T; state: RealmState }> {
    const operation = this.queue.then(async () => {
      const state = await this.read();
      const result = await mutation(state);
      state.updatedAt = this.clock.iso();
      await this.write(state);
      return { result, state };
    });

    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async reset(): Promise<RealmState> {
    const operation = this.queue.then(async () => {
      const state = createInitialState(this.clock.now());
      await this.write(state);
      return state;
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async write(state: RealmState): Promise<void> {
    const tempPath = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tempPath, this.statePath);
  }
}
