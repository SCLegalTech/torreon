export type QuestStatus = "draft" | "accepted" | "active" | "completed" | "abandoned";

export interface QuestStep {
  id: string;
  title: string;
  description?: string;
  actor: "user" | "codex" | "shared";
  evidence: string;
  evidenceNote?: string;
  weight: number;
  status: "pending" | "completed";
}

export interface Quest {
  id: string;
  campaignTitle: string;
  title: string;
  intent: string;
  outcome: string;
  rationale: string;
  durationMinutes: number;
  wellbeingConstraints: string[];
  allowedApps: string[];
  status: QuestStatus;
  steps: QuestStep[];
}

export interface RealmSnapshot {
  realm: {
    player: { displayName: string; title: string };
    financial: {
      currency: "COP";
      availableBalance: number;
      expectedIncome: number;
      committedExpenses: number;
      reserveTarget: number;
    };
    events: Array<{ id: string; message: string; createdAt: string }>;
  };
  currentQuest: Quest | null;
  battle: null | {
    enemyHealth: number;
    progress: number;
    completedSteps: number;
    totalSteps: number;
    isKo: boolean;
  };
  projectedMargin: number;
}

