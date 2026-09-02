export type QuestStatus = "draft" | "accepted" | "active" | "waiting_external" | "completed" | "abandoned";
export type StepStatus = "pending" | "in_progress" | "blocked" | "superseded" | "completed";
export type StepActor = "user" | "codex" | "shared";
export type EvidenceSource = "user_declaration" | "file" | "mcp" | "integration" | "api";
export type EvidenceVerdict = "rejected" | "partial" | "accepted";
export type EvidenceKind = "file" | "link" | "screenshot" | "photo" | "number" | "text" | "declaration";
export type ArtifactKind = "file" | "link" | "text";
/**
 * Estado del frente.
 *
 *   active             — hay reloj corriendo.
 *   awaiting_replan    — venció el plazo con la Horda viva. No es el fin.
 *   awaiting_recovery  — el Marqués cayó. Hay que levantarlo antes de volver.
 *   won                — el contrato quedó validado al 100%.
 */
export type BattleStatus = "active" | "awaiting_replan" | "awaiting_recovery" | "won";
export type AttemptEndReason = "won" | "timeout" | "recontracted" | "player_ko" | "abandoned";
/** El cuarto slot no es un personaje fijo: lo ocupa quien de verdad peleó. */
export type CompanionId = "opus" | "codex" | "claude" | "gemini";
export type EnemyPosition = "front" | "back";
export type EnemyRole = "tank" | "ranged" | "assassin" | "breaker" | "support" | "drain" | "mage" | "disruptor" | "berserker" | "captain";
/**
 * A quién ataca cada arquetipo. Roko protege, pero no intercepta una flecha
 * disparada por encima de él ni un salto de asesino.
 */
export type TargetPolicy = "frontline" | "backline" | "lowest_health" | "shield_first" | "weighted";
export type PartyMemberId = "roko" | "marques" | "cordera";
/** Un Acto es planificación operativa del Códice: no exige ceremonia propia. */
export type ActStatus = "locked" | "available" | "active" | "completed" | "abandoned";
/** Una Campaña sí exige pacto: nace en borrador y sólo el jugador la activa. */
export type CampaignStatus = "draft" | "active" | "completed" | "abandoned";

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

/**
 * Lo que el personaje se lleva de una quest cumplida.
 *
 * Aquí no hay moneda ficticia: el Tesoro sólo cambia cuando cambia el dinero
 * real del reino. XP y Aura sí son progresión del personaje, y se conceden por
 * resultado validado, nunca por tiempo ni por clics.
 */
export interface RewardProfile {
  /** Si el contrato no los declara, se derivan de la duración y los cuidados pactados. */
  xpMax?: number;
  auraMax?: number;
  /** Dominio de maestría que esta quest entrena. Sin dominio no hay maestría. */
  masteryDomain?: string;
}

/**
 * INVENTARIO.
 *
 * Los objetos se gastan. El Core valida existencia, cantidad y destino antes
 * de aplicar nada: el renderer nunca decrementa por su cuenta.
 */
export type InventoryItemId = "revive_tonic" | "health_potion";

export interface InventoryEntry {
  itemId: InventoryItemId;
  quantity: number;
}

export interface InventoryState {
  items: InventoryEntry[];
  /** Marca el reparto inicial. Recargar o redesplegar no vuelve a concederlo. */
  initializedAt?: string;
}

export interface CharacterState {
  xp: number;
  /** Calidad de vida, identidad y bienestar: no es puntuación de actividad. */
  aura: number;
  mastery: Record<string, number>;
  /** Quests cuya recompensa ya se concedió. Hace la recompensa idempotente. */
  rewardedQuestIds: string[];
}

/** Vista de personaje lista para cualquier renderer (React hoy, Unity después). */
export interface CharacterStats {
  displayName: string;
  title: string;
  hp: number;
  maxHp: number;
  xp: number;
  aura: number;
  mastery: Array<{ domain: string; points: number }>;
  /** Dinero real del reino. Nunca se inventa por completar quests. */
  treasure: { currency: "COP"; amount: number };
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
  rewardProfile?: RewardProfile;
  steps: QuestStepInput[];
}

export interface Quest extends Omit<QuestPlanInput, "steps"> {
  id: string;
  status: QuestStatus;
  /** Padres opcionales. Una microquest los tiene todos vacíos y eso es legítimo. */
  actId?: string;
  campaignId?: string;
  sagaId?: string;
  steps: QuestStep[];
  createdAt: string;
  updatedAt: string;
  acceptedAt?: string;
  startedAt?: string;
  completedAt?: string;
  abandonedAt?: string;
  version: number;
  amendments: QuestAmendment[];
  /** La Battle temporizada de esta Quest. No existe hasta que el jugador inicia. */
  battle?: BattleRecord;
}

/**
 * EL RELOJ ES PARTE DEL ENEMIGO.
 *
 * El registro vive en el Core, no en el renderer: cerrar la app, bloquear el
 * teléfono o cambiar de pantalla no congela la Battle. Al volver, el servidor
 * calcula cuánto tiempo pasó de verdad.
 */
export interface BattleAttemptRecord {
  attempt: number;
  startedAt: string;
  durationMinutes: number;
  deadlineAt: string;
  endedAt?: string;
  endReason?: AttemptEndReason;
}

export interface BattleRecord {
  /** Intento en curso. Cada replan abre uno nuevo sobre el MISMO campo. */
  attempt: number;
  attempts: BattleAttemptRecord[];
  startedAt: string;
  durationMinutes: number;
  deadlineAt: string;
  status: BattleStatus;
  /**
   * Semilla del combate. El crítico NO lo tira el renderer: se deriva de
   * `combatSeed + ventana`, así que reabrir la app no vuelve a tirar.
   */
  combatSeed: string;
  /** Semilla del encuentro. Replanificar NO da enemigos más fáciles. */
  encounterSeed: string;
  /** Presión suspendida por un bloqueo externo real, en milisegundos. */
  suspendedMs: number;
  suspendedAt?: string;
  /**
   * Milisegundos de reloj activo ya convertidos en daño, acumulados entre
   * intentos. El Core no escribe un evento por segundo: liquida por ventanas.
   */
  settledPressureMs: number;
  /** Ventanas de crítico ya cobradas. Recargar no las repite. */
  appliedCriticalWindows: number[];
  /**
   * REPLANIFICAR NO BORRA LAS CICATRICES.
   *
   * El grupo y la Horda se guardan aquí, no se derivan del historial: el log
   * de eventos está acotado y una batalla larga lo desbordaría, así que
   * derivarlo haría que las heridas se curasen solas al llenarse el log.
   */
  party: PartyState;
  enemies: EnemyCombatant[];
  agent: AgentSlot;
  hordeNeutralizedAt?: string;
  /** Nuevo pacto temporal propuesto por Códice y aún sin aceptar. */
  pendingRecontract?: { id: string; reason: string; newDurationMinutes: number; proposedAt: string };
  endedAt?: string;
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
    | "battle_started"
    | "battle_won"
    | "battle_lost"
    | "battle_restarted"
    | "evidence_attached"
    | "step_completed"
    | "quest_completed"
    | "reward_granted"
    | "quest_abandoned"
    | "campaign_created"
    | "campaign_revised"
    | "campaign_accepted"
    | "campaign_focused"
    | "campaign_completed"
    | "campaign_abandoned"
    | "act_created"
    | "act_completed"
    | "quest_assigned";
  /**
   * A QUÉ ENTIDAD se refiere este hecho.
   *
   * La notificación NUNCA puede elegir su objetivo con heurísticas como «el
   * último borrador» o «la quest actual»: si el evento no dice exactamente
   * qué cambió, el jugador acaba abriendo otra cosa.
   */
  entityType: "quest" | "campaign" | "act" | "saga";
  entityId: string;
  /** Compatibilidad: presente sólo cuando el hecho ocurre dentro de una quest. */
  questId?: string;
  message: string;
  createdAt: string;
}

/**
 * Una ayuda REAL de un compañero.
 *
 * Nace `used_pending_validation` y no concede nada. Sólo cuando la evidencia
 * del paso queda aceptada se convierte en ataque combinado: Opus no golpea
 * porque su nombre exista.
 */
export interface CompanionAssist {
  id: string;
  questId: string;
  stepId: string;
  companion: CompanionId;
  source: "mcp" | "internal" | "integration";
  sourceTool?: string;
  executionRef?: string;
  contributionSummary: string;
  status: "used_pending_validation" | "contribution_validated" | "expired";
  bonusDamage?: number;
  createdAt: string;
  validatedAt?: string;
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

/**
 * Contrato renderer-agnóstico. React lo dibuja hoy; Unity podrá consumir los
 * mismos eventos mañana sin portar ninguna regla de negocio.
 */
export interface GameEvent {
  id: string;
  type:
    | "quest_attack"
    | "horde_attack"
    | "horde_pressure"
    | "enemy_special"
    | "enemy_ko"
    | "horde_neutralized"
    | "encounter_generated"
    | "party_heal"
    | "shield_gained"
    | "shield_absorbed"
    | "party_member_ko"
    | "party_member_revived"
    | "party_member_healed"
    | "inventory_item_used"
    | "inventory_item_granted"
    | "companion_used"
    | "companion_combo_attack"
    | "agent_deployed"
    | "battle_started"
    | "battle_recontracted"
    | "battle_won"
    | "battle_lost";
  /** Los eventos de ciclo de vida de la Battle no nacen de un LifeEvent. */
  sourceLifeEventId?: string;
  questId: string;
  stepId?: string;
  damage: number;
  /** Por qué atacó la Horda: `time_pressure` es el reloj, no la inactividad. */
  reason?: string;
  /** Umbral temporal cobrado (histórico). */
  threshold?: number;
  /** Ventana de ataque 1..10. `questId + attackIndex` se aplica una sola vez. */
  attackIndex?: number;
  /** A quién golpea, cura o escuda este evento. */
  target?: PartyMemberId;
  /** El crítico no acorta el reloj: acorta el margen de supervivencia. */
  critical?: boolean;
  /** Quién dio el golpe, cuando la Horda tiene rostro. */
  sourceEnemyId?: string;
  abilityId?: string;
  /** Desglose de un golpe sostenido: cada línea es atribuible. */
  allocations?: DamageAllocation[];
  /** Reparto del ataque del Marqués entre los enemigos vivos. */
  enemyAllocations?: EnemyAllocation[];
  companion?: CompanionId;
  itemId?: InventoryItemId;
  /** Intento de Battle al que pertenece: un reintento no arrastra daño viejo. */
  battleAttempt?: number;
  message: string;
  createdAt: string;
}

/**
 * SAGA -> CAMPAÑA -> ACTO -> QUEST -> BATALLA -> PASOS.
 *
 * `scenario` NO es una unidad de la jerarquía: es el entorno visual de un Acto
 * o de una Campaña. Y una microquest puede vivir sin padres: no se fabrican
 * Actos ceremoniales para un correo de quince minutos.
 */
export interface Act {
  id: string;
  campaignId?: string;
  sagaId?: string;
  title: string;
  /** Subtítulo del acto: «La comunicación bloqueada». */
  subtitle?: string;
  /** Qué deja hecho este acto cuando cierra. */
  outcome?: string;
  status: ActStatus;
  questIds: string[];
  estimatedActiveMinutes: number;
  /** Ambientación visual, no jerarquía. */
  scenario?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface Campaign {
  id: string;
  sagaId?: string;
  title: string;
  /** Qué recupera el reino con esta campaña. */
  summary?: string;
  /** Resultado final verificable de toda la campaña. */
  objective?: string;
  /** La intención literal del jugador que originó la campaña. */
  intent?: string;
  /** Por qué esta agrupación produce el resultado. */
  rationale?: string;
  status: CampaignStatus;
  actIds: string[];
  estimatedActiveMinutes: number;
  /** Horizonte de calendario. NO es trabajo activo y no cambia la escala. */
  estimatedCalendarDays?: number;
  acceptedAt?: string;
  scenario?: string;
  /** Nombre del jefe final: hoy sólo la representación de la última Quest. */
  bossTitle?: string;
  bossDescription?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface Saga {
  id: string;
  title: string;
  summary?: string;
  status: CampaignStatus;
  campaignIds: string[];
  estimatedActiveMinutes: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface RealmState {
  version: 1;
  /** Identidad del reino. Permite distinguir el reino local del de la nube. */
  realmId: string;
  player: {
    displayName: string;
    title: string;
  };
  character: CharacterState;
  inventory: InventoryState;
  /** Ayudas reales de compañeros. Estar disponible no cuenta. */
  companionAssists: CompanionAssist[];
  financial: FinancialState;
  /**
   * MANY CAMPAIGNS. ONE ENGAGED BATTLE.
   *
   * El jugador sostiene varios frentes de vida a la vez —trabajo, firma,
   * desarrollo, personal—; la campaña en foco es la que mira, no la única viva.
   * Cambiar el foco no cierra ni reinicia ninguna otra.
   */
  focusedCampaignId?: string;
  sagas: Saga[];
  campaigns: Campaign[];
  acts: Act[];
  quests: Quest[];
  events: RealmEvent[];
  evidence: EvidenceRecord[];
  artifacts: EvidenceArtifact[];
  lifeEvents: LifeEvent[];
  gameEvents: GameEvent[];
  updatedAt: string;
}

/**
 * El grupo que sostiene el frente.
 *
 *   Roko    — Bruiser/Guardia. Escudo primero, vida después. No es tanque puro.
 *   Marqués — Arquero/DPS. El impacto validado se representa como ataque suyo.
 *   Cordera — Sanadora/Apoyo. El progreso real validado produce curación.
 *
 * No se guarda: se deriva de los GameEvents de la Battle en curso.
 */
export interface PartyMemberState {
  id: PartyMemberId;
  name: string;
  role: string;
  health: number;
  maxHealth: number;
  /** Sólo Roko lo tiene. */
  shield?: number;
  maxShield?: number;
  status: "active" | "ko";
}

export interface PartyState {
  roko: PartyMemberState;
  marques: PartyMemberState;
  cordera: PartyMemberState;
}

/**
 * EL AGENTE.
 *
 * El cuarto slot empieza vacío y sólo se llena cuando un compañero real
 * ejecutó algo. Estar disponible no es haber peleado.
 */
export interface AgentSlot {
  deployed: boolean;
  companion?: CompanionId;
  name?: string;
  role?: string;
  status: "undeployed" | "assist_ready" | "assist_validated";
  /** Otros compañeros que también ayudaron, sin ocupar la tarjeta. */
  secondaryAssists: CompanionId[];
  /** Daño de combo ya concedido en esta Battle. */
  comboDamage: number;
}

/** Un miembro de la Horda. La Horda dejó de ser una barra. */
export interface EnemyCombatant {
  id: string;
  archetypeId: string;
  name: string;
  role: EnemyRole;
  position: EnemyPosition;
  health: number;
  maxHealth: number;
  status: "active" | "ko";
  /** Daño por minuto que aporta mientras siga en pie. */
  pressureRate: number;
  criticalChance: number;
  targetPolicy: TargetPolicy;
  abilityId?: string;
  abilityName?: string;
}

/** Un golpe concreto, atribuible a quién lo dio y a quién lo recibió. */
export interface DamageAllocation {
  sourceEnemyId?: string;
  sourceName?: string;
  target: PartyMemberId;
  damage: number;
  absorbed: number;
  critical?: boolean;
  abilityId?: string;
}

/** El reparto del ataque del Marqués entre los enemigos vivos. */
export interface EnemyAllocation {
  enemyId: string;
  name: string;
  damage: number;
  killed: boolean;
}

/**
 * Reloj de la Battle derivado del servidor.
 *
 * PROHIBIDO que el renderer sea la única autoridad del tiempo: React interpola
 * entre lecturas, pero `elapsedMs` y `remainingMs` los calcula el Core contra
 * su propio reloj.
 */
export interface BattleClock {
  startedAt: string;
  deadlineAt: string;
  durationMinutes: number;
  serverNow: string;
  elapsedMs: number;
  remainingMs: number;
  /** 0 a 1. Los ataques de la Horda se cobran al cruzar 0.25, 0.5, 0.75 y 1. */
  elapsedRatio: number;
  expired: boolean;
  /** La presión está suspendida por un bloqueo externo real, no por un botón. */
  suspended: boolean;
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
  /** Duración pactada de la Battle. Nunca mayor que 60 minutos. */
  durationMinutes: number;
  status: BattleStatus | "pending";
  attempt: number;
  attempts: BattleAttemptRecord[];
  /** Roko, Marqués y Cordera. `playerHealth` es la vida del Marqués. */
  party: PartyState;
  /** El cuarto slot: quien de verdad ayudó, o nadie. */
  agent: AgentSlot;
  /** Cuatro enemigos con rostro, no una barra. */
  enemies: EnemyCombatant[];
  /** Toda la Horda caída. No es victoria: el contrato manda. */
  hordeNeutralized: boolean;
  /** Daño por minuto que la Horda viva está aplicando ahora mismo. */
  pressureRate: number;
  pendingRecontract?: { id: string; reason: string; newDurationMinutes: number };
  /** Null hasta que el jugador inicia: el reloj no corre en el borrador. */
  clock: BattleClock | null;
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

/** Nodo de mapa: una Quest vista desde el Acto que la contiene. */
export interface QuestNode {
  id: string;
  position: number;
  title: string;
  outcome: string;
  status: QuestStatus;
  durationMinutes: number;
  validatedImpact: number;
  percent: number;
  battleStatus: BattleStatus | "pending";
  /** El camino se abre en orden: un nodo bloqueado espera al anterior. */
  locked: boolean;
  isBoss: boolean;
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
  /** Quests colgadas directamente de la campaña, sin Acto intermedio. */
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

/**
 * Lo que necesita cualquier renderer para dibujar Campaña, Acto y Quest sin
 * recalcular reglas: la jerarquía y dónde está el jugador dentro de ella.
 */
export interface RealmHierarchy {
  sagas: SagaView[];
  campaigns: CampaignView[];
  /** Todas las campañas vivas a la vez. Ninguna cierra por perder el foco. */
  activeCampaignIds: string[];
  /** La que el jugador mira ahora mismo. */
  focusedCampaignId: string | null;
  /** La ÚNICA Battle con reloj corriendo. Null si el frente está libre. */
  engagedQuestId: string | null;
  currentSagaId: string | null;
  currentCampaignId: string | null;
  currentActId: string | null;
  currentQuestId: string | null;
  /** Quests sin padres. Una microquest legítima entra en batalla sin ceremonia. */
  standaloneQuests: QuestNode[];
}

export interface RealmSnapshot {
  realm: RealmState;
  currentQuest: Quest | null;
  /** Progreso derivado del impacto validado, para que Códice no lo recalcule. */
  progress: QuestProgress | null;
  /** Paso accionable derivado en la lectura; nunca un puntero guardado. */
  currentStep: CurrentStepSummary | null;
  battle: BattleState | null;
  /** Hoja de personaje derivada: HP de combate, XP, Aura, maestría y Tesoro. */
  stats: CharacterStats;
  /** Los objetos se gastan: aquí está lo que queda. */
  inventory: InventoryState;
  /** Saga, Campaña, Acto y Quest derivados en la lectura, nunca guardados. */
  hierarchy: RealmHierarchy;
  /**
   * Lo que concederá esta quest si se valida: XP, Aura y maestría.
   * Nunca monedas ni gemas: el Tesoro sólo cambia con un hecho financiero real.
   */
  rewardPreview: { xp: number; aura: number; masteryDomain?: string } | null;
  consistency: RealmConsistency;
  projectedMargin: number;
}
