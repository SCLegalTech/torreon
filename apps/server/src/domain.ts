export type QuestStatus = "draft" | "accepted" | "active" | "completed" | "abandoned";
export type StepStatus = "pending" | "in_progress" | "completed";
export type StepActor = "user" | "codex" | "shared";
export type EvidenceSource = "user_declaration" | "file" | "mcp" | "integration" | "api";
export type EvidenceVerdict = "rejected" | "partial" | "accepted";
export type EvidenceKind = "file" | "link" | "screenshot" | "number" | "text" | "declaration";
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
  type:
    | "quest_created"
    | "quest_revised"
    | "quest_accepted"
    | "quest_started"
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
  type: "evidence_submitted";
  questId: string;
  stepId: string;
  evidenceId: string;
  verdict: EvidenceVerdict;
  impactAwarded: number;
  createdAt: string;
}

export interface GameEvent {
  id: string;
  type: "quest_attack";
  sourceLifeEventId: string;
  questId: string;
  stepId: string;
  damage: number;
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
  enemyMaxHealth: 100;
  enemyHealth: number;
  progress: number;
  completedSteps: number;
  totalSteps: number;
  isKo: boolean;
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
