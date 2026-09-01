export type QuestStatus = "draft" | "accepted" | "active" | "completed" | "abandoned";
export type StepStatus = "pending" | "completed";
export type StepActor = "user" | "codex" | "shared";

export interface QuestStepInput {
  title: string;
  description?: string;
  actor: StepActor;
  evidence: string;
  weight: number;
}

export interface QuestStep extends QuestStepInput {
  id: string;
  status: StepStatus;
  evidenceNote?: string;
  completedAt?: string;
}

export interface QuestPlanInput {
  campaignTitle: string;
  title: string;
  intent: string;
  outcome: string;
  rationale: string;
  durationMinutes: number;
  wellbeingConstraints: string[];
  allowedApps: string[];
  steps: QuestStepInput[];
}

export interface Quest extends Omit<QuestPlanInput, "steps"> {
  id: string;
  status: QuestStatus;
  steps: QuestStep[];
  createdAt: string;
  updatedAt: string;
  acceptedAt?: string;
  startedAt?: string;
  completedAt?: string;
  abandonedAt?: string;
}

export interface FinancialState {
  currency: "COP";
  availableBalance: number;
  expectedIncome: number;
  committedExpenses: number;
  reserveTarget: number;
}

export interface RealmEvent {
  id: string;
  type: "quest_created" | "quest_revised" | "quest_accepted" | "quest_started" | "step_completed" | "quest_completed" | "quest_abandoned";
  questId: string;
  message: string;
  createdAt: string;
}

export interface RealmState {
  version: 1;
  player: {
    displayName: string;
    title: string;
  };
  financial: FinancialState;
  quests: Quest[];
  events: RealmEvent[];
  updatedAt: string;
}

export interface BattleState {
  questId: string;
  enemyMaxHealth: 100;
  enemyHealth: number;
  progress: number;
  completedSteps: number;
  totalSteps: number;
  isKo: boolean;
}

export interface RealmSnapshot {
  realm: RealmState;
  currentQuest: Quest | null;
  battle: BattleState | null;
  projectedMargin: number;
}

