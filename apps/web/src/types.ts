export type QuestStatus = "draft" | "accepted" | "active" | "waiting_external" | "completed" | "abandoned";

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
  status: "pending" | "in_progress" | "blocked" | "superseded" | "completed";
  blockedBy?: string;
  blockedReason?: string;
  blockedSince?: string;
  playerActionAvailable?: boolean;
  followUpAfter?: string;
  supersededReason?: string;
}

export interface QuestAmendment {
  id: string;
  status: "proposed" | "accepted" | "rejected";
  reason: string;
  proposedBy: string;
  previousVersion: number;
  newVersion: number;
  changes: Array<{ type: string; stepId?: string; reason?: string }>;
  createdAt: string;
  acceptedAt?: string;
}

export interface RewardProfile {
  xpMax: number;
  auraMax: number;
  masteryDomain?: string;
}

export interface CharacterStats {
  displayName: string;
  title: string;
  hp: number;
  maxHp: number;
  xp: number;
  aura: number;
  mastery: Array<{ domain: string; points: number }>;
  treasure: { currency: "COP"; amount: number };
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
  version: number;
  amendments: QuestAmendment[];
  rewardProfile?: RewardProfile;
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
      type: "quest_created" | "quest_revised" | "quest_accepted" | "quest_started" | "quest_amendment_proposed" | "quest_amended" | "quest_waiting_external" | "quest_unblocked" | "horde_attack" | "evidence_attached" | "step_completed" | "quest_completed" | "reward_granted" | "quest_abandoned";
      questId: string;
      message: string;
      createdAt: string;
    }>;
    evidence: Array<{ id: string; stepId: string; verdict: "rejected" | "partial" | "accepted"; impactAwarded: number; reasoning: string; artifactIds?: string[] }>;
    artifacts: Array<{
      id: string;
      stepId: string;
      stepIds: string[];
      kind: "file" | "link" | "text";
      label: string;
      verification: { verified: boolean; detail: string };
    }>;
    lifeEvents: Array<{ id: string; evidenceId: string; impactAwarded: number }>;
    gameEvents: Array<{ id: string; type: "quest_attack" | "horde_attack"; questId: string; sourceLifeEventId: string; damage: number; message: string; reason?: string; createdAt: string }>;
  };
  currentQuest: Quest | null;
  stats: CharacterStats;
  battle: null | {
    questId: string;
    player: { id: "marques-phi"; health: number; maxHealth: 100 };
    enemy: { id: "horda"; health: number; maxHealth: 100 };
    playerHealth: number;
    playerMaxHealth: 100;
    enemyHealth: number;
    enemyMaxHealth: 100;
    progress: number;
    completedSteps: number;
    totalSteps: number;
    isKo: boolean;
    isPlayerKo: boolean;
  };
  consistency: {
    status: "ok" | "warning" | "desynced";
    instance: string;
    realmId: string;
    currentQuestId: string | null;
  };
  projectedMargin: number;
}
