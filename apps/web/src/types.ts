export type QuestStatus = "draft" | "accepted" | "active" | "completed" | "abandoned";

export interface QuestStep {
  id: string;
  title: string;
  description?: string;
  actor: "user" | "codex" | "shared";
  evidence: string;
  evidenceKind?: "file" | "link" | "screenshot" | "photo" | "number" | "text" | "declaration";
  verificationHint?: string;
  evidenceNote?: string;
  evidenceIds: string[];
  artifactIds: string[];
  impactAwarded: number;
  weight: number;
  status: "pending" | "in_progress" | "completed";
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
    realmId: string;
    player: { displayName: string; title: string };
    financial: {
      currency: "COP";
      availableBalance: number;
      expectedIncome: number;
      committedExpenses: number;
      reserveTarget: number;
    };
    events: Array<{
      id: string;
      type: "quest_created" | "quest_revised" | "quest_accepted" | "quest_started" | "evidence_attached" | "step_completed" | "quest_completed" | "quest_abandoned";
      questId: string;
      message: string;
      createdAt: string;
    }>;
    evidence: Array<{ id: string; stepId: string; verdict: "rejected" | "partial" | "accepted"; impactAwarded: number; reasoning: string; artifactIds?: string[] }>;
    artifacts: Array<{
      id: string;
      stepId: string;
      kind: "file" | "link" | "text";
      label: string;
      verification: { verified: boolean; detail: string };
    }>;
    lifeEvents: Array<{ id: string; evidenceId: string; impactAwarded: number }>;
    gameEvents: Array<{ id: string; sourceLifeEventId: string; damage: number; message: string }>;
  };
  currentQuest: Quest | null;
  battle: null | {
    questId: string;
    enemyHealth: number;
    progress: number;
    completedSteps: number;
    totalSteps: number;
    isKo: boolean;
  };
  consistency: {
    status: "ok" | "warning" | "desynced";
    instance: string;
    realmId: string;
    currentQuestId: string | null;
  };
  projectedMargin: number;
}
