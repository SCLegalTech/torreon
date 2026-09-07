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
 *   suspended_external — la quest espera a un tercero. El slot está libre y la
 *                        presión detenida: una Battle suspendida NO puede
 *                        parecer activa, o el renderer mostraría un combate
 *                        que el Core ya soltó.
 *   awaiting_replan    — venció el plazo con la Horda viva. No es el fin.
 *   awaiting_recovery  — el Marqués cayó. Hay que levantarlo antes de volver.
 *   won                — el contrato quedó validado al 100%.
 */
export type BattleStatus = "active" | "suspended_external" | "awaiting_replan" | "awaiting_recovery" | "won";
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
/**
 * BARRACAS.
 *
 * Un héroe es un miembro del grupo o un agente real. El id interno es estable
 * —`roko` sigue siendo `roko` en toda la historia persistida— y el nombre
 * visible se resuelve en la lectura: renombrar la pantalla nunca rompe el log.
 */
export type HeroId = PartyMemberId | CompanionId;
export type HeroKind = "party" | "agent";
/** Si un conector desaparece, el héroe NO se borra: se marca no disponible. */
export type HeroAvailability = "connected" | "available" | "unavailable" | "unknown";
/**
 * ESTAR INSTALADO NO ES HABER PELEADO.
 *
 *   known                  — el reino sabe que existe.
 *   available              — podría asistir.
 *   deployed               — ocupa el cuarto slot de una Battle viva.
 *   participated           — ejecutó algo real alguna vez.
 *   contribution_validated — una evidencia aceptada citó su ejecución.
 *   unavailable            — el conector ya no responde. La historia se queda.
 */
export type AgentDeploymentState =
  | "known"
  | "available"
  | "deployed"
  | "participated"
  | "contribution_validated"
  | "unavailable";
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
  /**
   * Nombre de la campaña a la que pertenece la quest, si pertenece a una.
   * Una Quest Libre (standalone) no tiene campaña: este campo es opcional y no
   * se fabrica una campaña ficticia para rellenarlo.
   */
  campaignTitle?: string;
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

export interface Quest extends Omit<QuestPlanInput, "steps" | "campaignTitle"> {
  id: string;
  /** Texto de campaña, ya normalizado. Vacío en una Quest Libre. */
  campaignTitle: string;
  status: QuestStatus;
  /** Padres opcionales. Una microquest los tiene todos vacíos y eso es legítimo. */
  actId?: string;
  campaignId?: string;
  sagaId?: string;
  /**
   * POSITION IS PRESENTATION, NOT PERMISSION.
   *
   * Una Quest sólo espera turno si DECLARA aquí de quién depende y esa Quest
   * sigue abierta. Estar tercera en una lista no bloquea nada.
   */
  dependsOnQuestIds?: string[];
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
  /**
   * Nuevo pacto temporal propuesto por Códice y aún sin aceptar. Se acepta por
   * `id`: si Códice propuso 30 min y luego 15, hay que saber cuál se selló.
   */
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
    | "battle_started"
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
    | "quest_deleted"
    | "quest_focused"
    | "campaign_created"
    | "campaign_revised"
    | "campaign_accepted"
    | "campaign_focused"
    | "campaign_completed"
    | "campaign_abandoned"
    | "act_created"
    | "act_completed"
    | "act_focused"
    | "quest_assigned"
    | "recurring_obligation_created"
    | "recurring_obligation_updated"
    | "financial_transaction_recorded"
    | "hero_level_up"
    | "hero_discovered"
    | "after_action_report"
    | "event_invalidated";
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
  /**
   * SAME REAL EXECUTION -> SAME ASSIST RECORD.
   *
   * `questId:stepId:companion:executionRef`, o `…:sourceTool` dentro de una
   * ventana corta cuando no hay referencia. Un reintento de red no infla stats,
   * ni XP, ni combo, ni historia.
   */
  assistKey?: string;
  createdAt: string;
  validatedAt?: string;
}

/**
 * UNA EJECUCIÓN REAL DE UN COMPAÑERO.
 *
 * Permite que el frontend vea «OPUS HA ENTRADO EN COMBATE» sin esperar al final
 * de la Quest. Una ejecución NO concede daño: sólo prueba participación.
 */
export interface CompanionExecution {
  executionRef: string;
  companionId: CompanionId;
  questId: string;
  stepId?: string;
  tool?: string;
  startedAt: string;
  completedAt?: string;
  status: "running" | "succeeded" | "failed";
  summary: string;
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

/**
 * ANULAR NO ES BORRAR.
 *
 * Un hecho registrado por error operativo se marca `invalidated`: la auditoría
 * lo conserva y las proyecciones de gameplay lo ignoran. Nunca hard delete: la
 * historia no se falsifica ni hacia arriba ni hacia abajo.
 */
export interface EventInvalidation {
  status?: "recorded" | "invalidated";
  invalidatedAt?: string;
  invalidatedBy?: string;
  invalidationReason?: string;
}

export interface LifeEvent extends EventInvalidation {
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
export interface GameEvent extends EventInvalidation {
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
    | "companion_execution_started"
    | "companion_execution_completed"
    | "companion_assist_validated"
    | "hero_level_up"
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
  /** Héroe al que se refiere el hecho (subida de nivel, hazaña, ejecución). */
  heroId?: HeroId;
  /** Nivel alcanzado en un `hero_level_up`. */
  level?: number;
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
  /**
   * ACTOS EN PARALELO POR DEFECTO.
   *
   * Un Acto no se bloquea por su POSICIÓN: sólo si declara aquí una dependencia
   * explícita y ese Acto todavía no está cerrado. Sin dependencia, disponible.
   */
  dependsOnActIds?: string[];
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

// ---------------------------------------------------------------------------
// BARRACAS — LA PARTIDA RECUERDA LO QUE HIZO
//
// AN AGENT IS A HERO ONLY WHEN IT ACTUALLY PARTICIPATES.
// LEVEL IS NOT PERMISSION.
//
// Aquí no hay Life Score, Productivity Score ni Worth Score: las estadísticas
// son específicas, explicables y nacen de hechos validados, nunca de clics.
// ---------------------------------------------------------------------------

/** Un hecho legible atado a la Quest, el paso y la prueba que lo respaldan. */
export interface HeroDeed {
  id: string;
  heroId: HeroId;
  questId: string;
  questTitle: string;
  stepId?: string;
  summary: string;
  sourceTool?: string;
  /** `verified` exige evidencia aceptada. Nunca se narra una hazaña sin hecho. */
  outcome: "participated" | "verified" | "victory";
  evidenceId?: string;
  createdAt: string;
}

/**
 * CARRERA ≠ COMBATE.
 *
 * El HP de una Battle vive en `BattleRecord.party`. Esto es lo que sobrevive a
 * todas las batallas y jamás lo pisa un snapshot viejo de vida.
 */
export interface HeroCareerStats {
  battlesEntered: number;
  battlesWon: number;
  questsCompleted: number;
  campaignsCompleted: number;
  /** Impacto validado acumulado. NO es dinero ni puntuación de vida. */
  validatedImpact: number;
  executions: number;
  successfulExecutions: number;
  validatedAssists: number;
  /** Impacto validado de los pasos que este agente asistió. Nunca son pesos. */
  supportedImpact: number;
  questsAssisted: number;
  battlesWonWithParty: number;
}

export interface HeroCareerState {
  id: HeroId;
  kind: HeroKind;
  xp: number;
  level: number;
  /** Maestrías explicables: cada punto viene de un resultado validado. */
  masteries: Record<string, number>;
  stats: HeroCareerStats;
  known: boolean;
  availability: HeroAvailability;
  firstSeenAt: string;
  lastDeployedAt?: string;
  lastQuestId?: string;
  deeds: HeroDeed[];
}

/** Cómo se explica una maestría. Sin esto, el número sería magia. */
export interface MasteryBreakdown {
  domain: string;
  points: number;
  evidence: string[];
}

export interface HeroAbilityView {
  id: string;
  name: string;
  description: string;
  /** Se dispara desde hechos reales del Core, jamás desde un botón de ataque. */
  triggeredBy: string;
}

export interface HeroProfileView {
  id: HeroId;
  kind: HeroKind;
  displayName: string;
  className: string;
  level: number;
  xp: number;
  xpIntoLevel: number;
  xpToNextLevel: number;
  availability: HeroAvailability;
  deployment: AgentDeploymentState;
  stats: HeroCareerStats;
  masteries: MasteryBreakdown[];
  capabilities: string[];
  abilities: HeroAbilityView[];
  recentDeeds: HeroDeed[];
  lastDeployedAt?: string;
}

/** La última formación que peleó de verdad. Memoria emocional de la partida. */
export interface LastFormationView {
  questId: string;
  questTitle: string;
  result: "victory" | "in_progress" | "unresolved";
  heroes: Array<{ id: HeroId; displayName: string; kind: HeroKind }>;
  endedAt?: string;
}

export interface BarracksView {
  heroes: HeroProfileView[];
  lastFormation: LastFormationView | null;
}

/**
 * INFORME DE ACCIÓN.
 *
 * Determinista: se genera desde eventos, sin pedirle nada a ningún modelo.
 * La narrativa, si algún día llega, va ENCIMA de estos hechos.
 */
export interface AfterActionReport {
  id: string;
  questId: string;
  questTitle: string;
  attempts: number;
  plannedDurationMinutes: number;
  /** Reloj activo real: descuenta la espera externa. */
  actualActiveMs: number;
  externalWaitMs: number;
  replans: number;
  unexpectedRequirements: number;
  toolsUsed: string[];
  companionsUsed: CompanionId[];
  party: string[];
  agentContribution: { executions: number; assistedSteps: number; comboDamage: number };
  hordeNeutralized: boolean;
  result: "victory";
  outcome: string;
  lessons: string[];
  createdAt: string;
}

/** Una lección concreta y reutilizable. No es chat guardado. */
export interface BattleLesson {
  id: string;
  questId: string;
  /** Firma normalizada de la actividad, para poder recuperarla al planear. */
  signature: string;
  text: string;
  createdAt: string;
}

/**
 * PLAYBOOK.
 *
 * Cuando una actividad se repite, el reino puede reconocerla. Nunca auto-acepta
 * ni auto-inicia: Códice pregunta, y la evidencia del período nuevo es nueva.
 */
export interface QuestPlaybook {
  id: string;
  signature: string;
  title: string;
  steps: QuestStepInput[];
  typicalDurationMinutes: number;
  evidenceExpectations: string[];
  preferredCompanions: CompanionId[];
  knownFriction: string[];
  timesUsed: number;
  createdAt: string;
  updatedAt: string;
}

/** Lo que el reino aprendió sobre cuánto dura de verdad un trabajo así. */
export interface DurationMemory {
  signature: string;
  title: string;
  samples: number;
  plannedMedianMinutes: number;
  actualMedianMinutes: number;
  /** > 1 significa que el reino subestima sistemáticamente este trabajo. */
  driftRatio: number;
}

export interface BattleMemoryView {
  durations: DurationMemory[];
  lessons: BattleLesson[];
  playbooks: QuestPlaybook[];
  reports: AfterActionReport[];
}

/**
 * SISTEMAS DEL MUNDO.
 *
 * TREASURY IS NOT A QUICK BATTLE. La jerarquía de navegación la fija el Core,
 * no la maqueta: Barracas y Tesorería son hermanas de Batallas Libres, nunca
 * hijas suyas.
 */
export interface WorldSystemView {
  id: "battle" | "quick_battles" | "campaigns" | "barracks" | "treasury" | "notifications";
  icon: string;
  label: string;
  detail: string;
  screen: string;
  entityId?: string;
  badge?: number;
}

/**
 * LA FICHA DEL JUGADOR.
 *
 * `archetype` es a quién encarna: `marques` o `cordera`. Roku NO se encarna —es
 * la mascota— y por eso sólo lleva nombre. Los ids internos del grupo no
 * cambian nunca: el nombre se resuelve al leer (ver `character.ts`).
 */
export interface PlayerSheet {
  displayName: string;
  title: string;
  /** A quién encarna. Ausente en reinos anteriores a la ficha. */
  archetype?: "marques" | "cordera";
  /** Cómo se llama la mascota. Ausente = Roku. */
  petName?: string;
  /** Marca que la ficha ya se creó. Sin esto, la app la pide. */
  createdAt?: string;
}

export interface RealmState {
  version: 1;
  /** Identidad del reino. Permite distinguir el reino local del de la nube. */
  realmId: string;
  /**
   * DE QUIÉN ES ESTE REINO.
   *
   * La raíz de agregado (artículo 10, ADR-0002). Un reino sin dueño no tiene
   * dónde poner al segundo jugador, y eso bloquea Play Store entero.
   */
  playerId: string;
  player: PlayerSheet;
  character: CharacterState;
  inventory: InventoryState;
  /** Ayudas reales de compañeros. Estar disponible no cuenta. */
  companionAssists: CompanionAssist[];
  /** Ejecuciones reales, para ver al agente entrar antes de que cierre la Quest. */
  companionExecutions: CompanionExecution[];
  /** Carrera persistente de cada héroe, por id interno estable. */
  heroes: Record<string, HeroCareerState>;
  /**
   * Marca de la reconstrucción ÚNICA de carrera sobre historia ya existente.
   *
   * Sólo se reconstruye desde datos autoritativos —asistencias registradas y
   * Quests completadas— y deduplicando por ejecución real: los reintentos que
   * inflaron el registro antiguo NO se convierten en hazañas.
   */
  heroesBackfilledAt?: string;
  /**
   * RETRIES MUST NOT CREATE FAKE HISTORY.
   *
   * Claves de recompensa ya aplicadas (XP, stats, hazañas). Un reintento
   * técnico encuentra su clave y no concede nada por segunda vez.
   */
  progressionLedger: string[];
  /** Informes de acción deterministas de cada Battle ganada. */
  afterActionReports: AfterActionReport[];
  battleLessons: BattleLesson[];
  playbooks: QuestPlaybook[];
  financial: FinancialState;
  /**
   * MANY CAMPAIGNS. ONE ENGAGED BATTLE.
   *
   * El jugador sostiene varios frentes de vida a la vez —trabajo, firma,
   * desarrollo, personal—; la campaña en foco es la que mira, no la única viva.
   * Cambiar el foco no cierra ni reinicia ninguna otra.
   */
  focusedCampaignId?: string;
  /**
   * BACKLOG NO ES FOCO. FOCO NO ES COMPROMISO.
   *
   * `focusedQuestId` — la Quest que el jugador está mirando. La fija sólo una
   * navegación explícita (`focus_quest`); crear un borrador NUNCA la mueve.
   * El compromiso (la Battle con reloj) se deriva aparte y es la única que
   * ataca al jugador.
   */
  focusedQuestId?: string;
  focusedActId?: string;
  sagas: Saga[];
  campaigns: Campaign[];
  acts: Act[];
  quests: Quest[];
  events: RealmEvent[];
  /**
   * CENTRO DE NOTIFICACIONES.
   *
   * Una push es un golpe en la puerta y puede perderse; el registro persistente
   * vive aquí. Separado de `events`: sólo los hechos que piden acción humana se
   * vuelven notificación, y una push fallida deja la notificación sin leer.
   */
  notifications: NotificationRecord[];
  /** Marca del backfill único de notificaciones sobre estado ya accionable. */
  notificationsBackfilledAt?: string;
  /** Tesorería viva: obligaciones y movimientos reales. Dinero real, no meta-recurso. */
  recurringObligations: RecurringObligation[];
  financialTransactions: FinancialTransaction[];
  /** Capa de producto config-driven. Ningún límite se aplica al jugador actual. */
  entitlements: Entitlements;
  /** Telemetría de uso por período. El número de mensajes NO es proxy de costo. */
  usage: UsageCounters;
  evidence: EvidenceRecord[];
  artifacts: EvidenceArtifact[];
  lifeEvents: LifeEvent[];
  gameEvents: GameEvent[];
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// CENTRO DE NOTIFICACIONES
//
// DOMAIN EVENT ≠ NOTIFICATION RECORD ≠ PUSH DELIVERY ≠ FOCUS ≠ ENGAGEMENT.
// Una notificación lleva SIEMPRE la entidad exacta (deepLink por entityId,
// nunca por título) y no acepta, no inicia y no cambia el foco al abrirse.
// ---------------------------------------------------------------------------

export type NotificationType =
  | "quest_created"
  | "campaign_created"
  | "battle_started"
  | "quest_amendment_proposed"
  | "battle_recontract_proposed"
  | "quest_waiting_external"
  | "quest_unblocked"
  | "battle_lost"
  | "recurring_obligation_due"
  | "companion_result";

export type NotificationPriority = "normal" | "high";
export type PushStatus = "sent" | "failed" | "unknown";
export type NotificationEntityType = "quest" | "campaign" | "act" | "saga" | "obligation";
export type NotificationScreen = "quest" | "campaign" | "act" | "battle" | "treasury";

export interface NotificationDeepLink {
  screen: NotificationScreen;
  /** SIEMPRE un id. Resolver por título abriría la entidad equivocada. */
  entityId: string;
}

export interface NotificationPushState {
  lastAttemptAt: string | null;
  lastStatus: PushStatus;
  attempts: number;
}

export interface NotificationRecord {
  id: string;
  /**
   * DEDUPLICACIÓN.
   *
   * `type:entityType:entityId:version`. Un polling o un redeploy no crean un
   * segundo registro; `resend` tampoco. Sólo un cambio material sube `version`
   * y produce una notificación nueva sin sobrescribir la anterior.
   */
  key: string;
  type: NotificationType;
  title: string;
  body: string;
  entityType: NotificationEntityType;
  entityId: string;
  priority: NotificationPriority;
  deepLink: NotificationDeepLink;
  version: number;
  createdAt: string;
  readAt: string | null;
  archivedAt: string | null;
  /** Push es entrega efímera, no almacenamiento. Su estado no implica «visto». */
  push: NotificationPushState;
  /** Nació del backfill sobre estado accionable, no de un hecho nuevo. */
  backfilled?: boolean;
}

// ---------------------------------------------------------------------------
// TESORERÍA VIVA — dinero real en COP. Nunca un recurso comprable del juego.
// ---------------------------------------------------------------------------

export type ObligationDirection = "expense" | "income";
export type ObligationFrequency =
  | "weekly"
  | "biweekly"
  | "monthly"
  | "bimonthly"
  | "quarterly"
  | "yearly";

export interface ObligationDueRule {
  type: "day_of_month" | "day_of_week" | "date" | "unknown";
  /** 1..31 para day_of_month; 0..6 para day_of_week. */
  day?: number;
  /** Fecha ISO para una obligación con vencimiento puntual. */
  date?: string;
}

export interface RecurringObligation {
  id: string;
  name: string;
  direction: ObligationDirection;
  category: string;
  frequency: ObligationFrequency;
  /** Puede ser desconocido al inicio y completarse luego con evidencia real. */
  expectedAmount: number | null;
  currency: "COP";
  provider?: string;
  dueRule: ObligationDueRule;
  nextDueDate: string | null;
  /** "YYYY-MM" del último período conciliado. No marca «pagado para siempre». */
  lastPaidPeriod: string | null;
  active: boolean;
  /** Cerca del vencimiento, Torreón PROPONE una Quick Battle. Nunca la inicia. */
  autoProposeBattle: boolean;
  createdAt: string;
  updatedAt: string;
}

export type TransactionStatus = "confirmed" | "pending";

export interface FinancialTransaction {
  id: string;
  direction: ObligationDirection;
  /** Monto real declarado. NUNCA se infiere del `impact` de una Quest. */
  amount: number;
  currency: "COP";
  occurredAt: string;
  /** "YYYY-MM" del período que este movimiento concilia. */
  period: string;
  recurringObligationId?: string;
  questId?: string;
  evidenceArtifactId?: string;
  note?: string;
  status: TransactionStatus;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// PRODUCT ENTITLEMENTS Y TELEMETRÍA — sólo boundaries y estado. Nada se aplica.
// ---------------------------------------------------------------------------

export type PlanId = "free" | "premium" | "dev";

export interface Entitlements {
  plan: PlanId;
  /** null = ilimitado. La monetización vende ACCESO, jamás un resultado falso. */
  dailyBattleLimit: number | null;
  dailyCodiceCallLimit: number | null;
  adsEnabled: boolean;
  reasoningCallsPerDay: number | null;
  visionValidationsPerDay: number | null;
  agentExecutionsPerDay: number | null;
}

export interface UsageCounters {
  /** "YYYY-MM-DD" del período de conteo. Rota sin borrar historia. */
  period: string;
  /** Cuenta inicios de Battle. NO cuenta borradores, reintentos ni recontratos. */
  battlesStartedToday: number;
  codiceReasoningCalls: number;
  visionValidations: number;
  agentOrchestrations: number;
  /**
   * Cuánto trabajo real hicieron los compañeros hoy.
   *
   * Cuenta EJECUCIONES y VALIDACIONES, no mensajes: el número de mensajes no es
   * proxy de costo ni de utilidad. No se guarda ningún prompt aquí.
   */
  companionExecutions: number;
  companionSuccessfulExecutions: number;
  companionValidatedAssists: number;
}

export type AdPlacementId = "battle_passive" | "battle_result" | "extra_battle_reward";

export interface AdPlacement {
  id: AdPlacementId;
  /** Ranura discreta; jamás interstitial sobre el timer ni audio periódico. */
  style: "native_static" | "rewarded_optional" | "result_optional";
  /** Un ad NUNCA concede daño ni progreso validado. */
  grantsProgress: false;
  description: string;
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
  /**
   * Sólo `true` si esta Quest declara una dependencia todavía abierta, o si su
   * Acto la declara. NUNCA por posición: estar tercera no bloquea nada.
   */
  locked: boolean;
  /** Qué la bloquea exactamente, para que la pantalla no lo invente. */
  lockedBy?: string;
  isBoss: boolean;
  /** `standalone` = Quick Battle sin Campaña ni Acto. `campaign` = tiene padres. */
  scope: "standalone" | "campaign";
  /** Marca la representación financiera: 💰 GASTO/INGRESO RECURRENTE. */
  financeKind?: ObligationDirection;
}

/**
 * UN FRENTE ABIERTO.
 *
 * Toda Quest con una Battle que todavía no terminó, venga de donde venga: una
 * Quick Battle sin padres o la tercera Quest del segundo Acto de una Campaña.
 * Es la lista que hace que una Battle sea alcanzable POR NAVEGACIÓN NORMAL y no
 * sólo por la notificación que la anunció.
 *
 * POSITION IS NOT AUTHORIZATION: aquí no hay orden que autorice nada. Es una
 * proyección de lectura; abrir una entrada sólo mira, nunca acepta ni inicia.
 */
export interface OpenFrontView {
  questId: string;
  title: string;
  /** Dónde vive de verdad, para que el jugador sepa a qué frente vuelve. */
  campaignTitle: string | null;
  actTitle: string | null;
  status: QuestStatus;
  battleStatus: BattleStatus;
  percent: number;
  durationMinutes: number;
  attempt: number;
  /** `true` si el reloj corre ahora mismo. FOCUS IS NOT ENGAGEMENT. */
  engaged: boolean;
  /** `true` si el Marqués está en el suelo en ese frente. */
  marquisDown: boolean;
}

/**
 * ANTI-SOFTLOCK.
 *
 * Lo que el Core está dispuesto a conceder FUERA de una Battle cuando ya no
 * queda ninguna ruta legal dentro de ella. La pantalla no calcula nada de esto:
 * pregunta, y si `available` es falso muestra `reason` tal cual.
 */
export interface RecoveryOffer {
  /** Frente sobre el que se ofrece la retirada, si existe alguno. */
  questId: string | null;
  available: boolean;
  /** HP de reentrada que concedería. Config del Core, nunca de la UI. */
  minHealth: number;
  /** Motivo exacto cuando no está disponible. Nunca un botón mudo. */
  reason: string | null;
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
  /** La Quest que el jugador mira ahora. La fija sólo `focus_quest`. */
  focusedQuestId: string | null;
  focusedActId: string | null;
  /** La ÚNICA Battle con reloj corriendo. Null si el frente está libre. */
  engagedQuestId: string | null;
  currentSagaId: string | null;
  currentCampaignId: string | null;
  currentActId: string | null;
  currentQuestId: string | null;
  /** Quests sin padres. Una microquest legítima entra en batalla sin ceremonia. */
  standaloneQuests: QuestNode[];
}

// ---------------------------------------------------------------------------
// VISTAS DERIVADAS: notificaciones y tesorería listas para cualquier renderer.
// ---------------------------------------------------------------------------

export interface NotificationView {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  entityType: NotificationEntityType;
  entityId: string;
  priority: NotificationPriority;
  deepLink: NotificationDeepLink;
  createdAt: string;
  read: boolean;
  archived: boolean;
  push: NotificationPushState;
  /** Agrupación simple, sin algoritmo: «hoy», «ayer», «anteriores». */
  bucket: "hoy" | "ayer" | "anteriores";
}

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
  /** Estado del PERÍODO en curso, nunca «pagado para siempre». */
  periodStatus: "paid" | "pending" | "upcoming";
  currentPeriod: string;
  lastPaidPeriod: string | null;
  active: boolean;
  autoProposeBattle: boolean;
}

export interface TreasuryView {
  currency: "COP";
  /** Lo que el reino observa hoy. No es contabilidad completa. */
  observedBalance: number;
  expectedIncome: number;
  committedExpenses: number;
  reserveTarget: number;
  projectedMargin: number;
  /** Obligaciones cuyo período está pendiente o próximo. */
  upcomingObligations: ObligationView[];
  recurring: ObligationView[];
}

export interface RealmSnapshot {
  realm: RealmState;
  /**
   * Compatibilidad. Deriva del frente comprometido, luego del foco explícito,
   * luego de la campaña en foco. YA NO devuelve un borrador al azar cuando no
   * hay ni compromiso ni foco: para eso están `focusedQuest` y `engagedQuest`.
   */
  currentQuest: Quest | null;
  /** La Quest que el jugador mira. NOTIFICATION IS NOT FOCUS. */
  focusedQuest: Quest | null;
  /** La Quest cuya Battle corre. FOCUS IS NOT ENGAGEMENT. */
  engagedQuest: Quest | null;
  /**
   * LA ÚNICA AUTORIDAD DE LA BATTLE VISIBLE.
   *
   * `engagedQuest` si hay reloj corriendo; si no, la Quest que el jugador
   * enfocó a mano. Y si no hay ninguna de las dos, NADA: el frente que el
   * jugador dejó atrás no vuelve solo a la pantalla porque una proyección
   * legada siga apuntándole. `battle` deriva SIEMPRE de esta Quest.
   */
  battleQuest: Quest | null;
  battleQuestId: string | null;
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
  /** Centro de Notificaciones: registro persistente, no la última push. */
  notifications: NotificationView[];
  /** Para el badge 🔔. Contador de no leídas ni archivadas. */
  unreadNotifications: number;
  /** Tesorería viva derivada del estado financiero real. */
  treasury: TreasuryView;
  /** Capa de producto config-driven. Ningún límite se aplica al jugador actual. */
  entitlements: Entitlements;
  usage: UsageCounters;
  /** 🛡️ BARRACAS: el grupo y los agentes con su historia real. */
  barracks: BarracksView;
  /** Navegación autoritativa del mundo. Tesorería no cuelga de Batallas Libres. */
  worldSystems: WorldSystemView[];
  /**
   * Todas las Battles vivas del reino, con su id exacto.
   *
   * Sin esto, una Battle que nació dentro de una Campaña sólo era alcanzable
   * por la notificación que la anunció: perdida la push, perdida la Battle.
   */
  openFronts: OpenFrontView[];
  /** La retirada táctica: la única salida cuando ya no queda ruta dentro. */
  recovery: RecoveryOffer;
  /** Informe determinista de la última Battle ganada de esta Quest, si existe. */
  afterActionReport: AfterActionReport | null;
  /** Lo que el reino aprendió sobre duraciones, lecciones y playbooks. */
  battleMemory: BattleMemoryView;
}
