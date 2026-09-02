import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { emptyAgentSlot } from "./companions.js";
import type { RealmState } from "./domain.js";
import { backfillEncounter } from "./horde.js";
import { freshParty } from "./party.js";

const now = () => new Date().toISOString();

export function createInitialState(): RealmState {
  return {
    version: 1,
    realmId: randomUUID(),
    player: {
      displayName: "Marqués Phi",
      title: "Guardián de la Marca",
    },
    inventory: { items: [], initializedAt: undefined },
    companionAssists: [],
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
    evidence: [],
    artifacts: [],
    lifeEvents: [],
    gameEvents: [],
    updatedAt: now(),
  };
}

export class JsonRealmStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly statePath: string) {}

  async init(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    try {
      await readFile(this.statePath, "utf8");
    } catch {
      await this.write(createInitialState());
    }
  }

  async read(): Promise<RealmState> {
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
    // Un hecho sin entidad no se puede abrir: los históricos apuntan a su quest.
    for (const event of state.events) {
      event.entityType ??= "quest";
      event.entityId ??= event.questId ?? "";
    }
    state.artifacts ??= [];
    state.lifeEvents ??= [];
    state.gameEvents ??= [];
    // Reinos anteriores a la hoja de personaje empiezan en cero, no en inventado.
    state.character ??= { xp: 0, aura: 0, mastery: {}, rewardedQuestIds: [] };
    state.inventory ??= { items: [] };
    state.inventory.items ??= [];
    state.companionAssists ??= [];
    state.character.mastery ??= {};
    state.character.rewardedQuestIds ??= [];
    for (const quest of state.quests) {
      quest.version ??= 1;
      quest.amendments ??= [];
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
        // Una espera externa nunca puede exponer una Battle activa.
        if (battle.status === "active" && quest.status === "waiting_external") battle.status = "suspended_external";
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
    return state;
  }

  async mutate<T>(mutation: (state: RealmState) => T | Promise<T>): Promise<{ result: T; state: RealmState }> {
    const operation = this.queue.then(async () => {
      const state = await this.read();
      const result = await mutation(state);
      state.updatedAt = now();
      await this.write(state);
      return { result, state };
    });

    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async reset(): Promise<RealmState> {
    const operation = this.queue.then(async () => {
      const state = createInitialState();
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
