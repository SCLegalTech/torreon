import { randomUUID } from "node:crypto";
import { ingestArtifact, witnessArtifact, type ArtifactInput, type WitnessInput } from "./artifacts.js";
import {
  advanceBattles,
  battleClock,
  battleStatusOf,
  clampBattleMinutes,
  createBattleRecord,
  hordeIsDown,
  needsAdvance,
  openAttempt,
  reconcileBattleProjection,
  resolve as resolveBattle,
  totalPressureRate,
} from "./battle.js";
import {
  assistKeyFor,
  COMPANIONS,
  comboDamageFor,
  deployAgent,
  emptyAgentSlot,
  findExistingAssist,
  pendingAssistsFor,
} from "./companions.js";
import {
  barracksViewFor,
  claimOnce,
  ensureHero,
  ensureRoster,
  grantHeroXp,
  grantMastery,
  recordDeed,
} from "./barracks.js";
import {
  battleMemoryFor,
  buildAfterActionReport,
  planningHintFor,
  storeAfterActionReport,
  upsertPlaybook,
  type PlanningHint,
} from "./battle-memory.js";
import { AGENT_HERO_IDS, HERO_DEFAULT_MASTERY, HERO_DISPLAY_NAME, PARTY_HERO_IDS, XP_REWARDS } from "./progression.js";
import { distributeEnemyDamage, enemyTarget as enemyTargetFor } from "./horde.js";
import { grantItem, STARTER_INVENTORY, useItem } from "./inventory.js";
import { HeuristicCodice, questFromIntent, validatePlan, type CodicePlanner, type Judgement } from "./codice.js";
import type {
  Act,
  AfterActionReport,
  BarracksView,
  BattleMemoryView,
  BattleState,
  Campaign,
  CompanionAssist,
  CompanionExecution,
  CompanionId,
  HeroAvailability,
  HeroId,
  FinancialTransaction,
  InventoryItemId,
  NotificationEntityType,
  NotificationRecord,
  NotificationType,
  NotificationView,
  ObligationView,
  PartyMemberId,
  EvidenceArtifact,
  EvidenceSource,
  EvidenceVerdict,
  GameEvent,
  Quest,
  QuestAmendment,
  QuestAmendmentChange,
  QuestDetail,
  QuestPlanInput,
  QuestStep,
  RealmEvent,
  RealmSnapshot,
  RealmState,
  RecurringObligation,
  RewardProfile,
  Saga,
  TreasuryView,
} from "./domain.js";
import {
  addNotification,
  attemptPush,
  notificationViewsFor,
  notifyFromEvent,
  unreadCount,
  type NotificationQuery,
} from "./notifications.js";
import {
  advanceDueDate,
  buildFinancialTransaction,
  buildRecurringObligation,
  obligationViewFor,
  periodOf,
  treasuryViewFor,
  type FinancialTransactionInput,
  type RecurringObligationInput,
} from "./finance.js";
import { battleStartAllowed, rolloverUsage } from "./product.js";
import {
  applyDamage,
  freshParty,
  HEAL_PER_VALIDATED_IMPACT,
  healMember,
  healTarget,
  refreshShield,
  SHIELD_PER_VALIDATED_IMPACT,
} from "./party.js";
import { consistencyFor, currentStepFor, hierarchyFor, progressFor, questDetailFor, statsFor, worldSystemsFor } from "./read-models.js";
import {
  classifyScale,
  estimateActiveMinutes,
  MAX_ACTS_PER_CAMPAIGN,
  MAX_QUESTS_PER_ACT,
  type ScaleProposal,
} from "./scale.js";
import { JsonRealmStore } from "./store.js";

export { questFromIntent } from "./codice.js";

const now = () => new Date().toISOString();

function requireQuest(state: RealmState, questId: string): Quest {
  const quest = state.quests.find((candidate) => candidate.id === questId);
  if (!quest) throw new Error(`Quest no encontrada: ${questId}`);
  return quest;
}

/**
 * Registra un hecho SIEMPRE atado a la entidad exacta que cambió.
 *
 * Sin `entityType` + `entityId` una notificación sólo puede adivinar —«el
 * último borrador», «la quest actual»— y termina abriendo otra cosa. Los
 * hechos de quest siguen rellenando `questId` por compatibilidad.
 */
type RealmEventInput = Omit<RealmEvent, "id" | "createdAt" | "entityType" | "entityId"> &
  Partial<Pick<RealmEvent, "entityType" | "entityId">>;

function addEvent(state: RealmState, event: RealmEventInput): void {
  const entityType = event.entityType ?? "quest";
  const entityId = event.entityId ?? event.questId ?? "";
  const record: RealmEvent = { id: randomUUID(), createdAt: now(), ...event, entityType, entityId };
  state.events.unshift(record);
  state.events = state.events.slice(0, 100);
  // DOMAIN EVENT -> NOTIFICATION RECORD: sólo los hechos que piden acción humana.
  // El resto (tick de reloj, presión, poll) nunca llega al Centro.
  notifyFromEvent(state, record);
}

/** Marca leídas las notificaciones de una entidad de un tipo dado. */
function markEntityNotificationsRead(state: RealmState, entityId: string, type: NotificationType): void {
  const timestamp = now();
  for (const record of state.notifications ?? []) {
    if (record.entityId === entityId && record.type === type && !record.readAt) record.readAt = timestamp;
  }
}

export function battleFor(quest: Quest | null, _gameEvents: GameEvent[] = [], nowMs = Date.now()): BattleState | null {
  if (!quest) return null;
  const damage = quest.steps.reduce((sum, step) => sum + step.impactAwarded, 0);
  const record = quest.battle;
  // UNA SOLA FUENTE AUTORITATIVA: nunca `won` aquí y `active` en otra vista.
  const status = battleStatusOf(quest);
  // El grupo y la Horda viven en la Battle: sobreviven a los replanes.
  const party = record?.party ?? freshParty();
  const enemies = record?.enemies ?? [];
  const playerHealth = party.marques.health;
  const enemyHealth = enemies.length > 0 ? enemies.reduce((sum, enemy) => sum + enemy.health, 0) : Math.max(0, 100 - damage);
  const completedSteps = quest.steps.filter((step) => step.status === "completed").length;
  return {
    questId: quest.id,
    player: { id: "marques-phi", health: playerHealth, maxHealth: 100 },
    enemy: { id: "horda", health: enemyHealth, maxHealth: 100 },
    playerHealth,
    playerMaxHealth: 100,
    enemyMaxHealth: 100,
    enemyHealth,
    progress: Math.min(100, damage),
    completedSteps,
    totalSteps: quest.steps.length,
    // KO de la Horda es neutralización, no victoria: la victoria la firma el contrato.
    isKo: damage === 100,
    isPlayerKo: playerHealth === 0,
    durationMinutes: record?.durationMinutes ?? clampBattleMinutes(quest.durationMinutes),
    status,
    attempt: record?.attempt ?? 1,
    attempts: record?.attempts ?? [],
    party,
    agent: record?.agent ?? emptyAgentSlot(),
    enemies,
    // Un contrato validado al 100% neutraliza la Horda por definición: no puede
    // quedar un enemigo «vivo» en la proyección de una Battle ya ganada.
    hordeNeutralized: status === "won" || (enemies.length > 0 && enemies.every((enemy) => enemy.status === "ko")),
    // Una Battle que no está corriendo NO ejerce presión. Ni ganada, ni
    // suspendida, ni vencida: cero, y el renderer no tiene que deducirlo.
    pressureRate: enemies.length > 0 && status === "active" ? Math.round(totalPressureRate(enemies) * 10) / 10 : 0,
    pendingRecontract: record?.pendingRecontract
      ? { id: record.pendingRecontract.id, reason: record.pendingRecontract.reason, newDurationMinutes: record.pendingRecontract.newDurationMinutes }
      : undefined,
    // El reloj no corre en el borrador: sólo existe desde que el jugador inicia.
    clock: record ? battleClock(record, nowMs) : null,
  };
}

/** Lo que la quest concederá al validarse./**
 * Recompensa por defecto de un contrato que no declaró la suya.
 *
 * XP mide la gesta pactada —la mitad de los minutos acordados—, no el tiempo
 * que el jugador pasó en la app. Aura crece con los cuidados que el contrato se
 * comprometió a respetar, porque Aura es calidad de vida y no productividad.
 */
export function defaultRewardProfile(quest: Quest): Required<Pick<RewardProfile, "xpMax" | "auraMax">> & RewardProfile {
  return {
    xpMax: quest.rewardProfile?.xpMax ?? Math.min(60, Math.max(5, Math.round(quest.durationMinutes / 2))),
    auraMax: quest.rewardProfile?.auraMax ?? Math.min(5, 1 + quest.wellbeingConstraints.length),
    masteryDomain: quest.rewardProfile?.masteryDomain,
  };
}

/** Lo que la quest concederá al validarse. La pantalla no recalcula la regla. */
export function previewRewards(quest: Quest): { xp: number; aura: number; masteryDomain?: string } {
  const profile = defaultRewardProfile(quest);
  return { xp: Math.max(0, Math.round(profile.xpMax)), aura: Math.max(0, Math.round(profile.auraMax)), masteryDomain: profile.masteryDomain };
}

export interface RewardGrant {
  xp: number;
  aura: number;
  masteryDomain?: string;
  masteryPoints: number;
}

/**
 * Concede la recompensa de una quest completada UNA sola vez.
 *
 * Recargar, reabrir o volver a leer el reino no puede sumar XP ni Aura otra
 * vez: la lista de quests ya recompensadas vive en el estado, no en la sesión.
 */
export function grantQuestRewards(state: RealmState, quest: Quest): RewardGrant | null {
  if (quest.status !== "completed") return null;
  if (state.character.rewardedQuestIds.includes(quest.id)) return null;

  const profile = defaultRewardProfile(quest);
  const xp = Math.max(0, Math.round(profile.xpMax));
  const aura = Math.max(0, Math.round(profile.auraMax));
  const domain = profile.masteryDomain?.trim();

  state.character.xp += xp;
  state.character.aura += aura;
  if (domain) state.character.mastery[domain] = (state.character.mastery[domain] ?? 0) + 1;
  state.character.rewardedQuestIds.push(quest.id);

  return { xp, aura, masteryDomain: domain, masteryPoints: domain ? 1 : 0 };
}

// ---------------------------------------------------------------------------
// PROGRESIÓN DE HÉROES
//
// LEVEL IS NOT PERMISSION. Nada de lo que hay aquí abre una puerta del mundo
// real: no autoriza enviar, firmar, pagar, borrar ni desplegar. Es gameplay.
//
// Y ningún punto nace del tiempo, de abrir la app ni de mandar mensajes: sólo
// de participación validada en una Battle y de resultados reales comprobados.
// ---------------------------------------------------------------------------

function pushGameEvent(state: RealmState, event: Omit<GameEvent, "id">): string {
  const id = randomUUID();
  state.gameEvents.unshift({ id, ...event });
  state.gameEvents = state.gameEvents.slice(0, 200);
  return id;
}

/** Concede XP y, si cruza umbral, emite `hero_level_up` UNA sola vez. */
function applyXp(state: RealmState, heroId: HeroId, amount: number, key: string, questId: string): void {
  const grant = grantHeroXp(state, heroId, amount, key);
  if (!grant?.leveledUp) return;
  const timestamp = now();
  pushGameEvent(state, {
    type: "hero_level_up",
    questId,
    damage: 0,
    heroId,
    level: grant.level,
    message: `${HERO_DISPLAY_NAME[heroId]} ha alcanzado el nivel ${grant.level}.`,
    createdAt: timestamp,
  });
  addEvent(state, {
    type: "hero_level_up",
    entityType: "quest",
    entityId: questId,
    message: `${HERO_DISPLAY_NAME[heroId]} ha alcanzado el nivel ${grant.level}. El nivel es gameplay: no concede ningún permiso nuevo.`,
  });
}

/**
 * EJECUCIÓN VISIBLE.
 *
 * Permite que la pantalla muestre «OPUS HA ENTRADO EN COMBATE» sin esperar al
 * cierre de la Quest. Deduplicada por `executionRef`: la misma ejecución real
 * no se registra dos veces, y una lectura de MCP no se convierte en push.
 */
function registerExecution(state: RealmState, assist: CompanionAssist, quest: Quest): CompanionExecution {
  state.companionExecutions ??= [];
  const executionRef = assist.executionRef?.trim() || assist.id;
  const existing = state.companionExecutions.find((candidate) => candidate.executionRef === executionRef);
  if (existing) return existing;
  const execution: CompanionExecution = {
    executionRef,
    companionId: assist.companion,
    questId: quest.id,
    stepId: assist.stepId,
    tool: assist.sourceTool,
    startedAt: assist.createdAt,
    completedAt: assist.createdAt,
    status: "succeeded",
    summary: assist.contributionSummary,
  };
  state.companionExecutions.unshift(execution);
  state.companionExecutions = state.companionExecutions.slice(0, 200);
  pushGameEvent(state, {
    type: "companion_execution_completed",
    questId: quest.id,
    stepId: assist.stepId,
    damage: 0,
    companion: assist.companion,
    heroId: assist.companion,
    battleAttempt: quest.battle?.attempt ?? 1,
    message: `${HERO_DISPLAY_NAME[assist.companion]} completó ${assist.sourceTool ?? "una operación"} sobre el frente.`,
    createdAt: assist.createdAt,
  });
  return execution;
}

/** Marca que un agente ejecutó algo real. Estar disponible nunca cuenta. */
function markAgentParticipation(state: RealmState, assist: CompanionAssist, quest: Quest): void {
  const hero = ensureHero(state, assist.companion);
  hero.availability = "connected";
  hero.lastDeployedAt = assist.createdAt;
  hero.lastQuestId = quest.id;
  if (claimOnce(state, `execution:${assist.id}`)) {
    // UN NUEVO ALIADO HA ENTRADO EN COMBATE. No cuando se instala: cuando pelea.
    if (hero.stats.executions === 0) {
      addEvent(state, {
        type: "hero_discovered",
        entityType: "quest",
        entityId: quest.id,
        questId: quest.id,
        message: `Un nuevo aliado ha entrado en combate: ${HERO_DISPLAY_NAME[assist.companion]}.`,
      });
    }
    hero.stats.executions += 1;
    hero.stats.successfulExecutions += 1;
    // Telemetría de uso: cuenta trabajo real, nunca mensajes ni prompts.
    rolloverUsage(state.usage);
    state.usage.companionExecutions += 1;
    state.usage.companionSuccessfulExecutions += 1;
  }
  applyXp(state, assist.companion, XP_REWARDS.agentExecution, `execution:${assist.id}`, quest.id);
  recordDeed(
    state,
    {
      heroId: assist.companion,
      questId: quest.id,
      questTitle: quest.title,
      stepId: assist.stepId,
      summary: assist.contributionSummary,
      sourceTool: assist.sourceTool,
      outcome: "participated",
    },
    `assist:${assist.id}`,
  );
}

/**
 * Una contribución ACEPTADA. Aquí —y sólo aquí— el agente deja de ser un
 * nombre disponible y pasa a tener carrera: XP, maestría y hazaña verificada.
 */
function markAgentValidation(
  state: RealmState,
  assist: CompanionAssist,
  quest: Quest,
  impactAwarded: number,
  evidenceId: string,
): void {
  const hero = ensureHero(state, assist.companion);
  if (claimOnce(state, `validated_assist:${assist.id}`)) {
    hero.stats.validatedAssists += 1;
    hero.stats.supportedImpact += impactAwarded;
    rolloverUsage(state.usage);
    state.usage.companionValidatedAssists += 1;
  }
  applyXp(state, assist.companion, XP_REWARDS.agentValidatedAssist, `validated_assist:${assist.id}`, quest.id);
  grantMastery(state, assist.companion, HERO_DEFAULT_MASTERY[assist.companion], `assist:${assist.id}`);
  recordDeed(
    state,
    {
      heroId: assist.companion,
      questId: quest.id,
      questTitle: quest.title,
      stepId: assist.stepId,
      summary: assist.contributionSummary,
      sourceTool: assist.sourceTool,
      outcome: "verified",
      evidenceId,
    },
    `validated:${assist.id}`,
  );
  pushGameEvent(state, {
    type: "companion_assist_validated",
    questId: quest.id,
    stepId: assist.stepId,
    damage: 0,
    companion: assist.companion,
    heroId: assist.companion,
    battleAttempt: quest.battle?.attempt ?? 1,
    message: `La contribución de ${HERO_DISPLAY_NAME[assist.companion]} quedó validada por la evidencia del paso.`,
    createdAt: now(),
  });
}

/** Carrera del grupo y de los agentes al cerrarse un contrato al 100%. */
function applyCareerProgression(state: RealmState, quest: Quest, timestamp: string): void {
  const validatedImpact = quest.steps.reduce((sum, step) => sum + step.impactAwarded, 0);
  const won = battleStatusOf(quest) === "won";

  for (const heroId of PARTY_HERO_IDS) {
    const hero = ensureHero(state, heroId, timestamp);
    if (claimOnce(state, `quest_completed:${heroId}:${quest.id}`)) {
      hero.stats.questsCompleted += 1;
      hero.stats.validatedImpact += validatedImpact;
      if (won) hero.stats.battlesWon += 1;
      hero.lastQuestId = quest.id;
    }
    applyXp(state, heroId, XP_REWARDS.questCompleted, `quest_completed:${quest.id}`, quest.id);
    grantMastery(state, heroId, quest.rewardProfile?.masteryDomain, `quest:${quest.id}`);
    recordDeed(
      state,
      {
        heroId,
        questId: quest.id,
        questTitle: quest.title,
        summary: `${quest.title}: ${quest.outcome}`,
        outcome: "victory",
      },
      `quest_victory:${quest.id}`,
    );
  }

  const validatedAssists = (state.companionAssists ?? []).filter(
    (assist) => assist.questId === quest.id && assist.status === "contribution_validated",
  );
  for (const companion of new Set(validatedAssists.map((assist) => assist.companion))) {
    const hero = ensureHero(state, companion, timestamp);
    if (claimOnce(state, `quest_assisted:${companion}:${quest.id}`)) {
      hero.stats.questsAssisted += 1;
      if (won) hero.stats.battlesWonWithParty += 1;
    }
    recordDeed(
      state,
      {
        heroId: companion,
        questId: quest.id,
        questTitle: quest.title,
        summary: `${quest.title}: VICTORIA con contribución validada.`,
        outcome: "victory",
      },
      `quest_victory:${quest.id}`,
    );
  }

  const campaign = quest.campaignId ? state.campaigns.find((candidate) => candidate.id === quest.campaignId) : undefined;
  if (campaign?.status === "completed") {
    for (const heroId of PARTY_HERO_IDS) {
      const hero = ensureHero(state, heroId, timestamp);
      if (claimOnce(state, `campaign_completed:${heroId}:${campaign.id}`)) hero.stats.campaignsCompleted += 1;
      applyXp(state, heroId, XP_REWARDS.campaignCompleted, `campaign_completed:${campaign.id}`, quest.id);
    }
  }
}

/**
 * BATTLE COMPLETION MUST BE ATOMIC.
 *
 * Cuando la evidencia final cierra el contrato, TODO ocurre en la misma
 * mutación: paso cerrado, Quest al 100, Horda neutralizada, Battle ganada,
 * intento cerrado, frente liberado, presión a cero, hecho de cierre, carrera
 * actualizada, XP concedida e informe de acción generado. No se deja ninguna
 * proyección a medias, y repetir la llamada no concede nada dos veces.
 */
function completeQuest(state: RealmState, quest: Quest, timestamp: string): void {
  if (quest.status === "completed") return;
  quest.status = "completed";
  quest.completedAt = timestamp;
  quest.updatedAt = timestamp;

  const record = quest.battle;
  if (record) {
    if (record.status === "active") resolveBattle(state, quest, record, "won", Date.parse(timestamp));
    // El contrato validado neutraliza la Horda por definición: no puede quedar
    // un enemigo «vivo» en la proyección de una Battle ya ganada.
    for (const enemy of record.enemies) {
      enemy.health = 0;
      enemy.status = "ko";
    }
    record.hordeNeutralizedAt ??= timestamp;
    // Una espera externa, un replan pendiente o una suspensión NO pueden
    // sobrevivir a la victoria: aquí se alinean con la única verdad.
    reconcileBattleProjection(quest, Date.parse(timestamp));
  }

  closeParents(state, quest);
  addEvent(state, { type: "quest_completed", questId: quest.id, message: `KO: «${quest.title}» fue completada.` });

  const reward = grantQuestRewards(state, quest);
  if (reward) {
    const mastery = reward.masteryDomain ? ` +${reward.masteryPoints} ${reward.masteryDomain}` : "";
    addEvent(state, {
      type: "reward_granted",
      questId: quest.id,
      message: `El resultado validado concede +${reward.xp} XP +${reward.aura} Aura${mastery}.`,
    });
  }

  applyCareerProgression(state, quest, timestamp);

  // MEMORIA DE BATALLA: el reino aprende cuánto duró de verdad este trabajo.
  const report = storeAfterActionReport(state, buildAfterActionReport(state, quest));
  upsertPlaybook(state, quest, report);
  addEvent(state, {
    type: "after_action_report",
    entityType: "quest",
    entityId: quest.id,
    questId: quest.id,
    message: `Informe de acción de «${quest.title}»: ${Math.round(report.actualActiveMs / 60_000)} min activos frente a ${report.plannedDurationMinutes} pactados.`,
  });
}

/**
 * Motivos que NUNCA son una exigencia nueva del mundo real.
 *
 * Se comprueba en el servidor, no en el prompt: un Dungeon Master apurado no
 * puede convertir un fallo técnico en daño narrativo.
 */
const FORBIDDEN_REQUIREMENT_REASON =
  /\b(reintent\w*|retry|reintento|timeout|time-?out|latenc\w*|debug\w*|depurac\w*|duplicad\w*|duplicate|stack ?trace|500|502|503|rate ?limit|tard\w+ (mucho|demasiado)|se demor\w+|tiempo (transcurrido|agotado)|error (t[eé]cnico|de red|de conexi[oó]n))\b/i;

/** Pasos cuya condición pactada exige una prueba, no un relato. */
const ARTIFACT_KINDS = new Set(["file", "link", "screenshot", "photo"]);

/**
 * El servidor —no el modelo— decide si un veredicto es admisible.
 * Si el paso pactó una prueba y no llegó ninguna comprobada, ningún juez puede
 * dar el paso por cerrado, por convincente que suene la declaración.
 */
export function enforceArtifactRule(
  judgement: Judgement,
  step: QuestStep,
  artifacts: EvidenceArtifact[],
  remainingImpact: number,
): Judgement {
  if (judgement.verdict !== "accepted") return judgement;
  if (!step.evidenceKind || !ARTIFACT_KINDS.has(step.evidenceKind)) return judgement;
  if (artifacts.some((artifact) => artifact.verification.verified)) return judgement;

  const nota = `Este paso pactó una prueba (${step.evidenceKind}) y no llegó ninguna que el servidor pudiera comprobar, así que no puede cerrarse con una declaración.`;
  if (remainingImpact <= 1) {
    return { verdict: "rejected", impactAwarded: 0, reasoning: `${judgement.reasoning} ${nota}` };
  }
  return {
    verdict: "partial",
    impactAwarded: Math.max(1, Math.floor(remainingImpact / 2)),
    reasoning: `${judgement.reasoning} ${nota}`,
  };
}

/**
 * ONE ENGAGED BATTLE.
 *
 * La Battle comprometida es la única con reloj corriendo. Una quest en
 * `waiting_external` o con la Battle perdida ya no ocupa el frente: el slot
 * queda libre para otro objetivo, aunque su campaña siga viva.
 */
export function engagedQuest(state: RealmState): Quest | null {
  return state.quests.find((quest) => quest.status === "active" && quest.battle?.status === "active") ?? null;
}

/** Quest accionable dentro de un conjunto, por prioridad de compromiso. */
function actionableIn(quests: Quest[]): Quest | null {
  return (
    quests.find((quest) => quest.status === "active") ??
    quests.find((quest) => quest.status === "accepted") ??
    quests.find((quest) => quest.status === "waiting_external") ??
    quests.find((quest) => quest.status === "draft") ??
    null
  );
}

/** La Quest que el jugador enfocó a mano. NUNCA la mueve crear un borrador. */
export function focusedQuestOf(state: RealmState): Quest | null {
  if (!state.focusedQuestId) return null;
  return (
    state.quests.find(
      (quest) => quest.id === state.focusedQuestId && !["completed", "abandoned"].includes(quest.status),
    ) ?? null
  );
}

/**
 * LA QUEST CUYA BATTLE SE PROYECTA. AUTORIDAD ÚNICA.
 *
 * Primero el frente COMPROMETIDO —si hay reloj corriendo, eso manda—; si no, la
 * Quest que el jugador enfocó A MANO, sea cual sea su estado (también una ya
 * ganada, para poder mirar el resultado). Y si no hay ninguna de las dos, null.
 *
 * NADA MÁS puede elegir aquí: ni la campaña en foco, ni el último borrador, ni
 * la Quest que quedó primera en la lista. Un frente que el jugador dejó atrás
 * NO puede reabrirse solo en cada poll.
 */
export function battleQuestOf(state: RealmState): Quest | null {
  const engaged = engagedQuest(state);
  if (engaged) return engaged;
  if (!state.focusedQuestId) return null;
  return state.quests.find((quest) => quest.id === state.focusedQuestId) ?? null;
}

/**
 * Qué mira el jugador ahora mismo. LEGACY COMPAT.
 *
 * BACKLOG NO ES FOCO. Primero el frente comprometido, después el foco
 * EXPLÍCITO, y sólo entonces conveniencias para lectores antiguos.
 *
 * LA CAMPAÑA EN FOCO YA NO ELIGE BATTLE. Enfocar una campaña es navegación:
 * cuando también elegía «la quest accionable de esa campaña», un frente que el
 * jugador había dejado en pausa volvía a presentarse como la batalla vigente en
 * cada lectura, y bloqueaba abrir otro. Eso se acabó.
 *
 * Y pase lo que pase aquí, esta función NO decide la Battle: eso lo hace
 * `battleQuestOf`.
 */
function currentQuest(state: RealmState): Quest | null {
  const engaged = engagedQuest(state);
  if (engaged) return engaged;

  const focusedQuest = focusedQuestOf(state);
  if (focusedQuest) return focusedQuest;

  // Sin compromiso ni foco: un frente ya en marcha manda sobre cualquier borrador.
  const live = actionableIn(state.quests);
  if (live && live.status !== "draft") return live;

  // Un único borrador en todo el reino sí es «lo actual». Varios en cola: ninguno
  // se elige a dedo —para eso están las Quick Battles y el Centro de avisos—.
  const drafts = state.quests.filter((quest) => quest.status === "draft");
  if (drafts.length === 1) return drafts[0];
  if (drafts.length > 1) return null;

  // Ni frentes vivos ni borradores: la última Quest tocada (p. ej. recién ganada).
  return state.quests.find((quest) => quest.status !== "abandoned") ?? null;
}

/**
 * EL PROGRESO SUBE SOLO CON RESULTADOS REALES.
 *
 * Una Quest completada cierra su Acto cuando ya no queda ninguna Quest viva en
 * el; un Acto cerrado cierra su Campaña; una Campaña cerrada cierra su Saga.
 * Nada de esto se marca a mano ni con un clic.
 */
function closeParents(state: RealmState, quest: Quest): void {
  const timestamp = now();
  const act = quest.actId ? state.acts.find((candidate) => candidate.id === quest.actId) : undefined;
  if (!act) return;
  const questsOfAct = act.questIds
    .map((questId) => state.quests.find((candidate) => candidate.id === questId))
    .filter((candidate): candidate is Quest => Boolean(candidate));
  if (!questsOfAct.every((candidate) => ["completed", "abandoned"].includes(candidate.status))) return;
  act.status = "completed";
  act.completedAt = timestamp;
  act.updatedAt = timestamp;
  addEvent(state, { type: "act_completed", entityType: "act", entityId: act.id, message: `El acto «${act.title}» quedó cerrado.` });

  const campaign = act.campaignId ? state.campaigns.find((candidate) => candidate.id === act.campaignId) : undefined;
  if (!campaign) return;
  const actsOfCampaign = campaign.actIds
    .map((actId) => state.acts.find((candidate) => candidate.id === actId))
    .filter((candidate): candidate is Act => Boolean(candidate));
  if (!actsOfCampaign.every((candidate) => ["completed", "abandoned"].includes(candidate.status))) return;
  campaign.status = "completed";
  campaign.completedAt = timestamp;
  campaign.updatedAt = timestamp;
  addEvent(state, { type: "campaign_completed", entityType: "campaign", entityId: campaign.id, message: `Campaña conquistada: «${campaign.title}».` });

  const saga = campaign.sagaId ? state.sagas.find((candidate) => candidate.id === campaign.sagaId) : undefined;
  if (!saga) return;
  const campaignsOfSaga = saga.campaignIds
    .map((campaignId) => state.campaigns.find((candidate) => candidate.id === campaignId))
    .filter((candidate): candidate is Campaign => Boolean(candidate));
  if (!campaignsOfSaga.every((candidate) => ["completed", "abandoned"].includes(candidate.status))) return;
  saga.status = "completed";
  saga.completedAt = timestamp;
  saga.updatedAt = timestamp;
}

/** Nombra la gesta sin repetir literalmente la frase del jugador. */
function campaignTitleFrom(intent: string): string {
  const core = intent
    .replace(/^(necesito|quiero|tengo que|debo|me toca|hay que|voy a|deseo)\s+/i, "")
    .replace(/[.?!]+$/g, "")
    .trim();
  const short = core.length > 44 ? `${core.slice(0, 41).trim()}...` : core;
  const named = short.charAt(0).toUpperCase() + short.slice(1);
  return `La Forja de ${named}`.slice(0, 120);
}

/** El frente donde se puede actuar: el comprometido o el que espera auxilio. */
function engagedOrRecoverable(state: RealmState): Quest | null {
  return (
    state.quests.find((quest) => quest.battle?.status === "active") ??
    state.quests.find((quest) => quest.battle && ["awaiting_replan", "awaiting_recovery"].includes(quest.battle.status)) ??
    null
  );
}

function requireCampaign(state: RealmState, campaignId: string): Campaign {
  const campaign = state.campaigns.find((candidate) => candidate.id === campaignId);
  if (!campaign) throw new Error(`Campaña no encontrada: ${campaignId}`);
  return campaign;
}

/** Un Acto nace disponible: es planificación, no un pacto aparte. */
function buildAct(
  campaign: Campaign | undefined,
  proposal: { title: string; subtitle?: string; outcome?: string; estimatedActiveMinutes?: number; dependsOnActIds?: string[] },
  timestamp: string,
): Act {
  return {
    id: randomUUID(),
    campaignId: campaign?.id,
    sagaId: campaign?.sagaId,
    title: proposal.title.trim().slice(0, 120),
    subtitle: proposal.subtitle?.trim().slice(0, 200),
    outcome: proposal.outcome?.trim().slice(0, 500),
    status: "available",
    questIds: [],
    estimatedActiveMinutes: Math.max(0, Math.round(proposal.estimatedActiveMinutes ?? 0)),
    // ACTOS EN PARALELO POR DEFECTO: sin dependencia explícita, disponible.
    dependsOnActIds: (proposal.dependsOnActIds ?? []).slice(0, 7),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function requireStep(quest: Quest, stepId: string): QuestStep {
  const step = quest.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new Error(`Paso no encontrado: ${stepId}`);
  return step;
}

function applyAmendmentChanges(quest: Quest, changes: QuestAmendmentChange[], timestamp: string): void {
  for (const change of changes) {
    if (change.type === "ADD_STEP") {
      quest.steps.push({
        ...change.step,
        id: randomUUID(),
        status: "pending",
        impactAwarded: 0,
        evidenceIds: [],
        artifactIds: [],
      });
      continue;
    }

    const step = requireStep(quest, change.stepId);
    if (change.type === "MODIFY_STEP") {
      if (["completed", "superseded"].includes(step.status)) throw new Error(`No se puede modificar el paso histórico «${step.title}».`);
      if (change.patch.weight !== undefined && change.patch.weight < step.impactAwarded) {
        throw new Error(`El nuevo peso de «${step.title}» no puede ser menor que su impacto ya concedido (${step.impactAwarded}).`);
      }
      Object.assign(step, change.patch);
    } else if (change.type === "SUPERSEDE_STEP") {
      if (step.status === "completed") throw new Error(`El paso completado «${step.title}» ya es historia validada y no puede sustituirse.`);
      step.status = "superseded";
      step.supersededAt = timestamp;
      step.supersededReason = change.reason.trim();
      // El impacto no adjudicado vuelve al contrato; el impacto histórico queda intacto.
      step.weight = step.impactAwarded;
    } else if (change.type === "MARK_EXTERNAL_BLOCKER") {
      if (["completed", "superseded"].includes(step.status)) throw new Error(`El paso «${step.title}» ya no puede bloquearse.`);
      step.status = "blocked";
      step.blockedBy = change.blockedBy.trim();
      step.blockedReason = change.blockedReason.trim();
      step.blockedSince = timestamp;
      step.playerActionAvailable = change.playerActionAvailable;
      step.followUpAfter = change.followUpAfter;
    } else if (change.type === "UNBLOCK_STEP") {
      if (step.status !== "blocked") throw new Error(`El paso «${step.title}» no está bloqueado.`);
      step.status = step.impactAwarded > 0 ? "in_progress" : "pending";
      delete step.blockedBy;
      delete step.blockedReason;
      delete step.blockedSince;
      delete step.playerActionAvailable;
      delete step.followUpAfter;
    }
  }

  const total = quest.steps.reduce((sum, step) => sum + step.weight, 0);
  if (total !== 100) throw new Error(`Tras el amendment, el impacto total debe seguir siendo 100; actualmente suma ${total}. Redistribuye sólo el impacto restante.`);
}

function reconcileExternalWaiting(quest: Quest): "waiting" | "active" {
  const unfinished = quest.steps.filter((step) => step.impactAwarded < step.weight && step.status !== "superseded");
  const noPlayerAction = unfinished.length > 0 && unfinished.every((step) => step.status === "blocked" && step.playerActionAvailable === false);
  quest.status = noPlayerAction ? "waiting_external" : "active";
  return noPlayerAction ? "waiting" : "active";
}

export interface CodiceVerdictResult {
  quest: Quest;
  battle: BattleState;
  evidenceId: string;
  lifeEventId: string;
  gameEventId: string | null;
  judgement: Judgement;
  artifacts: EvidenceArtifact[];
}

export class QuestService {
  constructor(
    private readonly store: JsonRealmStore,
    private readonly codice: CodicePlanner = new HeuristicCodice(),
    private readonly dataDir = "./data",
    /** Etiqueta legible de esta instancia: distingue el reino local del de la nube. */
    private readonly instance = process.env.TORREON_INSTANCE?.trim() || "torreon-local",
  ) {}

  get codiceName(): string {
    return this.codice.name;
  }

  /**
   * EL SERVIDOR ES AUTORIDAD DEL TIEMPO.
   *
   * Antes de responder a nadie —app, MCP o Unity— el Core cobra lo que el reloj
   * debía haber cobrado mientras la app estaba cerrada. Sólo escribe si de
   * verdad hay algo pendiente: leer el reino no puede ensuciar el archivo.
   */
  private async tick(): Promise<RealmState> {
    const state = await this.store.read();
    // El zurrón inicial se entrega UNA vez. Recargar o redesplegar no repite.
    if (!state.inventory.initializedAt) {
      const { state: stocked } = await this.store.mutate((draft) => {
        if (draft.inventory.initializedAt) return null;
        const timestamp = now();
        for (const entry of STARTER_INVENTORY) {
          grantItem(draft.inventory, entry.itemId, entry.quantity);
          draft.gameEvents.unshift({
            id: randomUUID(),
            type: "inventory_item_granted",
            questId: "",
            damage: 0,
            itemId: entry.itemId,
            message: `El reino entrega ${entry.quantity} × ${entry.itemId}.`,
            createdAt: timestamp,
          });
        }
        draft.gameEvents = draft.gameEvents.slice(0, 200);
        draft.inventory.initializedAt = timestamp;
        return null;
      });
      if (!needsAdvance(stocked, Date.now())) return stocked;
      const { state: advanced } = await this.store.mutate((draft) => advanceBattles(draft, Date.now()));
      return advanced;
    }
    if (!needsAdvance(state, Date.now())) return state;
    const { state: fresh } = await this.store.mutate((draft) => advanceBattles(draft, Date.now()));
    return fresh;
  }

  async snapshot(): Promise<RealmSnapshot> {
    const realm = await this.tick();
    const quest = currentQuest(realm);
    const engaged = engagedQuest(realm);
    const { availableBalance, expectedIncome, committedExpenses, reserveTarget } = realm.financial;
    // UNA SOLA AUTORIDAD: la Battle visible es la del frente comprometido o la
    // del que el jugador enfocó. Nunca la que una proyección legada eligió.
    const battleQuest = battleQuestOf(realm);
    const battle = battleFor(battleQuest, realm.gameEvents);
    const hierarchy = hierarchyFor(realm, quest, engaged?.id ?? null);
    const unread = unreadCount(realm);
    return {
      realm,
      currentQuest: quest,
      // NOTIFICATION IS NOT FOCUS. FOCUS IS NOT ENGAGEMENT.
      focusedQuest: focusedQuestOf(realm),
      engagedQuest: engaged,
      battleQuest,
      battleQuestId: battleQuest?.id ?? null,
      progress: progressFor(quest),
      currentStep: currentStepFor(quest),
      battle,
      stats: statsFor(realm, battle),
      inventory: realm.inventory,
      hierarchy,
      rewardPreview: quest ? previewRewards(quest) : null,
      consistency: consistencyFor(realm, this.instance, quest),
      projectedMargin: availableBalance + expectedIncome - committedExpenses - reserveTarget,
      notifications: notificationViewsFor(realm),
      unreadNotifications: unread,
      treasury: treasuryViewFor(realm),
      entitlements: realm.entitlements,
      usage: realm.usage,
      // 🛡️ BARRACAS y 💰 TESORERÍA son sistemas del MUNDO, no hijos de las
      // Batallas Libres: la jerarquía la fija el Core y el renderer la obedece.
      barracks: barracksViewFor(realm),
      worldSystems: worldSystemsFor(realm, {
        engagedQuest: engaged,
        quickBattles: hierarchy.standaloneQuests.length,
        activeCampaigns: hierarchy.activeCampaignIds.length,
        unreadNotifications: unread,
      }),
      afterActionReport: quest
        ? (realm.afterActionReports ?? []).find((report) => report.questId === quest.id) ?? null
        : null,
      battleMemory: battleMemoryFor(realm),
    };
  }

  /** 🛡️ Barracas: el grupo y los agentes con la historia que de verdad tienen. */
  async barracks(): Promise<BarracksView> {
    return barracksViewFor(await this.tick());
  }

  /** Lo que el reino aprendió: duraciones reales, lecciones y playbooks. */
  async battleMemory(): Promise<BattleMemoryView> {
    return battleMemoryFor(await this.tick());
  }

  /**
   * Pista de planificación para un objetivo NUEVO.
   *
   * Devolverla no repacta nada: un contrato aceptado sólo cambia con un
   * amendment sellado por el jugador.
   */
  async planningHint(intent: string): Promise<PlanningHint> {
    return planningHintFor(await this.tick(), intent);
  }

  /** El informe determinista de una Battle ganada, si ya existe. */
  async afterActionReport(questId: string): Promise<AfterActionReport | null> {
    const state = await this.tick();
    return (state.afterActionReports ?? []).find((report) => report.questId === questId) ?? null;
  }

  /**
   * Lectura detallada de una misión: pasos, artefactos y veredictos unidos.
   * Responde «¿qué ocurre exactamente dentro de esta misión?», que es distinto
   * de la panorámica que da snapshot().
   */
  async questDetail(questId: string): Promise<QuestDetail> {
    return questDetailFor(await this.tick(), questId);
  }

  async createDraft(plan: QuestPlanInput, parents: { actId?: string; campaignId?: string } = {}): Promise<Quest> {
    validatePlan(plan);
    const { result } = await this.store.mutate((state) => {
      // Varias campañas pueden tener quests listas a la vez. Lo que no puede
      // duplicarse es la Battle comprometida, y eso lo defiende start().
      const act = parents.actId ? state.acts.find((candidate) => candidate.id === parents.actId) : undefined;
      if (parents.actId && !act) throw new Error(`Acto no encontrado: ${parents.actId}`);
      if (act && act.questIds.length >= MAX_QUESTS_PER_ACT) {
        throw new Error(`El acto «${act.title}» ya sostiene ${MAX_QUESTS_PER_ACT} Battles: parte el trabajo en otro Acto.`);
      }
      // Una quest puede colgar directamente de la campaña, sin Acto intermedio.
      const campaign = parents.campaignId ? requireCampaign(state, parents.campaignId) : act?.campaignId ? requireCampaign(state, act.campaignId) : undefined;
      if (act && campaign && act.campaignId && act.campaignId !== campaign.id) {
        throw new Error(`El acto «${act.title}» pertenece a otra campaña.`);
      }
      const timestamp = now();
      const quest: Quest = {
        ...plan,
        id: randomUUID(),
        // Una Quest Libre (standalone) no tiene campaña: el texto queda vacío y
        // no se fabrica una campaña ficticia («Vida cotidiana», «Inbox»…).
        campaignTitle: (plan.campaignTitle ?? (campaign?.title ?? act?.title ?? "")).trim().slice(0, 120),
        status: "draft",
        actId: act?.id,
        campaignId: campaign?.id ?? act?.campaignId,
        sagaId: campaign?.sagaId ?? act?.sagaId,
        steps: plan.steps.map((step) => ({
          ...step,
          id: randomUUID(),
          status: "pending",
          impactAwarded: 0,
          evidenceIds: [],
          artifactIds: [],
        })),
        createdAt: timestamp,
        updatedAt: timestamp,
        version: 1,
        amendments: [],
      };
      state.quests.unshift(quest);
      if (act) {
        act.questIds.push(quest.id);
        act.updatedAt = timestamp;
        if (act.status === "available" || act.status === "locked") act.status = "active";
      }
      addEvent(state, { type: "quest_created", questId: quest.id, message: `El Códice redactó «${quest.title}».` });
      return quest;
    });
    return result;
  }

  /**
   * Cualquier objetivo, en cualquier dominio, entra por aquí. El Códice activo
   * decide la descomposición; el servidor solo valida que el contrato sea jugable.
   */
  async createDraftFromIntent(intent: string, minutesAvailable?: number, actId?: string, campaignId?: string): Promise<Quest> {
    const clean = intent.trim();
    if (clean.length < 8) throw new Error("Describe una quest con un poco más de detalle.");
    const realm = await this.store.read();
    const plan = await this.codice.plan({
      intent: clean,
      playerTitle: `${realm.player.displayName}, ${realm.player.title}`,
      activeCampaign: realm.quests.find((quest) => quest.status === "active")?.campaignTitle,
      minutesAvailable,
    });
    return this.createDraft(plan, { actId, campaignId });
  }

  /**
   * CÓDICE ELIGE LA ESCALA.
   *
   * El jugador sólo expresa el objetivo; esta lectura dice si eso es una Quest,
   * un Acto, una Campaña o una Saga. No crea nada: propone. Y una espera ajena
   * al jugador nunca infla artificialmente la escala.
   */
  classifyObjective(intent: string, input: { activeMinutes?: number; externalWaitMinutes?: number; naturalCampaigns?: number } = {}): ScaleProposal {
    const estimated = estimateActiveMinutes(intent, input.activeMinutes);
    return classifyScale({
      activeMinutes: estimated.activeMinutes,
      externalWaitMinutes: input.externalWaitMinutes ?? estimated.externalWaitMinutes,
      naturalCampaigns: input.naturalCampaigns,
    });
  }

  async reviseDraft(questId: string, plan: QuestPlanInput): Promise<Quest> {
    validatePlan(plan);
    const { result } = await this.store.mutate((state) => {
      const quest = requireQuest(state, questId);
      if (quest.status !== "draft") throw new Error("Solo se puede reformular una quest en borrador.");
      Object.assign(quest, plan, {
        steps: plan.steps.map((step) => ({ ...step, id: randomUUID(), status: "pending" as const, impactAwarded: 0, evidenceIds: [], artifactIds: [] })),
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
      // El pacto ya está sellado: su aviso de «aguarda tu sello» deja de pesar.
      markEntityNotificationsRead(state, quest.id, "quest_created");
      addEvent(state, { type: "quest_accepted", questId, message: `El marqués aceptó «${quest.title}».` });
      return quest;
    });
    return result;
  }

  /**
   * EL RELOJ COMIENZA SÓLO AL INICIAR.
   *
   * No al crear el borrador. No al aceptar el contrato. Aquí —y sólo aquí— se
   * persisten `startedAt`, `durationMinutes` y `deadlineAt` en el Core.
   */
  async start(questId: string, durationMinutes?: number): Promise<Quest> {
    const { result } = await this.store.mutate((state) => {
      const quest = requireQuest(state, questId);
      if (quest.status !== "accepted") throw new Error("La quest debe estar aceptada antes de comenzar.");
      const engaged = engagedQuest(state);
      if (engaged && engaged.id !== questId) {
        throw new Error(`Ya hay una Battle comprometida: «${engaged.title}». Termínala, o espera a que un bloqueo externo libere el frente, antes de iniciar otra.`);
      }
      // DAILY BATTLE LIMIT: sólo cuenta inicios iniciales. Un reintento, un
      // replan o un recontrato del mismo Quest NO consumen cupo. El plan `dev`
      // no tiene tope: `dailyBattleLimit` es null y esto no bloquea a nadie.
      rolloverUsage(state.usage);
      const gate = battleStartAllowed(state.entitlements, state.usage);
      if (!gate.allowed) throw new Error(gate.reason!);
      state.usage.battlesStartedToday += 1;
      const startedAtMs = Date.now();
      const duration = clampBattleMinutes(durationMinutes ?? quest.durationMinutes);
      quest.status = "active";
      quest.startedAt = new Date(startedAtMs).toISOString();
      quest.updatedAt = quest.startedAt;
      quest.battle = createBattleRecord(startedAtMs, duration);
      // Comprometer un frente es también mirarlo: así la Battle visible sigue
      // siendo ésta cuando el reloj termine, sin que nadie tenga que adivinarlo.
      state.focusedQuestId = quest.id;
      state.gameEvents.unshift({
        id: randomUUID(),
        type: "battle_started",
        questId,
        damage: 0,
        battleAttempt: quest.battle.attempt,
        message: `Comienza la Battle de «${quest.title}»: ${duration} min pactados.`,
        createdAt: quest.startedAt,
      });
      state.gameEvents = state.gameEvents.slice(0, 200);
      addEvent(state, {
        type: "battle_started",
        questId,
        message: `Comienza la batalla: «${quest.title}». El reloj corre ${duration} min y la Horda lo aprovechará.`,
      });
      // El grupo entró de verdad a un frente con reloj. Un reintento sobre la
      // misma Quest no vuelve a contar: la clave es el id de la Quest.
      for (const heroId of PARTY_HERO_IDS) {
        const hero = ensureHero(state, heroId);
        if (claimOnce(state, `battle_entered:${heroId}:${quest.id}`)) hero.stats.battlesEntered += 1;
        applyXp(state, heroId, XP_REWARDS.battleEntered, `battle_entered:${quest.id}`, quest.id);
      }
      return quest;
    });
    return result;
  }

  /**
   * Vuelve a intentar una Battle perdida.
   *
   * Perder no borra nada: la evidencia validada sigue en pie y la Horda
   * conserva el daño que ya recibió. Lo que empieza de cero es el reloj y el HP
   * del Marqués, porque es otra Battle sobre la misma Quest.
   */
  async retryBattle(questId: string, durationMinutes?: number): Promise<{ quest: Quest; battle: BattleState }> {
    const { result } = await this.store.mutate((state) => {
      const quest = requireQuest(state, questId);
      const record = quest.battle;
      if (!record) throw new Error("Esta quest todavía no tiene Battle que reintentar.");
      if (record.status === "active") throw new Error("La Battle sigue en curso.");
      if (record.status === "suspended_external") throw new Error("Este frente espera a un tercero: se reanuda al desbloquearse, no se reintenta.");
      if (record.status === "won") throw new Error("Esta Battle ya está ganada.");
      if (!["active", "waiting_external"].includes(quest.status)) throw new Error("Esta quest ya no tiene frente abierto: no hay Battle que reintentar.");
      // EL MARQUÉS CAÍDO NO VUELVE GRATIS: hay que levantarlo primero.
      if (record.party.marques.health === 0) {
        throw new Error("El Marqués sigue en el suelo. Levántalo con un Tónico de Retorno antes de abrir otro intento.");
      }
      const engaged = engagedQuest(state);
      if (engaged && engaged.id !== questId) {
        throw new Error(`Ya hay una Battle comprometida: «${engaged.title}». No puedes sostener dos frentes con reloj a la vez.`);
      }
      const startedAtMs = Date.now();
      // El nuevo pacto se declara: no se restaura la duración original sola.
      openAttempt(record, startedAtMs, durationMinutes ?? record.durationMinutes, "timeout");
      quest.status = "active";
      quest.updatedAt = record.startedAt;
      state.focusedQuestId = quest.id;
      state.gameEvents.unshift({
        id: randomUUID(),
        type: "battle_started",
        questId,
        damage: 0,
        battleAttempt: record.attempt,
        message: `Intento ${record.attempt} sobre «${quest.title}»: ${record.durationMinutes} min pactados.`,
        createdAt: record.startedAt,
      });
      state.gameEvents = state.gameEvents.slice(0, 200);
      addEvent(state, {
        type: "battle_restarted",
        questId,
        message: `El Marqués vuelve al frente de «${quest.title}» (intento ${record.attempt}). Las heridas y la Horda siguen como estaban.`,
      });
      return { quest, battle: battleFor(quest, state.gameEvents)! };
    });
    return result;
  }

  /**
   * Códice propone repactar el tiempo cuando la realidad exige más.
   *
   * No es una derrota: el intento se cierra como `recontracted`, no como
   * timeout, y no se emite `battle_lost`. El nuevo intento sigue sin poder
   * pasar de 60 minutos: 55 + 30 no son 85.
   */
  async proposeBattleRecontract(questId: string, input: { reason: string; newDurationMinutes: number }): Promise<BattleState> {
    if (input.reason.trim().length < 10) throw new Error("Explica qué cambió en la realidad antes de repactar el tiempo.");
    const { result } = await this.store.mutate((state) => {
      const quest = requireQuest(state, questId);
      const record = quest.battle;
      if (!record) throw new Error("Esta quest todavía no tiene Battle.");
      if (record.status !== "active") throw new Error("Sólo una Battle en curso puede repactar su tiempo.");
      // Proponer otra vez sustituye la anterior: sólo hay un pacto sobre la mesa.
      record.pendingRecontract = {
        id: randomUUID(),
        reason: input.reason.trim(),
        newDurationMinutes: clampBattleMinutes(input.newDurationMinutes),
        proposedAt: now(),
      };
      quest.updatedAt = record.pendingRecontract.proposedAt;
      addEvent(state, {
        type: "quest_amendment_proposed",
        questId,
        message: `Códice propone repactar el tiempo de «${quest.title}» a ${record.pendingRecontract.newDurationMinutes} min: ${record.pendingRecontract.reason}`,
      });
      return battleFor(quest, state.gameEvents)!;
    });
    return result;
  }

  async acceptBattleRecontract(questId: string, recontractId: string, userAccepted: boolean): Promise<BattleState> {
    if (!userAccepted) throw new Error("Repactar el tiempo requiere aceptación explícita del jugador.");
    const { result } = await this.store.mutate((state) => {
      const quest = requireQuest(state, questId);
      const record = quest.battle;
      if (!record?.pendingRecontract) throw new Error("No hay ningún nuevo pacto temporal esperando decisión.");
      const proposal = record.pendingRecontract;
      // Se sella una propuesta concreta: si Códice propuso 30 min y luego 15,
      // el jugador tiene que estar aceptando exactamente la que está mirando.
      if (proposal.id !== recontractId) {
        throw new Error(`Ese pacto ya no está sobre la mesa. El vigente propone ${proposal.newDurationMinutes} min: acéptalo por su propio id.`);
      }
      // Todo el estado de combate se preserva: sólo cambia el reloj.
      openAttempt(record, Date.now(), proposal.newDurationMinutes, "recontracted");
      quest.updatedAt = record.startedAt;
      state.gameEvents.unshift({
        id: randomUUID(),
        type: "battle_recontracted",
        questId,
        damage: 0,
        battleAttempt: record.attempt,
        message: `Nuevo pacto temporal: ${record.durationMinutes} min. ${proposal.reason}`,
        createdAt: record.startedAt,
      });
      state.gameEvents = state.gameEvents.slice(0, 200);
      addEvent(state, {
        type: "quest_amended",
        questId,
        message: `El tiempo de «${quest.title}» se repactó en ${record.durationMinutes} min. No es una derrota: el frente sigue igual.`,
      });
      return battleFor(quest, state.gameEvents)!;
    });
    return result;
  }

  /**
   * Usa un objeto del zurrón. El Core valida y decrementa; el renderer no.
   */
  async useInventoryItem(itemId: InventoryItemId, target: PartyMemberId): Promise<{ battle: BattleState | null; remaining: number; message: string }> {
    const { result } = await this.store.mutate((state) => {
      const quest = engagedOrRecoverable(state);
      if (!quest?.battle) throw new Error("No hay ningún frente abierto donde usar objetos.");
      const applied = useItem(state.inventory, quest.battle.party, itemId, target);
      const timestamp = now();
      const member = quest.battle.party[target];
      state.gameEvents.unshift({
        id: randomUUID(),
        type: "inventory_item_used",
        questId: quest.id,
        damage: 0,
        target,
        itemId,
        battleAttempt: quest.battle.attempt,
        message: `${applied.item.name} usado sobre ${member.name}.`,
        createdAt: timestamp,
      });
      state.gameEvents.unshift({
        id: randomUUID(),
        type: applied.revived ? "party_member_revived" : "party_member_healed",
        questId: quest.id,
        damage: applied.healed,
        target,
        itemId,
        battleAttempt: quest.battle.attempt,
        message: applied.revived
          ? `${member.name} vuelve al frente con ${member.health}/${member.maxHealth} HP.`
          : `${member.name} recupera ${applied.healed} HP.`,
        createdAt: timestamp,
      });
      state.gameEvents = state.gameEvents.slice(0, 200);
      addEvent(state, {
        type: "quest_unblocked",
        questId: quest.id,
        message: applied.revived
          ? `${applied.item.name}: ${member.name} vuelve en pie con ${member.health} HP. Queda ${applied.remaining}.`
          : `${applied.item.name}: ${member.name} recupera ${applied.healed} HP. Queda ${applied.remaining}.`,
      });
      return {
        battle: battleFor(quest, state.gameEvents),
        remaining: applied.remaining,
        message: applied.revived
          ? `${member.name} vuelve al frente con ${member.health}/${member.maxHealth} HP.`
          : `${member.name} recupera ${applied.healed} HP.`,
      };
    });
    return result;
  }

  /**
   * Registra que un compañero REAL ejecutó algo.
   *
   * Todavía no concede nada: nace `used_pending_validation`. Opus no ataca
   * porque su nombre exista; ataca cuando su contribución termina validada.
   *
   * IDEMPOTENTE. `questId + stepId + companion + executionRef` —o el mismo
   * `sourceTool` dentro de una ventana corta— identifican LA MISMA ejecución
   * real. Repetir la llamada devuelve el registro existente sin inflar stats,
   * XP, combo ni historia: un reintento técnico no es una hazaña nueva.
   */
  async recordCompanionAssist(input: {
    questId: string;
    stepId: string;
    companion: CompanionId;
    source?: CompanionAssist["source"];
    sourceTool?: string;
    executionRef?: string;
    contributionSummary: string;
  }): Promise<{ assist: CompanionAssist; duplicate: boolean }> {
    if (input.contributionSummary.trim().length < 5) throw new Error("Describe qué hizo realmente el compañero.");
    const { result } = await this.store.mutate((state) => {
      const quest = requireQuest(state, input.questId);
      requireStep(quest, input.stepId);
      const timestamp = now();
      const key = assistKeyFor(input);
      const existing = findExistingAssist(state.companionAssists ?? [], key, Boolean(input.executionRef?.trim()), Date.now());
      if (existing) {
        // MISMA EJECUCIÓN REAL -> MISMO REGISTRO. Ni evento nuevo, ni stat nueva.
        return { assist: existing, duplicate: true };
      }

      const assist: CompanionAssist = {
        id: randomUUID(),
        questId: quest.id,
        stepId: input.stepId,
        companion: input.companion,
        source: input.source ?? "mcp",
        sourceTool: input.sourceTool?.trim().slice(0, 120),
        executionRef: input.executionRef?.trim().slice(0, 200),
        contributionSummary: input.contributionSummary.trim().slice(0, 500),
        status: "used_pending_validation",
        assistKey: key,
        createdAt: timestamp,
      };
      state.companionAssists.unshift(assist);
      state.companionAssists = state.companionAssists.slice(0, 200);
      registerExecution(state, assist, quest);
      markAgentParticipation(state, assist, quest);

      if (quest.battle) {
        const first = deployAgent(quest.battle.agent, input.companion);
        if (first) {
          pushGameEvent(state, {
            type: "agent_deployed",
            questId: quest.id,
            damage: 0,
            companion: input.companion,
            heroId: input.companion,
            battleAttempt: quest.battle.attempt,
            message: `${COMPANIONS[input.companion].name} entra al frente como ${COMPANIONS[input.companion].role}.`,
            createdAt: timestamp,
          });
        }
        pushGameEvent(state, {
          type: "companion_used",
          questId: quest.id,
          stepId: input.stepId,
          damage: 0,
          companion: input.companion,
          heroId: input.companion,
          battleAttempt: quest.battle.attempt,
          message: `${COMPANIONS[input.companion].name}: ${assist.contributionSummary}`,
          createdAt: timestamp,
        });
      }
      return { assist, duplicate: false };
    });
    return result;
  }

  /**
   * Declara la disponibilidad de un agente sin tocar su historia.
   *
   * Si un conector deja de existir NO se borra al héroe ni sus hazañas: se
   * marca `unavailable` y se conserva cuándo fue su último despliegue.
   */
  async setHeroAvailability(heroId: HeroId, availability: HeroAvailability): Promise<BarracksView> {
    const { state } = await this.store.mutate((draft) => {
      ensureRoster(draft);
      const hero = ensureHero(draft, heroId);
      // Declarar acceso NO es participación: los contadores no se tocan aquí.
      hero.availability = availability;
      hero.known = true;
      return hero;
    });
    return barracksViewFor(state);
  }

  /**
   * MENOS LLAMADAS, MISMA VERDAD.
   *
   * Cuando la evidencia llega con metadata suficiente —`sourceProvider`,
   * `sourceTool`, `executionRef`— el Core registra y coalesce la participación
   * del compañero en la MISMA operación autoritativa: no hace falta una llamada
   * aparte a `record_companion_assist` para que Opus aparezca en el frente.
   *
   * `record_companion_assist` sigue existiendo porque sirve para mostrar el
   * despliegue ANTES de la validación; simplemente ya es idempotente.
   */
  async submitEvidence(
    questId: string,
    stepId: string,
    input: {
      summary: string;
      source: EvidenceSource;
      verdict: EvidenceVerdict;
      reasoning: string;
      impactAwarded: number;
      artifactIds?: string[];
      sourceProvider?: CompanionId;
      sourceTool?: string;
      executionRef?: string;
    },
  ): Promise<{ quest: Quest; battle: BattleState; evidenceId: string; lifeEventId: string; gameEventId: string | null }> {
    const { result } = await this.store.mutate((state) => {
      const quest = requireQuest(state, questId);
      if (quest.status !== "active") throw new Error("La quest debe estar activa para evaluar evidencia.");
      if (quest.battle && ["awaiting_replan", "awaiting_recovery"].includes(quest.battle.status)) {
        throw new Error("Este intento se cerró. Replanifica el tiempo —y levanta al Marqués si cayó— antes de entregar más evidencia.");
      }
      const step = quest.steps.find((candidate) => candidate.id === stepId);
      if (!step) throw new Error(`Paso no encontrado: ${stepId}`);
      if (step.status === "completed") throw new Error("Este paso ya recibió todo su impacto.");
      if (step.status === "blocked") throw new Error("Este frente está bloqueado; no hay evidencia que entregar hasta resolver la dependencia.");
      if (step.status === "superseded") throw new Error("Este paso fue sustituido por un amendment y ya no exige acción.");
      if (!input.summary.trim()) throw new Error("Describe brevemente la evidencia aportada.");
      if (!input.reasoning.trim()) throw new Error("Códice debe explicar el veredicto.");
      const remaining = step.weight - step.impactAwarded;
      if (!Number.isInteger(input.impactAwarded) || input.impactAwarded < 0 || input.impactAwarded > remaining) {
        throw new Error(`El impacto debe ser un entero entre 0 y ${remaining}.`);
      }
      if (input.verdict === "rejected" && input.impactAwarded !== 0) {
        throw new Error("La evidencia rechazada no puede causar daño.");
      }
      if (input.verdict === "partial" && (input.impactAwarded <= 0 || input.impactAwarded >= remaining)) {
        throw new Error("La evidencia parcial debe conceder parte, pero no todo, del impacto restante.");
      }
      if (input.verdict === "accepted" && input.impactAwarded !== remaining) {
        throw new Error("La evidencia aceptada debe conceder todo el impacto restante.");
      }

      const timestamp = now();

      // COALESCENCIA DE PARTICIPACIÓN: si la prueba viene de una ejecución real
      // de un compañero, esa participación se registra aquí mismo —idempotente
      // por la misma clave— en vez de exigir una segunda llamada.
      if (input.sourceProvider) {
        const key = assistKeyFor({
          questId,
          stepId,
          companion: input.sourceProvider,
          executionRef: input.executionRef,
          sourceTool: input.sourceTool,
        });
        const already = findExistingAssist(state.companionAssists ?? [], key, Boolean(input.executionRef?.trim()), Date.now());
        if (!already) {
          const assist: CompanionAssist = {
            id: randomUUID(),
            questId,
            stepId,
            companion: input.sourceProvider,
            source: "mcp",
            sourceTool: input.sourceTool?.trim().slice(0, 120),
            executionRef: input.executionRef?.trim().slice(0, 200),
            contributionSummary: input.summary.trim().slice(0, 500),
            status: "used_pending_validation",
            assistKey: key,
            createdAt: timestamp,
          };
          state.companionAssists.unshift(assist);
          state.companionAssists = state.companionAssists.slice(0, 200);
          registerExecution(state, assist, quest);
          markAgentParticipation(state, assist, quest);
          if (quest.battle) deployAgent(quest.battle.agent, input.sourceProvider);
        }
      }

      const evidenceId = randomUUID();
      const artifactIds = (input.artifactIds ?? []).filter((id) => state.artifacts.some((artifact) => artifact.id === id && artifact.questId === questId && artifact.stepIds.includes(stepId)));
      state.evidence.unshift({ id: evidenceId, questId, stepId, summary: input.summary.trim(), source: input.source, verdict: input.verdict, reasoning: input.reasoning.trim(), impactAwarded: input.impactAwarded, artifactIds, createdAt: timestamp });
      state.evidence = state.evidence.slice(0, 200);

      const lifeEventId = randomUUID();
      state.lifeEvents.unshift({ id: lifeEventId, type: "evidence_submitted", questId, stepId, evidenceId, verdict: input.verdict, impactAwarded: input.impactAwarded, createdAt: timestamp });
      state.lifeEvents = state.lifeEvents.slice(0, 200);

      step.evidenceIds.push(evidenceId);
      step.evidenceNote = input.summary.trim();
      step.impactAwarded += input.impactAwarded;
      step.status = step.impactAwarded === step.weight ? "completed" : step.impactAwarded > 0 ? "in_progress" : "pending";
      if (step.status === "completed") step.completedAt = timestamp;
      quest.updatedAt = timestamp;

      let gameEventId: string | null = null;
      if (input.impactAwarded > 0) {
        gameEventId = randomUUID();
        const record = quest.battle;
        // MARQUÉS DISPARA: el impacto validado cae sobre enemigos concretos,
        // y el sobrante desborda al siguiente. Ningún daño se pierde.
        const hits = record ? distributeEnemyDamage(record.enemies, input.impactAwarded) : [];
        state.gameEvents.unshift({
          id: gameEventId,
          type: "quest_attack",
          sourceLifeEventId: lifeEventId,
          questId,
          stepId,
          damage: input.impactAwarded,
          target: "marques",
          battleAttempt: record?.attempt ?? 1,
          enemyAllocations: hits.map((hit) => ({ enemyId: hit.enemy.id, name: hit.enemy.name, damage: hit.damage, killed: hit.killed })),
          message: hits.length > 0
            ? `${step.title}: ${hits.map((hit) => `${hit.enemy.name} -${hit.damage}`).join(", ")}.`
            : `${step.title}: ataque de ${input.impactAwarded}.`,
          createdAt: timestamp,
        });
        for (const hit of hits.filter((candidate) => candidate.killed)) {
          state.gameEvents.unshift({
            id: randomUUID(),
            type: "enemy_ko",
            questId,
            damage: 0,
            sourceEnemyId: hit.enemy.id,
            battleAttempt: record?.attempt ?? 1,
            message: `${hit.enemy.name} cae. La Horda pierde su presión y su pasiva.`,
            createdAt: timestamp,
          });
        }
        state.gameEvents = state.gameEvents.slice(0, 200);

        if (record && record.status === "active") {
          // EL AGENTE EJECUTA: sólo si alguien ayudó de verdad en ESTE paso.
          const assists = pendingAssistsFor(state.companionAssists, questId, stepId);
          if (assists.length > 0) {
            const jammed = record.enemies.some((enemy) => enemy.status === "active" && enemy.archetypeId === "h08_saboteur");
            const combo = comboDamageFor(input.impactAwarded, assists.length, jammed);
            for (const assist of assists) {
              assist.status = "contribution_validated";
              assist.validatedAt = timestamp;
              assist.bonusDamage = Math.round(combo / assists.length);
              deployAgent(record.agent, assist.companion);
              // A VALIDATED CONTRIBUTION CAN BECOME COMBAT — y sólo entonces
              // deja carrera. Idempotente por el id del assist.
              markAgentValidation(state, assist, quest, input.impactAwarded, evidenceId);
            }
            record.agent.status = "assist_validated";
            record.agent.comboDamage += combo;
            const comboHits = distributeEnemyDamage(record.enemies, combo);
            state.gameEvents.unshift({
              id: randomUUID(),
              type: "companion_combo_attack",
              sourceLifeEventId: lifeEventId,
              questId,
              stepId,
              damage: combo,
              companion: assists[0].companion,
              battleAttempt: record.attempt,
              enemyAllocations: comboHits.map((hit) => ({ enemyId: hit.enemy.id, name: hit.enemy.name, damage: hit.damage, killed: hit.killed })),
              message: `${COMPANIONS[assists[0].companion].name} remata: +${combo} de combo${jammed ? " (recortado por el Saboteador)" : ""}.`,
              createdAt: timestamp,
            });
            for (const hit of comboHits.filter((candidate) => candidate.killed)) {
              state.gameEvents.unshift({
                id: randomUUID(),
                type: "enemy_ko",
                questId,
                damage: 0,
                sourceEnemyId: hit.enemy.id,
                battleAttempt: record.attempt,
                message: `${hit.enemy.name} cae bajo el combo.`,
                createdAt: timestamp,
              });
            }
            state.gameEvents = state.gameEvents.slice(0, 200);
          }

          // CORDERA SOSTIENE y ROKO PROTEGE: sólo el resultado real los mueve.
          const healed = healTarget(record.party);
          if (healed) {
            const amount = healMember(record.party, healed, HEAL_PER_VALIDATED_IMPACT);
            if (amount > 0) {
              state.gameEvents.unshift({
                id: randomUUID(),
                type: "party_heal",
                sourceLifeEventId: lifeEventId,
                questId,
                stepId,
                damage: amount,
                target: healed,
                battleAttempt: record.attempt,
                message: `Cordera sostiene a ${record.party[healed].name}: +${amount} HP.`,
                createdAt: timestamp,
              });
            }
          }
          const shielded = refreshShield(record.party, SHIELD_PER_VALIDATED_IMPACT);
          if (shielded > 0) {
            state.gameEvents.unshift({
              id: randomUUID(),
              type: "shield_gained",
              sourceLifeEventId: lifeEventId,
              questId,
              stepId,
              damage: shielded,
              target: "roko",
              battleAttempt: record.attempt,
              message: `Instinto Protector: Roko recupera +${shielded} de escudo.`,
              createdAt: timestamp,
            });
          }
          state.gameEvents = state.gameEvents.slice(0, 200);

          if (hordeIsDown(record) && !record.hordeNeutralizedAt) {
            record.hordeNeutralizedAt = timestamp;
            state.gameEvents.unshift({
              id: randomUUID(),
              type: "horde_neutralized",
              questId,
              damage: 0,
              battleAttempt: record.attempt,
              message: "La Horda queda neutralizada. La presión temporal se detiene, pero el contrato sigue abierto.",
              createdAt: timestamp,
            });
            state.gameEvents = state.gameEvents.slice(0, 200);
            addEvent(state, {
              type: "horde_attack",
              questId,
              message: "Toda la Horda cayó. Deja de haber presión temporal; la victoria la firma el contrato validado.",
            });
          }
        }
      }
      addEvent(state, {
        type: "step_completed",
        questId,
        message: input.impactAwarded > 0 ? `${step.title}: impacto validado de ${input.impactAwarded} puntos.` : `${step.title}: evidencia rechazada; sin impacto.`,
      });
      let battle = battleFor(quest, state.gameEvents)!;
      if (battle.isKo) {
        // TODO EN LA MISMA MUTACIÓN: nada de proyecciones a medias.
        completeQuest(state, quest, now());
        battle = battleFor(quest, state.gameEvents)!;
      }
      return { quest, battle, evidenceId, lifeEventId, gameEventId };
    });
    return result;
  }

  /**
   * Entrega un hecho real al MCP: un documento, un enlace o un texto.
   * El servidor comprueba lo comprobable y lo guarda en el reino. Todavía no
   * causa daño: un artefacto es materia prima de un veredicto, no el veredicto.
   */
  async attachArtifact(questId: string, stepId: string, input: ArtifactInput): Promise<EvidenceArtifact> {
    const state = await this.store.read();
    const quest = requireQuest(state, questId);
    if (["completed", "abandoned"].includes(quest.status)) {
      throw new Error("Esta quest ya no admite evidencia.");
    }
    if (!quest.steps.some((step) => step.id === stepId)) throw new Error(`Paso no encontrado: ${stepId}`);

    const artifact = await ingestArtifact(input, questId, stepId, this.dataDir);

    const { result } = await this.store.mutate((fresh) => {
      const freshQuest = requireQuest(fresh, questId);
      const step = freshQuest.steps.find((candidate) => candidate.id === stepId);
      if (!step) throw new Error(`Paso no encontrado: ${stepId}`);
      fresh.artifacts.unshift(artifact);
      fresh.artifacts = fresh.artifacts.slice(0, 200);
      step.artifactIds.push(artifact.id);
      freshQuest.updatedAt = now();
      addEvent(fresh, {
        type: "evidence_attached",
        questId,
        message: `${step.title}: llegó ${artifact.label}${artifact.verification.verified ? " (comprobado)" : " (sin comprobar)"}.`,
      });
      return artifact;
    });
    return result;
  }

  /**
   * Registra un artefacto que el Dungeon Master examinó donde vive el archivo.
   * Permite jugar sin tocar el teléfono: la prueba nunca pasa por el juego.
   */
  async attestArtifact(questId: string, stepId: string, input: WitnessInput): Promise<EvidenceArtifact> {
    const { result } = await this.store.mutate((state) => {
      const quest = requireQuest(state, questId);
      if (["completed", "abandoned"].includes(quest.status)) {
        throw new Error("Esta quest ya no admite evidencia.");
      }
      const step = quest.steps.find((candidate) => candidate.id === stepId);
      if (!step) throw new Error(`Paso no encontrado: ${stepId}`);

      const artifact = witnessArtifact(input, questId, stepId);
      state.artifacts.unshift(artifact);
      state.artifacts = state.artifacts.slice(0, 200);
      step.artifactIds.push(artifact.id);
      quest.updatedAt = now();
      addEvent(state, {
        type: "evidence_attached",
        questId,
        message: `${step.title}: ${artifact.verification.witness} examinó ${artifact.label}.`,
      });
      return artifact;
    });
    return result;
  }

  /**
   * Cierra el bucle: Códice juzga la evidencia del paso y el veredicto se
   * convierte en LifeEvent y, solo si hay impacto, en el ataque de la batalla.
   */
  async verifyStep(
    questId: string,
    stepId: string,
    input: {
      note?: string;
      artifactIds?: string[];
      attach?: ArtifactInput;
      /** Compañero real cuya ejecución produjo esta prueba, si lo hubo. */
      sourceProvider?: CompanionId;
      sourceTool?: string;
      executionRef?: string;
    },
  ): Promise<CodiceVerdictResult> {
    if (input.attach) await this.attachArtifact(questId, stepId, input.attach);

    const state = await this.store.read();
    const quest = requireQuest(state, questId);
    if (quest.status !== "active") throw new Error("La quest debe estar activa para evaluar evidencia.");
    const step: QuestStep | undefined = quest.steps.find((candidate) => candidate.id === stepId);
    if (!step) throw new Error(`Paso no encontrado: ${stepId}`);
    if (step.status === "completed") throw new Error("Este paso ya recibió todo su impacto.");

    const wanted = input.artifactIds?.length ? new Set(input.artifactIds) : new Set(step.artifactIds);
    const artifacts = state.artifacts.filter((artifact) => artifact.questId === questId && artifact.stepIds.includes(stepId) && wanted.has(artifact.id));
    const note = (input.note ?? "").trim();
    if (!note && artifacts.length === 0) {
      throw new Error("Entrega un artefacto o describe la evidencia antes de pedir el veredicto.");
    }

    const remainingImpact = step.weight - step.impactAwarded;
    const raw = await this.codice.judge({ quest, step, remainingImpact, note, artifacts });
    const judgement = enforceArtifactRule(raw, step, artifacts, remainingImpact);
    const source: EvidenceSource = artifacts.some((artifact) => artifact.kind === "file")
      ? "file"
      : artifacts.length > 0
        ? "mcp"
        : "user_declaration";

    const applied = await this.submitEvidence(questId, stepId, {
      summary: note || artifacts.map((artifact) => artifact.label).join(", "),
      source,
      verdict: judgement.verdict,
      reasoning: judgement.reasoning,
      impactAwarded: judgement.impactAwarded,
      artifactIds: artifacts.map((artifact) => artifact.id),
      sourceProvider: input.sourceProvider,
      sourceTool: input.sourceTool,
      executionRef: input.executionRef,
    });

    return { ...applied, judgement, artifacts };
  }

  /**
   * LEGADO. No expuesto por MCP y fuera de los flujos nuevos.
   *
   * Concede todo el impacto restante de un paso sin veredicto razonado, así que
   * salta el principio del juego: EVIDENCIA REAL -> VALIDACIÓN -> IMPACTO. Se
   * conserva sólo para la quest demostrativa y las pruebas.
   */
  async completeStep(questId: string, stepId: string, evidenceNote: string): Promise<{ quest: Quest; battle: BattleState }> {
    const snapshot = await this.snapshot();
    const step = snapshot.realm.quests.find((quest) => quest.id === questId)?.steps.find((candidate) => candidate.id === stepId);
    if (!step) throw new Error(`Paso no encontrado: ${stepId}`);
    const result = await this.submitEvidence(questId, stepId, {
      summary: evidenceNote,
      source: "user_declaration",
      verdict: "accepted",
      reasoning: "Camino legado: evidencia declarada como suficiente sin veredicto razonado.",
      impactAwarded: step.weight - step.impactAwarded,
    });
    return { quest: result.quest, battle: result.battle };
  }

  async proposeAmendment(
    questId: string,
    input: { reason: string; proposedBy: string; changes: QuestAmendmentChange[] },
  ): Promise<QuestAmendment> {
    if (input.reason.trim().length < 10) throw new Error("Explica qué cambió en la realidad antes de proponer el amendment.");
    if (input.changes.length === 0) throw new Error("El amendment debe proponer al menos un cambio.");

    const { result } = await this.store.mutate((state) => {
      const quest = requireQuest(state, questId);
      if (!["active", "waiting_external"].includes(quest.status)) throw new Error("Sólo una quest iniciada puede recibir un amendment.");
      if (quest.amendments.some((candidate) => candidate.status === "proposed")) throw new Error("Ya existe un amendment esperando decisión del jugador.");

      // Validar sobre una copia garantiza que la propuesta aceptada será aplicable,
      // sin tocar todavía el contrato ni el impacto histórico.
      const preview = structuredClone(quest);
      applyAmendmentChanges(preview, input.changes, now());

      const amendment: QuestAmendment = {
        id: randomUUID(),
        status: "proposed",
        reason: input.reason.trim(),
        proposedBy: input.proposedBy.trim() || "codice",
        previousVersion: quest.version,
        newVersion: quest.version + 1,
        changes: input.changes,
        createdAt: now(),
      };
      quest.amendments.unshift(amendment);
      quest.updatedAt = amendment.createdAt;
      addEvent(state, { type: "quest_amendment_proposed", questId, message: `Códice propone adaptar «${quest.title}»: ${amendment.reason}` });
      return amendment;
    });
    return result;
  }

  async acceptAmendment(questId: string, amendmentId: string, userAccepted: boolean): Promise<{ quest: Quest; amendment: QuestAmendment; battle: BattleState }> {
    if (!userAccepted) throw new Error("Los cambios materiales requieren aceptación explícita del jugador.");
    const { result } = await this.store.mutate((state) => {
      const quest = requireQuest(state, questId);
      const amendment = quest.amendments.find((candidate) => candidate.id === amendmentId);
      if (!amendment) throw new Error(`Amendment no encontrado: ${amendmentId}`);
      if (amendment.status !== "proposed") throw new Error("Este amendment ya fue resuelto.");

      const historicalImpact = quest.steps.reduce((sum, step) => sum + step.impactAwarded, 0);
      const previousStatus = quest.status;
      const timestamp = now();
      applyAmendmentChanges(quest, amendment.changes, timestamp);
      const preservedImpact = quest.steps.reduce((sum, step) => sum + step.impactAwarded, 0);
      if (preservedImpact !== historicalImpact) throw new Error("El amendment intentó alterar impacto histórico.");

      amendment.status = "accepted";
      amendment.acceptedAt = timestamp;
      quest.version = amendment.newVersion;
      quest.updatedAt = timestamp;
      const next = reconcileExternalWaiting(quest);
      addEvent(state, { type: "quest_amended", questId, message: `El campo de batalla cambió: «${quest.title}» ahora está en v${quest.version}.` });
      if (next === "waiting") {
        addEvent(state, { type: "quest_waiting_external", questId, message: `«${quest.title}» espera una condición externa. No hay acción requerida del Marqués.` });
      } else if (previousStatus === "waiting_external") {
        addEvent(state, { type: "quest_unblocked", questId, message: `El sello externo cedió: «${quest.title}» vuelve a estar activa.` });
      }
      return { quest, amendment, battle: battleFor(quest, state.gameEvents)! };
    });
    return result;
  }

  async reuseArtifact(questId: string, artifactId: string, targetStepId: string): Promise<EvidenceArtifact> {
    const { result } = await this.store.mutate((state) => {
      const quest = requireQuest(state, questId);
      const step = requireStep(quest, targetStepId);
      const artifact = state.artifacts.find((candidate) => candidate.id === artifactId && candidate.questId === questId);
      if (!artifact) throw new Error(`Artefacto no encontrado en esta quest: ${artifactId}`);
      if (!artifact.stepIds.includes(targetStepId)) artifact.stepIds.push(targetStepId);
      if (!step.artifactIds.includes(artifactId)) step.artifactIds.push(artifactId);
      quest.updatedAt = now();
      addEvent(state, { type: "evidence_attached", questId, message: `${artifact.label} también queda disponible para «${step.title}», sin duplicar bytes.` });
      return artifact;
    });
    return result;
  }

  /**
   * LA HORDA SÓLO GOLPEA POR UNA EXIGENCIA REAL.
   *
   * `unexpected_requirement` representa una condición nueva e imprevista que
   * AUMENTA el trabajo del jugador. Jamás puede nacer de un reintento de
   * herramienta, de una traza de depuración, de latencia, de un assist
   * duplicado ni del simple paso del tiempo: la presión temporal ya la cobra el
   * propio servidor por ventanas, y castigar dos veces lo mismo sería mentir.
   */
  async recordUnexpectedRequirement(
    questId: string,
    input: { reason: string; damage: number; stepId?: string },
  ): Promise<{ battle: BattleState; lifeEventId: string; gameEventId: string }> {
    if (input.reason.trim().length < 10) throw new Error("Describe el requisito inesperado que representa este ataque.");
    if (!Number.isInteger(input.damage) || input.damage < 1 || input.damage > 50) throw new Error("El daño debe ser un entero entre 1 y 50.");
    if (FORBIDDEN_REQUIREMENT_REASON.test(input.reason)) {
      throw new Error(
        "Un reintento, un error técnico, la latencia, un assist duplicado o el tiempo transcurrido NO son exigencias nuevas de la realidad. La presión del reloj ya la cobra el servidor: no la cobres otra vez a mano.",
      );
    }
    const { result } = await this.store.mutate((state) => {
      const quest = requireQuest(state, questId);
      if (quest.status !== "active") throw new Error("La Horda sólo puede atacar un frente activo con presión real; una espera externa no recibe daño automático.");
      if (input.stepId) requireStep(quest, input.stepId);
      const timestamp = now();
      const lifeEventId = randomUUID();
      state.lifeEvents.unshift({ id: lifeEventId, type: "unexpected_requirement", questId, stepId: input.stepId, reason: input.reason.trim(), createdAt: timestamp });
      const gameEventId = randomUUID();
      // Un requisito inesperado golpea el frente igual que el reloj: cae sobre
      // quien la formación deje expuesto, y el escudo se gasta antes que la vida.
      const record = quest.battle;
      const party = record?.party ?? freshParty();
      const attacker = record?.enemies.find((enemy) => enemy.status === "active");
      const target: PartyMemberId = attacker
        ? enemyTargetFor(attacker, party, record!.combatSeed, record!.attempt)
        : party.roko.health > 0
          ? "roko"
          : "marques";
      const { absorbed, ko } = applyDamage(party, target, input.damage);
      state.gameEvents.unshift({
        id: gameEventId,
        type: "horde_attack",
        sourceLifeEventId: lifeEventId,
        questId,
        stepId: input.stepId,
        damage: input.damage,
        reason: input.reason.trim(),
        battleAttempt: record?.attempt ?? 1,
        target,
        sourceEnemyId: attacker?.id,
        message: `La Horda contraataca sobre ${party[target].name}: ${input.reason.trim()} (-${input.damage}).`,
        createdAt: timestamp,
      });
      if (absorbed > 0) {
        state.gameEvents.unshift({
          id: randomUUID(),
          type: "shield_absorbed",
          sourceLifeEventId: lifeEventId,
          questId,
          damage: absorbed,
          target,
          battleAttempt: record?.attempt ?? 1,
          message: `El escudo de ${party[target].name} absorbe ${absorbed}.`,
          createdAt: timestamp,
        });
      }
      if (ko) {
        state.gameEvents.unshift({
          id: randomUUID(),
          type: "party_member_ko",
          sourceLifeEventId: lifeEventId,
          questId,
          damage: 0,
          target,
          battleAttempt: record?.attempt ?? 1,
          message: `${party[target].name} cae en el frente.`,
          createdAt: timestamp,
        });
      }
      state.lifeEvents = state.lifeEvents.slice(0, 200);
      state.gameEvents = state.gameEvents.slice(0, 200);
      let battle = battleFor(quest, state.gameEvents)!;
      addEvent(state, {
        type: "horde_attack",
        questId,
        message: `La Horda golpea a ${party[target].name} (-${input.damage}). El Marqués conserva ${battle.playerHealth} HP.`,
      });
      if (battle.isPlayerKo && record?.status === "active") {
        resolveBattle(state, quest, record, "awaiting_recovery", Date.now());
        battle = battleFor(quest, state.gameEvents)!;
      }
      return { battle, lifeEventId, gameEventId };
    });
    return result;
  }

  /**
   * ANULAR UN HECHO REGISTRADO POR ERROR.
   *
   * NO HARD DELETE. El hecho se queda en la auditoría marcado `invalidated`,
   * con quién lo anuló, cuándo y por qué; las proyecciones de gameplay dejan de
   * contarlo. Corregir un error operativo no puede exigir falsificar historia.
   *
   * Si el hecho anulado fue un `unexpected_requirement`, su daño se devuelve al
   * grupo con exactitud —vida y escudo por separado—, porque ese golpe nunca
   * debió existir. Lo que sí es historia real (evidencia validada, impacto,
   * dinero) no se toca aquí y no se toca nunca.
   */
  async invalidateEvent(input: {
    eventId: string;
    reason: string;
    invalidatedBy?: string;
  }): Promise<{ eventId: string; type: string; healed: number; shieldRestored: number; message: string }> {
    if (input.reason.trim().length < 10) throw new Error("Explica por qué este hecho fue un error operativo antes de anularlo.");
    const { result } = await this.store.mutate((state) => {
      const timestamp = now();
      const by = input.invalidatedBy?.trim().slice(0, 60) || "codice";
      const lifeEvent = (state.lifeEvents ?? []).find((candidate) => candidate.id === input.eventId);
      const gameEvent = (state.gameEvents ?? []).find((candidate) => candidate.id === input.eventId);
      if (!lifeEvent && !gameEvent) throw new Error(`Hecho no encontrado: ${input.eventId}`);
      if (lifeEvent?.status === "invalidated" || gameEvent?.status === "invalidated") {
        throw new Error("Ese hecho ya estaba anulado. Anular dos veces no devuelve el doble.");
      }

      let healed = 0;
      let shieldRestored = 0;
      const target = lifeEvent ?? gameEvent!;
      const type = lifeEvent ? lifeEvent.type : gameEvent!.type;

      const stamp = (record: { status?: string; invalidatedAt?: string; invalidatedBy?: string; invalidationReason?: string }) => {
        record.status = "invalidated";
        record.invalidatedAt = timestamp;
        record.invalidatedBy = by;
        record.invalidationReason = input.reason.trim().slice(0, 300);
      };
      stamp(target as never);

      if (lifeEvent) {
        // Los hechos visuales derivados dejan de contar con él.
        const derived = (state.gameEvents ?? []).filter((candidate) => candidate.sourceLifeEventId === lifeEvent.id);
        for (const event of derived) stamp(event as never);

        if (lifeEvent.type === "unexpected_requirement") {
          const quest = state.quests.find((candidate) => candidate.id === lifeEvent.questId);
          const party = quest?.battle?.party;
          const attack = derived.find((event) => event.type === "horde_attack");
          const absorbedEvent = derived.find((event) => event.type === "shield_absorbed");
          if (party && attack?.target) {
            const member = party[attack.target];
            const absorbed = absorbedEvent?.damage ?? 0;
            const toHealth = Math.max(0, attack.damage - absorbed);
            const beforeHealth = member.health;
            member.health = Math.min(member.maxHealth, member.health + toHealth);
            healed = member.health - beforeHealth;
            if (member.maxShield !== undefined && member.shield !== undefined && absorbed > 0) {
              const beforeShield = member.shield;
              member.shield = Math.min(member.maxShield, member.shield + absorbed);
              shieldRestored = member.shield - beforeShield;
            }
            if (member.health > 0) member.status = "active";
          }
        }
      }

      const message =
        healed > 0 || shieldRestored > 0
          ? `Hecho anulado. El grupo recupera ${healed} HP y ${shieldRestored} de escudo que un error operativo le había quitado. La auditoría conserva el registro.`
          : "Hecho anulado. Sigue en la auditoría marcado como inválido y las proyecciones de gameplay dejan de contarlo.";

      addEvent(state, {
        type: "event_invalidated",
        entityType: "quest",
        entityId: (lifeEvent?.questId ?? gameEvent?.questId) || input.eventId,
        message: `Hecho «${type}» anulado por ${by}: ${input.reason.trim()}`,
      });

      return { eventId: input.eventId, type, healed, shieldRestored, message };
    });
    return result;
  }

  // -------------------------------------------------------------------------
  // SAGA -> CAMPANA -> ACTO
  //
  // Los padres se crean sólo cuando la vida los pide. Una microquest de quince
  // minutos no genera Acto ni Campaña ceremonial: entra directo en batalla.
  // -------------------------------------------------------------------------

  /**
   * Cambia la campaña EN FOCO. No cierra, no reinicia y no pausa ninguna otra:
   * las demás siguen `active` y simplemente no atacan al jugador por no estar
   * mirándolas. Varios frentes de vida no pueden matarlo a la vez.
   */
  async focusCampaign(campaignId: string | null): Promise<RealmSnapshot> {
    await this.store.mutate((state) => {
      if (campaignId === null) {
        delete state.focusedCampaignId;
        return null;
      }
      const campaign = requireCampaign(state, campaignId);
      if (campaign.status === "draft") throw new Error("Sella el pacto antes de poner esta campaña en foco.");
      // Idempotente: enfocar dos veces no genera dos hechos.
      if (state.focusedCampaignId === campaign.id) return campaign;
      state.focusedCampaignId = campaign.id;
      addEvent(state, {
        type: "campaign_focused",
        entityType: "campaign",
        entityId: campaign.id,
        message: `El reino mira ahora «${campaign.title}». Los demás frentes siguen abiertos.`,
      });
      return campaign;
    });
    return this.snapshot();
  }

  async createSaga(input: { title: string; summary?: string; estimatedActiveMinutes?: number }): Promise<Saga> {
    if (input.title.trim().length < 3) throw new Error("La saga necesita un título.");
    const { result } = await this.store.mutate((state) => {
      const timestamp = now();
      const saga: Saga = {
        id: randomUUID(),
        title: input.title.trim().slice(0, 120),
        summary: input.summary?.trim().slice(0, 500),
        status: "active",
        campaignIds: [],
        estimatedActiveMinutes: Math.max(0, Math.round(input.estimatedActiveMinutes ?? 0)),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      state.sagas.unshift(saga);
      return saga;
    });
    return result;
  }

  /**
   * Traza una campaña como BORRADOR. No vive hasta que el jugador la sella.
   *
   * Los Actos iniciales son planificación operativa del Códice: pueden venir
   * con la propuesta y no exigen ceremonia propia. Una campaña puede empezar
   * sin conocer todos sus Actos; crecerá cuando la realidad los revele.
   */
  async createCampaignDraft(input: {
    title: string;
    intent?: string;
    summary?: string;
    objective?: string;
    rationale?: string;
    sagaId?: string;
    estimatedActiveMinutes?: number;
    estimatedCalendarDays?: number;
    scenario?: string;
    bossTitle?: string;
    bossDescription?: string;
    initialActs?: Array<{ title: string; subtitle?: string; outcome?: string; estimatedActiveMinutes?: number }>;
  }): Promise<{ campaign: Campaign; acts: Act[] }> {
    if (input.title.trim().length < 3) throw new Error("La campaña necesita un título.");
    const { result } = await this.store.mutate((state) => {
      const saga = input.sagaId ? state.sagas.find((candidate) => candidate.id === input.sagaId) : undefined;
      if (input.sagaId && !saga) throw new Error(`Saga no encontrada: ${input.sagaId}`);
      const timestamp = now();
      const campaign: Campaign = {
        id: randomUUID(),
        sagaId: saga?.id,
        title: input.title.trim().slice(0, 120),
        intent: input.intent?.trim().slice(0, 1000),
        summary: input.summary?.trim().slice(0, 500),
        objective: input.objective?.trim().slice(0, 500),
        rationale: input.rationale?.trim().slice(0, 1000),
        status: "draft",
        actIds: [],
        estimatedActiveMinutes: Math.max(0, Math.round(input.estimatedActiveMinutes ?? 0)),
        estimatedCalendarDays: input.estimatedCalendarDays !== undefined ? Math.max(0, Math.round(input.estimatedCalendarDays)) : undefined,
        scenario: input.scenario?.trim().slice(0, 120),
        bossTitle: input.bossTitle?.trim().slice(0, 120),
        bossDescription: input.bossDescription?.trim().slice(0, 300),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      state.campaigns.unshift(campaign);
      if (saga) {
        saga.campaignIds.push(campaign.id);
        saga.updatedAt = timestamp;
      }

      const acts = (input.initialActs ?? []).slice(0, MAX_ACTS_PER_CAMPAIGN).map((proposal) => {
        const act = buildAct(campaign, proposal, timestamp);
        state.acts.unshift(act);
        campaign.actIds.push(act.id);
        return act;
      });

      addEvent(state, {
        type: "campaign_created",
        entityType: "campaign",
        entityId: campaign.id,
        message: `El Códice trazó la campaña «${campaign.title}». Un nuevo pacto aguarda tu sello.`,
      });
      for (const act of acts) {
        addEvent(state, { type: "act_created", entityType: "act", entityId: act.id, message: `Acto trazado: «${act.title}».` });
      }
      return { campaign, acts };
    });
    return result;
  }

  /**
   * Retira una campaña. Un pacto trazado por error no puede quedarse vivo.
   *
   * No borra nada: las quests conservan su id, su estado y su historia, y
   * simplemente dejan de colgar de una campaña retirada.
   */
  async abandonCampaign(campaignId: string, reason: string): Promise<Campaign> {
    const { result } = await this.store.mutate((state) => {
      const campaign = requireCampaign(state, campaignId);
      if (campaign.status === "abandoned") return campaign;
      if (campaign.status === "completed") throw new Error("Una campaña conquistada es historia: no se retira.");
      campaign.status = "abandoned";
      campaign.updatedAt = now();
      if (state.focusedCampaignId === campaign.id) delete state.focusedCampaignId;
      addEvent(state, {
        type: "campaign_abandoned",
        entityType: "campaign",
        entityId: campaign.id,
        message: `Retirada de «${campaign.title}»: ${reason.trim() || "sin motivo registrado"}.`,
      });
      return campaign;
    });
    return result;
  }

  /**
   * Convierte una intención amplia en un borrador de Campaña con Actos.
   *
   * No inventa frentes: si el jugador declaró Finaer, Real Business y Google
   * Ads, propone esos tres Actos y ninguno más. Si no declaró ninguno, deja la
   * campaña sin Actos antes que fabricar estructura vacía. No crea Battles y
   * no salta el sello del jugador.
   */
  async planCampaignFromIntent(input: {
    intent: string;
    activeMinutes?: number;
    calendarDays?: number;
    fronts?: string[];
  }): Promise<{ campaign: Campaign; acts: Act[]; proposal: ScaleProposal }> {
    const intent = input.intent.trim();
    if (intent.length < 8) throw new Error("Describe el objetivo con un poco más de detalle.");
    const fronts = (input.fronts ?? []).map((front) => front.trim()).filter(Boolean).slice(0, MAX_ACTS_PER_CAMPAIGN);
    const proposal = this.classifyObjective(intent, { activeMinutes: input.activeMinutes, naturalCampaigns: 1 });
    if (proposal.scale === "quest") {
      throw new Error(
        `Esto son ${proposal.activeMinutes} min de trabajo activo: cabe en una sola Battle. Crea una Quest y no una Campaña; no hagas jerarquía ceremonial.`,
      );
    }
    const minutesPerFront = fronts.length > 0 ? Math.round(proposal.activeMinutes / fronts.length) : 0;
    return this.createCampaignDraft({
      title: campaignTitleFrom(intent),
      intent,
      objective: `Dejar atendido de forma verificable: ${intent}`,
      rationale: proposal.reason,
      estimatedActiveMinutes: proposal.activeMinutes,
      estimatedCalendarDays: input.calendarDays,
      initialActs: fronts.map((front) => ({ title: front, outcome: `${front} queda atendido y comprobable.`, estimatedActiveMinutes: minutesPerFront })),
    }).then((created) => ({ ...created, proposal }));
  }

  /** Corrige un pacto todavía no sellado. No toca historia ni Actos cerrados. */
  async reviseCampaignDraft(
    campaignId: string,
    patch: {
      title?: string;
      intent?: string;
      summary?: string;
      objective?: string;
      rationale?: string;
      estimatedActiveMinutes?: number;
      estimatedCalendarDays?: number;
      scenario?: string;
      bossTitle?: string;
      bossDescription?: string;
      initialActs?: Array<{ title: string; subtitle?: string; outcome?: string; estimatedActiveMinutes?: number }>;
    },
  ): Promise<{ campaign: Campaign; acts: Act[] }> {
    const { result } = await this.store.mutate((state) => {
      const campaign = requireCampaign(state, campaignId);
      if (campaign.status !== "draft") throw new Error("Sólo se puede reformular una campaña en borrador.");
      const timestamp = now();
      if (patch.title !== undefined) campaign.title = patch.title.trim().slice(0, 120);
      if (patch.intent !== undefined) campaign.intent = patch.intent.trim().slice(0, 1000);
      if (patch.summary !== undefined) campaign.summary = patch.summary.trim().slice(0, 500);
      if (patch.objective !== undefined) campaign.objective = patch.objective.trim().slice(0, 500);
      if (patch.rationale !== undefined) campaign.rationale = patch.rationale.trim().slice(0, 1000);
      if (patch.estimatedActiveMinutes !== undefined) campaign.estimatedActiveMinutes = Math.max(0, Math.round(patch.estimatedActiveMinutes));
      if (patch.estimatedCalendarDays !== undefined) campaign.estimatedCalendarDays = Math.max(0, Math.round(patch.estimatedCalendarDays));
      if (patch.scenario !== undefined) campaign.scenario = patch.scenario.trim().slice(0, 120);
      if (patch.bossTitle !== undefined) campaign.bossTitle = patch.bossTitle.trim().slice(0, 120);
      if (patch.bossDescription !== undefined) campaign.bossDescription = patch.bossDescription.trim().slice(0, 300);

      if (patch.initialActs) {
        // Sólo se rehacen los actos vacíos: uno con quests ya es historia viva.
        const keep = campaign.actIds.filter((actId) => {
          const act = state.acts.find((candidate) => candidate.id === actId);
          return act ? act.questIds.length > 0 : false;
        });
        state.acts = state.acts.filter((act) => act.campaignId !== campaign.id || keep.includes(act.id));
        campaign.actIds = keep;
        if (keep.length + patch.initialActs.length > MAX_ACTS_PER_CAMPAIGN) {
          throw new Error(`Una campaña no sostiene más de ${MAX_ACTS_PER_CAMPAIGN} Actos.`);
        }
        for (const proposal of patch.initialActs) {
          const act = buildAct(campaign, proposal, timestamp);
          state.acts.unshift(act);
          campaign.actIds.push(act.id);
        }
      }

      campaign.updatedAt = timestamp;
      addEvent(state, {
        type: "campaign_revised",
        entityType: "campaign",
        entityId: campaign.id,
        message: `El pacto de «${campaign.title}» fue reformulado.`,
      });
      return { campaign, acts: state.acts.filter((act) => act.campaignId === campaign.id) };
    });
    return result;
  }

  /**
   * Sella el pacto. Aceptar una campaña NO inicia ninguna Battle ni cierra
   * ninguna otra campaña: sólo la incorpora a los frentes vivos del reino.
   */
  async acceptCampaign(campaignId: string, userAccepted: boolean): Promise<Campaign> {
    if (!userAccepted) throw new Error("La aceptación explícita del usuario es obligatoria.");
    const { result } = await this.store.mutate((state) => {
      const campaign = requireCampaign(state, campaignId);
      // Idempotente: reintentar un sello ya puesto no rompe nada.
      if (campaign.status === "active") return campaign;
      if (campaign.status !== "draft") throw new Error(`Esta campaña ya está ${campaign.status}.`);
      campaign.status = "active";
      campaign.acceptedAt = now();
      campaign.updatedAt = campaign.acceptedAt;
      state.focusedCampaignId ??= campaign.id;
      addEvent(state, {
        type: "campaign_accepted",
        entityType: "campaign",
        entityId: campaign.id,
        message: `El pacto de «${campaign.title}» ha sido sellado.`,
      });
      return campaign;
    });
    return result;
  }

  async createAct(input: {
    title: string;
    subtitle?: string;
    outcome?: string;
    campaignId?: string;
    scenario?: string;
    estimatedActiveMinutes?: number;
    /** Dependencias EXPLÍCITAS. Sin esto el Acto nace disponible, en paralelo. */
    dependsOnActIds?: string[];
  }): Promise<Act> {
    if (input.title.trim().length < 3) throw new Error("El acto necesita un título.");
    const { result } = await this.store.mutate((state) => {
      const campaign = input.campaignId ? requireCampaign(state, input.campaignId) : undefined;
      if (campaign && campaign.actIds.length >= MAX_ACTS_PER_CAMPAIGN) {
        throw new Error(`La campaña «${campaign.title}» ya sostiene ${MAX_ACTS_PER_CAMPAIGN} Actos: abre otra Campaña bajo una Saga.`);
      }
      const timestamp = now();
      const act = buildAct(campaign, input, timestamp);
      act.scenario = input.scenario?.trim().slice(0, 120);
      state.acts.unshift(act);
      if (campaign) {
        campaign.actIds.push(act.id);
        campaign.updatedAt = timestamp;
      }
      addEvent(state, { type: "act_created", entityType: "act", entityId: act.id, message: `Acto trazado: «${act.title}».` });
      return act;
    });
    return result;
  }

  /**
   * Vincula una quest YA EXISTENTE a una campaña y, si hace falta, a un acto.
   *
   * No la recrea: conserva su id, su estado, sus fechas, su evidencia y su
   * historial. Un `campaignTitle` coincidente NUNCA basta para inferir esto:
   * la relación autoritativa es por id y la declara alguien, no el azar.
   */
  async assignQuest(questId: string, target: { campaignId?: string; actId?: string }): Promise<{ quest: Quest; act: Act | null; campaign: Campaign | null }> {
    const { result } = await this.store.mutate((state) => {
      const quest = requireQuest(state, questId);
      const act = target.actId ? state.acts.find((candidate) => candidate.id === target.actId) ?? null : null;
      if (target.actId && !act) throw new Error(`Acto no encontrado: ${target.actId}`);
      const campaign = target.campaignId
        ? requireCampaign(state, target.campaignId)
        : act?.campaignId
          ? requireCampaign(state, act.campaignId)
          : null;
      if (act && campaign && act.campaignId && act.campaignId !== campaign.id) {
        throw new Error(`El acto «${act.title}» pertenece a otra campaña.`);
      }
      if (!act && !campaign) throw new Error("Indica al menos una campaña o un acto de destino.");
      if (act && act.questIds.length >= MAX_QUESTS_PER_ACT && !act.questIds.includes(questId)) {
        throw new Error(`El acto «${act.title}» ya sostiene ${MAX_QUESTS_PER_ACT} Battles: parte el trabajo en otro Acto.`);
      }

      const timestamp = now();
      // Idempotente: repetir la asignación no duplica la relación.
      const previous = quest.actId ? state.acts.find((candidate) => candidate.id === quest.actId) : undefined;
      if (previous && previous.id !== act?.id) previous.questIds = previous.questIds.filter((candidate) => candidate !== questId);
      if (act && !act.questIds.includes(questId)) act.questIds.push(questId);
      if (act) {
        act.updatedAt = timestamp;
        if (act.status === "available" || act.status === "locked") act.status = "active";
      }
      quest.actId = act?.id;
      quest.campaignId = campaign?.id ?? act?.campaignId;
      quest.sagaId = campaign?.sagaId ?? act?.sagaId;
      quest.updatedAt = timestamp;
      addEvent(state, {
        type: "quest_assigned",
        entityType: "quest",
        entityId: quest.id,
        questId: quest.id,
        message: act
          ? `«${quest.title}» pasa a formar parte del acto «${act.title}».`
          : `«${quest.title}» pasa a formar parte de la campaña «${campaign!.title}».`,
      });
      return { quest, act, campaign };
    });
    return result;
  }

  /** Compatibilidad: adoptar una quest dentro de un acto concreto. */
  async assignQuestToAct(questId: string, actId: string): Promise<{ quest: Quest; act: Act }> {
    const result = await this.assignQuest(questId, { actId });
    return { quest: result.quest, act: result.act! };
  }

  // -------------------------------------------------------------------------
  // FOCO / NAVEGACIÓN
  //
  // BACKLOG NO ES FOCO. FOCO NO ES COMPROMISO. COMPROMISO NO ES ACEPTACIÓN.
  // Estas herramientas sólo mueven la mirada: no aceptan, no inician y no
  // desactivan ninguna otra entidad.
  // -------------------------------------------------------------------------

  /** Cambia la Quest en foco. No la acepta ni la inicia. `null` suelta el foco. */
  async focusQuest(questId: string | null): Promise<RealmSnapshot> {
    await this.store.mutate((state) => {
      if (questId === null) {
        delete state.focusedQuestId;
        return null;
      }
      const quest = requireQuest(state, questId);
      if (state.focusedQuestId === quest.id) return quest;
      state.focusedQuestId = quest.id;
      addEvent(state, {
        type: "quest_focused",
        entityType: "quest",
        entityId: quest.id,
        questId: quest.id,
        message: `El reino mira ahora «${quest.title}». No se inició ninguna batalla.`,
      });
      return quest;
    });
    return this.snapshot();
  }

  /** Cambia el Acto en foco. Navegación pura: los demás Actos no se tocan. */
  async focusAct(actId: string | null): Promise<RealmSnapshot> {
    await this.store.mutate((state) => {
      if (actId === null) {
        delete state.focusedActId;
        return null;
      }
      const act = state.acts.find((candidate) => candidate.id === actId);
      if (!act) throw new Error(`Acto no encontrado: ${actId}`);
      if (state.focusedActId === act.id) return act;
      state.focusedActId = act.id;
      addEvent(state, {
        type: "act_focused",
        entityType: "act",
        entityId: act.id,
        message: `El reino mira ahora el acto «${act.title}». Los demás Actos siguen disponibles.`,
      });
      return act;
    });
    return this.snapshot();
  }

  /**
   * DRAFT LIFECYCLE.
   *
   * Un borrador NUNCA aceptado y sin evidencia validada puede borrarse de raíz.
   * Una Quest aceptada, iniciada o completada NO: para eso está `abandon_quest`,
   * y lo completado es inmutable.
   */
  async deleteQuestDraft(questId: string): Promise<{ deleted: true; questId: string }> {
    const { result } = await this.store.mutate((state) => {
      const quest = requireQuest(state, questId);
      if (quest.status !== "draft" || quest.acceptedAt) {
        throw new Error("Sólo un borrador nunca aceptado puede eliminarse. Usa abandon_quest para una Quest ya iniciada.");
      }
      const hasValidatedEvidence = state.evidence.some(
        (record) => record.questId === questId && record.impactAwarded > 0,
      );
      if (hasValidatedEvidence) {
        throw new Error("Este borrador tiene evidencia validada: es historia real y no se borra.");
      }
      state.quests = state.quests.filter((candidate) => candidate.id !== questId);
      for (const act of state.acts) {
        act.questIds = act.questIds.filter((candidate) => candidate !== questId);
      }
      // La historia real no se toca; un borrador sin aceptar no tiene historia:
      // se llevan sus hechos y sus avisos, que ya no apuntan a nada.
      state.events = state.events.filter((event) => event.entityId !== questId && event.questId !== questId);
      state.notifications = (state.notifications ?? []).filter((record) => record.entityId !== questId);
      state.artifacts = state.artifacts.filter((artifact) => artifact.questId !== questId);
      state.evidence = state.evidence.filter((record) => record.questId !== questId);
      if (state.focusedQuestId === questId) delete state.focusedQuestId;
      addEvent(state, {
        type: "quest_deleted",
        entityType: "quest",
        entityId: questId,
        questId,
        message: `Borrador eliminado: «${quest.title}».`,
      });
      // El propio hecho de borrado no merece notificación.
      state.notifications = (state.notifications ?? []).filter((record) => record.entityId !== questId);
      return { deleted: true as const, questId };
    });
    return result;
  }

  // -------------------------------------------------------------------------
  // CENTRO DE NOTIFICACIONES
  //
  // Push es entrega efímera; el registro es la verdad. `resend` sólo abre otro
  // intento de entrega: nunca recrea la Quest ni un segundo NotificationRecord.
  // -------------------------------------------------------------------------

  async getNotifications(query: NotificationQuery = {}): Promise<{ notifications: NotificationView[]; unread: number }> {
    const state = await this.tick();
    return { notifications: notificationViewsFor(state, query), unread: unreadCount(state) };
  }

  async markNotificationRead(notificationId: string): Promise<NotificationRecord> {
    const { result } = await this.store.mutate((state) => {
      const record = (state.notifications ?? []).find((candidate) => candidate.id === notificationId);
      if (!record) throw new Error(`Notificación no encontrada: ${notificationId}`);
      record.readAt ??= now();
      return record;
    });
    return result;
  }

  async archiveNotification(notificationId: string): Promise<NotificationRecord> {
    const { result } = await this.store.mutate((state) => {
      const record = (state.notifications ?? []).find((candidate) => candidate.id === notificationId);
      if (!record) throw new Error(`Notificación no encontrada: ${notificationId}`);
      record.archivedAt ??= now();
      record.readAt ??= now();
      return record;
    });
    return result;
  }

  /** Un intento de entrega NUEVO sobre el registro existente. Nada más. */
  async resendNotification(notificationId: string): Promise<NotificationRecord> {
    const { result } = await this.store.mutate((state) => {
      const record = (state.notifications ?? []).find((candidate) => candidate.id === notificationId);
      if (!record) throw new Error(`Notificación no encontrada: ${notificationId}`);
      attemptPush(record);
      return record;
    });
    return result;
  }

  /** Reenvía la última notificación de una entidad/tipo. No crea una nueva. */
  async resendEntityNotification(input: {
    entityType: NotificationEntityType;
    entityId: string;
    notificationType?: NotificationType;
  }): Promise<NotificationRecord> {
    const { result } = await this.store.mutate((state) => {
      const record = (state.notifications ?? []).find(
        (candidate) =>
          candidate.entityId === input.entityId &&
          candidate.entityType === input.entityType &&
          (input.notificationType ? candidate.type === input.notificationType : true),
      );
      if (!record) {
        throw new Error("No existe ninguna notificación para esa entidad. Reenviar no crea una nueva.");
      }
      attemptPush(record);
      return record;
    });
    return result;
  }

  // -------------------------------------------------------------------------
  // TESORERÍA VIVA
  //
  // Sólo hechos financieros reales cambian el dinero. Nunca `impact` como monto,
  // nunca monedas de juego por gastar dinero real.
  // -------------------------------------------------------------------------

  async createRecurringObligation(input: RecurringObligationInput): Promise<RecurringObligation> {
    if (input.name.trim().length < 2) throw new Error("La obligación necesita un nombre.");
    const { result } = await this.store.mutate((state) => {
      const obligation = buildRecurringObligation(input);
      state.recurringObligations.unshift(obligation);
      addEvent(state, {
        type: "recurring_obligation_created",
        entityType: "quest",
        entityId: obligation.id,
        message: `${obligation.direction === "income" ? "Ingreso" : "Gasto"} recurrente registrado: «${obligation.name}».`,
      });
      return obligation;
    });
    return result;
  }

  async updateRecurringObligation(
    obligationId: string,
    patch: Partial<Pick<RecurringObligation, "name" | "expectedAmount" | "provider" | "dueRule" | "frequency" | "category" | "active" | "autoProposeBattle">>,
  ): Promise<RecurringObligation> {
    const { result } = await this.store.mutate((state) => {
      const obligation = state.recurringObligations.find((candidate) => candidate.id === obligationId);
      if (!obligation) throw new Error(`Obligación no encontrada: ${obligationId}`);
      if (patch.name !== undefined) obligation.name = patch.name.trim().slice(0, 120);
      if (patch.expectedAmount !== undefined) {
        obligation.expectedAmount = patch.expectedAmount === null ? null : Math.max(0, Math.round(patch.expectedAmount));
      }
      if (patch.provider !== undefined) obligation.provider = patch.provider?.trim().slice(0, 120) || undefined;
      if (patch.category !== undefined) obligation.category = patch.category.trim().slice(0, 60);
      if (patch.frequency !== undefined) obligation.frequency = patch.frequency;
      if (patch.active !== undefined) obligation.active = patch.active;
      if (patch.autoProposeBattle !== undefined) obligation.autoProposeBattle = patch.autoProposeBattle;
      if (patch.dueRule !== undefined) obligation.dueRule = patch.dueRule;
      if (patch.dueRule !== undefined || patch.frequency !== undefined) {
        obligation.nextDueDate = advanceDueDate(obligation, new Date());
      }
      obligation.updatedAt = now();
      addEvent(state, {
        type: "recurring_obligation_updated",
        entityType: "quest",
        entityId: obligation.id,
        message: `Obligación actualizada: «${obligation.name}».`,
      });
      return obligation;
    });
    return result;
  }

  async getFinancialObligations(): Promise<{ obligations: ObligationView[]; treasury: TreasuryView }> {
    const state = await this.tick();
    return {
      obligations: state.recurringObligations.map((obligation) => obligationViewFor(obligation)),
      treasury: treasuryViewFor(state),
    };
  }

  /**
   * Registra un pago/ingreso VALIDADO. El monto es obligatorio y explícito:
   * nunca se deriva del `impact` de una Quest. Idempotente por evidencia: la
   * misma prueba no crea dos movimientos.
   */
  async recordFinancialTransaction(
    input: FinancialTransactionInput,
  ): Promise<{ transaction: FinancialTransaction; obligation: RecurringObligation | null; duplicate: boolean }> {
    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      throw new Error("El monto real es obligatorio y debe ser mayor que cero. No se infiere del impacto de la Quest.");
    }
    const { result } = await this.store.mutate((state) => {
      const obligation = input.recurringObligationId
        ? state.recurringObligations.find((candidate) => candidate.id === input.recurringObligationId) ?? null
        : null;
      if (input.recurringObligationId && !obligation) {
        throw new Error(`Obligación no encontrada: ${input.recurringObligationId}`);
      }

      const occurredAt = input.occurredAt ? new Date(input.occurredAt).toISOString() : now();
      const period = periodOf(occurredAt);

      // La misma evidencia —o el mismo pago ya conciliado— no entra dos veces.
      const amount = Math.max(0, Math.round(input.amount));
      const existing = state.financialTransactions.find(
        (candidate) =>
          candidate.period === period &&
          candidate.direction === input.direction &&
          ((input.evidenceArtifactId && candidate.evidenceArtifactId === input.evidenceArtifactId) ||
            (input.questId && candidate.questId === input.questId) ||
            (input.recurringObligationId &&
              candidate.recurringObligationId === input.recurringObligationId &&
              candidate.amount === amount)),
      );
      if (existing) {
        return { transaction: existing, obligation, duplicate: true };
      }

      const transaction = buildFinancialTransaction({ ...input, occurredAt });
      state.financialTransactions.unshift(transaction);
      state.financialTransactions = state.financialTransactions.slice(0, 500);

      // PERIOD RECONCILIATION: se marca pagado ESTE período, no «para siempre».
      if (obligation && transaction.status === "confirmed") {
        obligation.lastPaidPeriod = period;
        obligation.nextDueDate = advanceDueDate(obligation, new Date(occurredAt));
        obligation.updatedAt = now();
        // El aviso de «período pendiente» de esta obligación deja de pesar.
        markEntityNotificationsRead(state, obligation.id, "recurring_obligation_due");
      }

      // El dinero real se mueve en la Tesorería. Ninguna moneda de juego nace aquí.
      if (transaction.status === "confirmed") {
        if (transaction.direction === "expense") {
          state.financial.availableBalance = Math.max(0, state.financial.availableBalance - transaction.amount);
        } else {
          state.financial.availableBalance += transaction.amount;
        }
      }

      addEvent(state, {
        type: "financial_transaction_recorded",
        entityType: "quest",
        entityId: transaction.questId ?? obligation?.id ?? transaction.id,
        questId: transaction.questId,
        message: `${transaction.direction === "income" ? "Ingreso" : "Pago"} confirmado por ${transaction.amount.toLocaleString("es-CO")} COP${obligation ? ` (${obligation.name}, ${period})` : ""}.`,
      });
      return { transaction, obligation, duplicate: false };
    });
    return result;
  }

  async abandon(questId: string, reason: string): Promise<Quest> {
    const { result } = await this.store.mutate((state) => {
      const quest = requireQuest(state, questId);
      if (!["draft", "accepted", "active", "waiting_external"].includes(quest.status)) {
        throw new Error("Esta quest ya no puede abandonarse.");
      }
      quest.status = "abandoned";
      quest.abandonedAt = now();
      quest.updatedAt = quest.abandonedAt;
      if (state.focusedQuestId === quest.id) delete state.focusedQuestId;
      // Retirarse cierra el reloj: una quest abandonada ya no recibe ataques.
      if (quest.battle?.status === "active") {
        // Retirarse cierra el intento; no es un plazo vencido ni una caída.
        const attempt = quest.battle.attempts.find((candidate) => candidate.attempt === quest.battle!.attempt);
        resolveBattle(state, quest, quest.battle, "awaiting_replan", Date.now());
        if (attempt) attempt.endReason = "abandoned";
      }
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
