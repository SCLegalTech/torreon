export type QuestStatus = "draft" | "accepted" | "active" | "waiting_external" | "completed" | "abandoned";
export type StepStatus = "pending" | "in_progress" | "blocked" | "superseded" | "completed";
export type StepActor = "user" | "codex" | "shared";
export type EvidenceSource = "user_declaration" | "file" | "mcp" | "integration" | "api";
export type EvidenceVerdict = "rejected" | "partial" | "accepted";
export type EvidenceKind = "file" | "link" | "screenshot" | "photo" | "number" | "text" | "declaration";
export type ArtifactKind = "file" | "link" | "text";

export interface QuestStepInput {
  title: string;
  description?: string;
  actor: StepActor;
  evidence: string;
  /** Qué clase de prueba espera este paso. Guía la entrega y el veredicto. */
  evidenceKind?: EvidenceKind;
  /** Qué debe comprobar el Códice en esa prueba antes de conceder impacto. */
  verificationHint?: string;
  weight: number;
}

export interface QuestStep extends QuestStepInput {
  id: string;
  status: StepStatus;
  impactAwarded: number;
  evidenceIds: string[];
  artifactIds: string[];
  evidenceNote?: string;
  completedAt?: string;
  supersededAt?: string;
  supersededReason?: string;
  blockedBy?: string;
  blockedReason?: string;
  blockedSince?: string;
  playerActionAvailable?: boolean;
  followUpAfter?: string;
}

export type QuestAmendmentChange =
  | { type: "ADD_STEP"; step: QuestStepInput }
  | { type: "MODIFY_STEP"; stepId: string; patch: Partial<QuestStepInput> }
  | { type: "SUPERSEDE_STEP"; stepId: string; reason: string }
  | { type: "MARK_EXTERNAL_BLOCKER"; stepId: string; blockedBy: string; blockedReason: string; playerActionAvailable: boolean; followUpAfter?: string }
  | { type: "UNBLOCK_STEP"; stepId: string; reason: string };

export interface QuestAmendment {
  id: string;
  status: "proposed" | "accepted" | "rejected";
  reason: string;
  proposedBy: string;
  previousVersion: number;
  newVersion: number;
  changes: QuestAmendmentChange[];
  createdAt: string;
  acceptedAt?: string;
  rejectedAt?: string;
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
  version: number;
  amendments: QuestAmendment[];
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
  type:
    | "quest_created"
    | "quest_revised"
    | "quest_accepted"
    | "quest_started"
    | "quest_amendment_proposed"
    | "quest_amended"
    | "quest_waiting_external"
    | "quest_unblocked"
    | "horde_attack"
    | "evidence_attached"
    | "step_completed"
    | "quest_completed"
    | "quest_abandoned";
  questId: string;
  message: string;
  createdAt: string;
}

export interface EvidenceRecord {
  id: string;
  questId: string;
  stepId: string;
  summary: string;
  source: EvidenceSource;
  verdict: EvidenceVerdict;
  reasoning: string;
  impactAwarded: number;
  artifactIds: string[];
  createdAt: string;
}

/**
 * Un artefacto es un hecho del mundo real entregado al MCP: un documento, un
 * enlace o un texto. El servidor comprueba lo comprobable antes de que Códice
 * emita un veredicto; por eso `verification` no la escribe el modelo.
 */
export interface EvidenceArtifact {
  id: string;
  questId: string;
  stepId: string;
  /** Todos los pasos que reutilizan estos mismos bytes/hecho observable. */
  stepIds: string[];
  kind: ArtifactKind;
  label: string;
  mimeType?: string;
  bytes?: number;
  sha256?: string;
  url?: string;
  sourcePath?: string;
  storedPath?: string;
  excerpt?: string;
  /**
   * Quién comprobó el artefacto.
   *   server  — el servidor abrió los bytes: tamaño, tipo, hash, extracto.
   *   witness — un Dungeon Master con el archivo delante lo examinó y declaró
   *             qué vio. El servidor nunca tuvo los bytes, pero la prueba fue
   *             mirada por alguien capaz de leerla, no solo afirmada.
   */
  verification: { verified: boolean; verifiedBy?: "server" | "witness"; witness?: string; detail: string; checkedAt: string };
  createdAt: string;
}

export interface LifeEvent {
  id: string;
  type: "evidence_submitted" | "unexpected_requirement";
  questId: string;
  stepId?: string;
  evidenceId?: string;
  verdict?: EvidenceVerdict;
  impactAwarded?: number;
  reason?: string;
  createdAt: string;
}

export interface GameEvent {
  id: string;
  type: "quest_attack" | "horde_attack";
  sourceLifeEventId: string;
  questId: string;
  stepId?: string;
  damage: number;
  reason?: string;
  message: string;
  createdAt: string;
}

export interface RealmState {
  version: 1;
  /** Identidad del reino. Permite distinguir el reino local del de la nube. */
  realmId: string;
  player: {
    displayName: string;
    title: string;
  };
  financial: FinancialState;
  quests: Quest[];
  events: RealmEvent[];
  evidence: EvidenceRecord[];
  artifacts: EvidenceArtifact[];
  lifeEvents: LifeEvent[];
  gameEvents: GameEvent[];
  updatedAt: string;
}

export interface BattleState {
  questId: string;
  player: { id: "marques-phi"; health: number; maxHealth: 100 };
  enemy: { id: "horda"; health: number; maxHealth: 100 };
  playerHealth: number;
  playerMaxHealth: 100;
  enemyMaxHealth: 100;
  enemyHealth: number;
  progress: number;
  completedSteps: number;
  totalSteps: number;
  isKo: boolean;
  isPlayerKo: boolean;
}


export interface QuestProgress {
  questId: string;
  /** Impacto validado por evidencia, no pasos marcados. ACTIVITY IS NOT PROGRESS. */
  validatedImpact: number;
  remainingImpact: number;
  percent: number;
  completedSteps: number;
  totalSteps: number;
}

export interface CurrentStepSummary {
  id: string;
  position: number;
  title: string;
  actor: StepActor;
  evidence: string;
  evidenceKind?: EvidenceKind;
  verificationHint?: string;
  weight: number;
  impactAwarded: number;
  remainingImpact: number;
  status: StepStatus;
}

export interface RealmConsistency {
  status: "ok" | "warning" | "desynced";
  /** Qué instancia de Torreón respondió: distingue el reino local del de la nube. */
  instance: string;
  realmId: string;
  activeQuestCount: number;
  currentQuestId: string | null;
  issues: Array<{
    code: "MULTIPLE_ACTIVE_QUESTS" | "ORPHAN_EVIDENCE" | "ORPHAN_ARTIFACT" | "EMPTY_REALM";
    entityId?: string;
    message: string;
  }>;
}

export interface QuestStepDetail extends CurrentStepSummary {
  description?: string;
  blockedBy?: string;
  blockedReason?: string;
  blockedSince?: string;
  playerActionAvailable?: boolean;
  followUpAfter?: string;
  supersededReason?: string;
  artifacts: EvidenceArtifact[];
  verdicts: EvidenceRecord[];
}

export interface QuestDetail {
  id: string;
  campaignTitle: string;
  title: string;
  intent: string;
  outcome: string;
  rationale: string;
  status: QuestStatus;
  durationMinutes: number;
  wellbeingConstraints: string[];
  allowedApps: string[];
  createdAt: string;
  acceptedAt?: string;
  startedAt?: string;
  completedAt?: string;
  abandonedAt?: string;
  version: number;
  amendments: QuestAmendment[];
  progress: QuestProgress;
  currentStep: CurrentStepSummary | null;
  steps: QuestStepDetail[];
}

export interface RealmSnapshot {
  realm: RealmState;
  currentQuest: Quest | null;
  /** Progreso derivado del impacto validado, para que Códice no lo recalcule. */
  progress: QuestProgress | null;
  /** Paso accionable derivado en la lectura; nunca un puntero guardado. */
  currentStep: CurrentStepSummary | null;
  battle: BattleState | null;
  consistency: RealmConsistency;
  projectedMargin: number;
}
