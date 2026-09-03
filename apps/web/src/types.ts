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

export type BattleStatus = "pending" | "active" | "suspended_external" | "awaiting_replan" | "awaiting_recovery" | "won";
export type CompanionId = "opus" | "codex" | "claude" | "gemini";
export type InventoryItemId = "revive_tonic" | "health_potion";

export interface InventoryState {
  items: Array<{ itemId: InventoryItemId; quantity: number }>;
  initializedAt?: string;
}

/** El cuarto slot: sólo lo ocupa quien de verdad ejecutó algo. */
export interface AgentSlot {
  deployed: boolean;
  companion?: CompanionId;
  name?: string;
  role?: string;
  status: "undeployed" | "assist_ready" | "assist_validated";
  secondaryAssists: CompanionId[];
  comboDamage: number;
}

/** Un miembro de la Horda. La Horda dejó de ser una barra. */
export interface EnemyCombatant {
  id: string;
  archetypeId: string;
  name: string;
  role: string;
  position: "front" | "back";
  health: number;
  maxHealth: number;
  status: "active" | "ko";
  pressureRate: number;
  criticalChance: number;
  targetPolicy: string;
  abilityId?: string;
  abilityName?: string;
}

export interface BattleAttemptRecord {
  attempt: number;
  startedAt: string;
  durationMinutes: number;
  deadlineAt: string;
  endedAt?: string;
  endReason?: "won" | "timeout" | "recontracted" | "player_ko" | "abandoned";
}
export type PartyMemberId = "roko" | "marques" | "cordera";

/** Roko protege, Marqués ataca, Cordera sostiene. El Core deriva sus cifras. */
export interface PartyMemberState {
  id: PartyMemberId;
  name: string;
  role: string;
  health: number;
  maxHealth: number;
  shield?: number;
  maxShield?: number;
  status: "active" | "ko";
}

export interface PartyState {
  roko: PartyMemberState;
  marques: PartyMemberState;
  cordera: PartyMemberState;
}
export type ActStatus = "locked" | "available" | "active" | "completed" | "abandoned";
export type CampaignStatus = "draft" | "active" | "completed" | "abandoned";
export type EntityType = "quest" | "campaign" | "act" | "saga";

/** El reloj lo calcula el servidor; React sólo interpola entre lecturas. */
export interface BattleClock {
  startedAt: string;
  deadlineAt: string;
  durationMinutes: number;
  serverNow: string;
  elapsedMs: number;
  remainingMs: number;
  elapsedRatio: number;
  expired: boolean;
  suspended: boolean;
}

export interface BattleRecord {
  attempt: number;
  startedAt: string;
  durationMinutes: number;
  deadlineAt: string;
  status: "active" | "suspended_external" | "awaiting_replan" | "awaiting_recovery" | "won";
}

export interface QuestNode {
  id: string;
  position: number;
  title: string;
  outcome: string;
  status: QuestStatus;
  durationMinutes: number;
  validatedImpact: number;
  percent: number;
  battleStatus: BattleStatus;
  locked: boolean;
  isBoss: boolean;
  /** `standalone` = Quick Battle sin Campaña ni Acto. */
  scope: "standalone" | "campaign";
  /** 💰 GASTO/INGRESO RECURRENTE si la Quick Battle representa dinero real. */
  financeKind?: "expense" | "income";
}

export interface ActView {
  id: string;
  position: number;
  title: string;
  subtitle?: string;
  outcome?: string;
  scenario?: string;
  status: ActStatus;
  estimatedActiveMinutes: number;
  quests: QuestNode[];
  completedQuests: number;
  totalQuests: number;
  percent: number;
  locked: boolean;
}

export interface CampaignView {
  id: string;
  title: string;
  summary?: string;
  objective?: string;
  intent?: string;
  rationale?: string;
  status: CampaignStatus;
  estimatedActiveMinutes: number;
  estimatedCalendarDays?: number;
  scenario?: string;
  bossTitle?: string;
  bossDescription?: string;
  acts: ActView[];
  directQuests: QuestNode[];
  completedActs: number;
  totalActs: number;
  completedQuests: number;
  totalQuests: number;
  percent: number;
}

export interface SagaView {
  id: string;
  title: string;
  summary?: string;
  status: CampaignStatus;
  campaignIds: string[];
  completedCampaigns: number;
  totalCampaigns: number;
  percent: number;
}

export interface RealmHierarchy {
  sagas: SagaView[];
  campaigns: CampaignView[];
  /** Varias campañas vivas a la vez; ninguna cierra por perder el foco. */
  activeCampaignIds: string[];
  focusedCampaignId: string | null;
  /** La Quest que el jugador mira. La fija sólo focus_quest. */
  focusedQuestId: string | null;
  focusedActId: string | null;
  /** La única Battle con reloj corriendo. */
  engagedQuestId: string | null;
  currentSagaId: string | null;
  currentCampaignId: string | null;
  currentActId: string | null;
  currentQuestId: string | null;
  /** ⚡ BATALLAS LIBRES: Quests sin padres. */
  standaloneQuests: QuestNode[];
}

export type NotificationEntityType = "quest" | "campaign" | "act" | "saga" | "obligation";
export type NotificationType =
  | "quest_created"
  | "campaign_created"
  | "quest_amendment_proposed"
  | "battle_recontract_proposed"
  | "quest_waiting_external"
  | "quest_unblocked"
  | "battle_lost"
  | "recurring_obligation_due"
  | "companion_result";

export interface NotificationView {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  entityType: NotificationEntityType;
  entityId: string;
  priority: "normal" | "high";
  deepLink: { screen: "quest" | "campaign" | "act" | "battle" | "treasury"; entityId: string };
  createdAt: string;
  read: boolean;
  archived: boolean;
  push: { lastAttemptAt: string | null; lastStatus: "sent" | "failed" | "unknown"; attempts: number };
  bucket: "hoy" | "ayer" | "anteriores";
}

export type ObligationDirection = "expense" | "income";
export type ObligationFrequency = "weekly" | "biweekly" | "monthly" | "bimonthly" | "quarterly" | "yearly";

export interface ObligationView {
  id: string;
  name: string;
  direction: ObligationDirection;
  category: string;
  frequency: ObligationFrequency;
  expectedAmount: number | null;
  currency: "COP";
  provider?: string;
  nextDueDate: string | null;
  periodStatus: "paid" | "pending" | "upcoming";
  currentPeriod: string;
  lastPaidPeriod: string | null;
  active: boolean;
  autoProposeBattle: boolean;
}

export interface TreasuryView {
  currency: "COP";
  observedBalance: number;
  expectedIncome: number;
  committedExpenses: number;
  reserveTarget: number;
  projectedMargin: number;
  upcomingObligations: ObligationView[];
  recurring: ObligationView[];
}

export interface Entitlements {
  plan: "free" | "premium" | "dev";
  dailyBattleLimit: number | null;
  dailyCodiceCallLimit: number | null;
  adsEnabled: boolean;
  reasoningCallsPerDay: number | null;
  visionValidationsPerDay: number | null;
  agentExecutionsPerDay: number | null;
}

export interface UsageCounters {
  period: string;
  battlesStartedToday: number;
  codiceReasoningCalls: number;
  visionValidations: number;
  agentOrchestrations: number;
}

export interface Quest {
  id: string;
  campaignTitle: string;
  actId?: string;
  campaignId?: string;
  sagaId?: string;
  battle?: BattleRecord;
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
      type:
        | "quest_created" | "quest_revised" | "quest_accepted" | "quest_started"
        | "quest_amendment_proposed" | "quest_amended" | "quest_waiting_external" | "quest_unblocked"
        | "horde_attack" | "battle_started" | "battle_won" | "battle_lost" | "battle_restarted"
        | "evidence_attached" | "step_completed" | "quest_completed" | "reward_granted" | "quest_abandoned"
        | "campaign_created" | "campaign_revised" | "campaign_accepted" | "campaign_focused"
        | "campaign_completed" | "campaign_abandoned"
        | "act_created" | "act_completed" | "act_focused" | "quest_assigned"
        | "quest_deleted" | "quest_focused"
        | "recurring_obligation_created" | "recurring_obligation_updated" | "financial_transaction_recorded";
      /** A qué entidad se refiere el hecho. La notificación nunca adivina. */
      entityType: EntityType;
      entityId: string;
      questId?: string;
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
    gameEvents: Array<{
      id: string;
      type:
        | "quest_attack"
        | "horde_attack"
        | "horde_pressure"
        | "enemy_special"
        | "enemy_ko"
        | "horde_neutralized"
        | "encounter_generated"
        | "party_member_revived"
        | "party_member_healed"
        | "inventory_item_used"
        | "inventory_item_granted"
        | "companion_used"
        | "companion_combo_attack"
        | "agent_deployed"
        | "battle_recontracted"
        | "party_heal"
        | "shield_gained"
        | "shield_absorbed"
        | "party_member_ko"
        | "battle_started"
        | "battle_won"
        | "battle_lost";
      questId: string;
      sourceLifeEventId?: string;
      damage: number;
      message: string;
      reason?: string;
      threshold?: number;
      attackIndex?: number;
      target?: PartyMemberId;
      critical?: boolean;
      sourceEnemyId?: string;
      companion?: CompanionId;
      itemId?: InventoryItemId;
      allocations?: Array<{ sourceEnemyId?: string; sourceName?: string; target: PartyMemberId; damage: number; absorbed: number; critical?: boolean }>;
      enemyAllocations?: Array<{ enemyId: string; name: string; damage: number; killed: boolean }>;
      battleAttempt?: number;
      createdAt: string;
    }>;
  };
  currentQuest: Quest | null;
  /** NOTIFICATION IS NOT FOCUS. FOCUS IS NOT ENGAGEMENT. */
  focusedQuest?: Quest | null;
  engagedQuest?: Quest | null;
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
    durationMinutes: number;
    status: BattleStatus;
    attempt: number;
    attempts: BattleAttemptRecord[];
    party: PartyState;
    agent: AgentSlot;
    enemies: EnemyCombatant[];
    hordeNeutralized: boolean;
    pressureRate: number;
    pendingRecontract?: { id: string; reason: string; newDurationMinutes: number };
    clock: BattleClock | null;
  };
  inventory: InventoryState;
  hierarchy: RealmHierarchy;
  /** Lo que concede el Core al validar esta quest. Ni monedas ni gemas inventadas. */
  rewardPreview: { xp: number; aura: number; masteryDomain?: string } | null;
  consistency: {
    status: "ok" | "warning" | "desynced";
    instance: string;
    realmId: string;
    currentQuestId: string | null;
  };
  projectedMargin: number;
  /** Centro de Notificaciones: registro persistente, no la última push. */
  notifications?: NotificationView[];
  unreadNotifications?: number;
  /** Tesorería viva derivada del estado financiero real. */
  treasury?: TreasuryView;
  entitlements?: Entitlements;
  usage?: UsageCounters;
}
