import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RealmState } from "./domain.js";

const now = () => new Date().toISOString();

export function createInitialState(): RealmState {
  return {
    version: 1,
    realmId: randomUUID(),
    player: {
      displayName: "Marqués Phi",
      title: "Guardián de la Marca",
    },
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
    state.artifacts ??= [];
    state.lifeEvents ??= [];
    state.gameEvents ??= [];
    // Reinos anteriores a la hoja de personaje empiezan en cero, no en inventado.
    state.character ??= { xp: 0, aura: 0, mastery: {}, rewardedQuestIds: [] };
    state.character.mastery ??= {};
    state.character.rewardedQuestIds ??= [];
    for (const quest of state.quests) {
      quest.version ??= 1;
      quest.amendments ??= [];
      if (quest.battle) {
        quest.battle.attempt ??= 1;
        quest.battle.appliedThresholds ??= [];
        quest.battle.suspendedMs ??= 0;
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
