import { randomUUID } from "node:crypto";
import type {
  BattleState,
  Quest,
  QuestPlanInput,
  RealmEvent,
  RealmSnapshot,
  RealmState,
} from "./domain.js";
import { JsonRealmStore } from "./store.js";

const now = () => new Date().toISOString();

function requireQuest(state: RealmState, questId: string): Quest {
  const quest = state.quests.find((candidate) => candidate.id === questId);
  if (!quest) throw new Error(`Quest no encontrada: ${questId}`);
  return quest;
}

function validatePlan(plan: QuestPlanInput): void {
  if (plan.steps.length < 1 || plan.steps.length > 12) {
    throw new Error("Una quest debe tener entre 1 y 12 pasos.");
  }
  const totalWeight = plan.steps.reduce((sum, step) => sum + step.weight, 0);
  if (totalWeight !== 100) {
    throw new Error(`Los pesos de los pasos deben sumar 100; actualmente suman ${totalWeight}.`);
  }
  if (plan.durationMinutes < 5 || plan.durationMinutes > 240) {
    throw new Error("La duración debe estar entre 5 y 240 minutos.");
  }
}

function addEvent(state: RealmState, event: Omit<RealmEvent, "id" | "createdAt">): void {
  state.events.unshift({ id: randomUUID(), createdAt: now(), ...event });
  state.events = state.events.slice(0, 100);
}

export function battleFor(quest: Quest | null): BattleState | null {
  if (!quest) return null;
  const damage = quest.steps
    .filter((step) => step.status === "completed")
    .reduce((sum, step) => sum + step.weight, 0);
  const completedSteps = quest.steps.filter((step) => step.status === "completed").length;
  return {
    questId: quest.id,
    enemyMaxHealth: 100,
    enemyHealth: Math.max(0, 100 - damage),
    progress: Math.min(100, damage),
    completedSteps,
    totalSteps: quest.steps.length,
    isKo: damage === 100,
  };
}

function currentQuest(state: RealmState): Quest | null {
  return (
    state.quests.find((quest) => quest.status === "active") ??
    state.quests.find((quest) => quest.status === "accepted") ??
    state.quests.find((quest) => quest.status === "draft") ??
    state.quests[0] ??
    null
  );
}

export class QuestService {
  constructor(private readonly store: JsonRealmStore) {}

  async snapshot(): Promise<RealmSnapshot> {
    const realm = await this.store.read();
    const quest = currentQuest(realm);
    const { availableBalance, expectedIncome, committedExpenses, reserveTarget } = realm.financial;
    return {
      realm,
      currentQuest: quest,
      battle: battleFor(quest),
      projectedMargin: availableBalance + expectedIncome - committedExpenses - reserveTarget,
    };
  }

  async createDraft(plan: QuestPlanInput): Promise<Quest> {
    validatePlan(plan);
    const { result } = await this.store.mutate((state) => {
      const conflicting = state.quests.find((quest) => ["accepted", "active"].includes(quest.status));
      if (conflicting) throw new Error(`Ya existe una quest ${conflicting.status}: ${conflicting.title}`);
      const timestamp = now();
      const quest: Quest = {
        ...plan,
        id: randomUUID(),
        status: "draft",
        steps: plan.steps.map((step) => ({
          ...step,
          id: randomUUID(),
          status: "pending",
        })),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      state.quests.unshift(quest);
      addEvent(state, { type: "quest_created", questId: quest.id, message: `El Códice redactó «${quest.title}».` });
      return quest;
    });
    return result;
  }

  async reviseDraft(questId: string, plan: QuestPlanInput): Promise<Quest> {
    validatePlan(plan);
    const { result } = await this.store.mutate((state) => {
      const quest = requireQuest(state, questId);
      if (quest.status !== "draft") throw new Error("Solo se puede reformular una quest en borrador.");
      Object.assign(quest, plan, {
        steps: plan.steps.map((step) => ({ ...step, id: randomUUID(), status: "pending" as const })),
        updatedAt: now(),
      });
      addEvent(state, { type: "quest_revised", questId, message: `El contrato de «${quest.title}» fue reformulado.` });
      return quest;
    });
    return result;
  }

  async accept(questId: string, userAccepted: boolean): Promise<Quest> {
    if (!userAccepted) throw new Error("La aceptación explícita del usuario es obligatoria.");
    const { result } = await this.store.mutate((state) => {
      const quest = requireQuest(state, questId);
      if (quest.status !== "draft") throw new Error("Solo se puede aceptar una quest en borrador.");
      quest.status = "accepted";
      quest.acceptedAt = now();
      quest.updatedAt = quest.acceptedAt;
      addEvent(state, { type: "quest_accepted", questId, message: `El marqués aceptó «${quest.title}».` });
      return quest;
    });
    return result;
  }

  async start(questId: string): Promise<Quest> {
    const { result } = await this.store.mutate((state) => {
      const quest = requireQuest(state, questId);
      if (quest.status !== "accepted") throw new Error("La quest debe estar aceptada antes de comenzar.");
      quest.status = "active";
      quest.startedAt = now();
      quest.updatedAt = quest.startedAt;
      addEvent(state, { type: "quest_started", questId, message: `Comienza la batalla: «${quest.title}».` });
      return quest;
    });
    return result;
  }

  async completeStep(questId: string, stepId: string, evidenceNote: string): Promise<{ quest: Quest; battle: BattleState }> {
    const { result } = await this.store.mutate((state) => {
      const quest = requireQuest(state, questId);
      if (quest.status !== "active") throw new Error("La quest debe estar activa para completar pasos.");
      const step = quest.steps.find((candidate) => candidate.id === stepId);
      if (!step) throw new Error(`Paso no encontrado: ${stepId}`);
      if (step.status === "completed") {
        return { quest, battle: battleFor(quest)! };
      }
      if (!evidenceNote.trim()) throw new Error("Describe brevemente la evidencia del paso.");
      step.status = "completed";
      step.evidenceNote = evidenceNote.trim();
      step.completedAt = now();
      quest.updatedAt = step.completedAt;
      addEvent(state, {
        type: "step_completed",
        questId,
        message: `${step.title}: impacto de ${step.weight} puntos.`,
      });
      const battle = battleFor(quest)!;
      if (battle.isKo) {
        quest.status = "completed";
        quest.completedAt = now();
        quest.updatedAt = quest.completedAt;
        addEvent(state, { type: "quest_completed", questId, message: `KO: «${quest.title}» fue completada.` });
      }
      return { quest, battle };
    });
    return result;
  }

  async abandon(questId: string, reason: string): Promise<Quest> {
    const { result } = await this.store.mutate((state) => {
      const quest = requireQuest(state, questId);
      if (!["draft", "accepted", "active"].includes(quest.status)) {
        throw new Error("Esta quest ya no puede abandonarse.");
      }
      quest.status = "abandoned";
      quest.abandonedAt = now();
      quest.updatedAt = quest.abandonedAt;
      addEvent(state, { type: "quest_abandoned", questId, message: `Retirada: ${reason.trim() || "sin motivo registrado"}.` });
      return quest;
    });
    return result;
  }

  async reset(): Promise<RealmSnapshot> {
    await this.store.reset();
    return this.snapshot();
  }
}

export const demoQuest: QuestPlanInput = {
  campaignTitle: "Segundo estandarte",
  title: "Cinco puertas",
  intent: "Avanzar hacia un segundo trabajo compatible con mi perfil y bienestar.",
  outcome: "Enviar cinco candidaturas verificables a vacantes de alta compatibilidad.",
  rationale: "Prioriza vacantes relevantes y convierte una intención amplia en resultados comprobables.",
  durationMinutes: 60,
  wellbeingConstraints: ["Preferencia remota o híbrida", "Horario compatible con la actividad principal"],
  allowedApps: ["Gmail", "Google Drive", "LinkedIn", "Navegador"],
  steps: [
    { title: "Definir la guardia", description: "Confirmar salario, horario y modalidad aceptables.", actor: "shared", evidence: "Criterios registrados", weight: 10 },
    { title: "Revelar las puertas", description: "Localizar y escoger cinco vacantes compatibles.", actor: "codex", evidence: "Cinco enlaces vigentes", weight: 15 },
    { title: "Templar el acero", description: "Adaptar la hoja de vida al grupo de vacantes.", actor: "shared", evidence: "Versión final del CV", weight: 20 },
    { title: "Preparar los estandartes", description: "Redactar mensajes y respuestas requeridas.", actor: "shared", evidence: "Textos listos para revisión", weight: 15 },
    { title: "Cruzar las cinco puertas", description: "Enviar las cinco candidaturas.", actor: "user", evidence: "Confirmaciones de envío", weight: 40 },
  ],
};

