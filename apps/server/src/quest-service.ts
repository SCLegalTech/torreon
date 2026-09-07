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
  PlayerSheet,
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
  RecoveryOffer,
  RecurringObligation,
  RewardProfile,
  Saga,
  TreasuryView,
} from "./domain.js";
import {
  addNotification,
  archive,
  attemptPush,
  markRead,
  resend,
  resendForEntity,
  notificationViewsFor,
  notifyFromEvent,
  settleNotificationsFor,
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
  PARTY_ORDER,
  recoverFallen,
  recoveryHealth,
  refreshPartyDisplay,
  SHIELD_PER_VALIDATED_IMPACT,
} from "./party.js";
import {
  consistencyFor,
  currentStepFor,
  hierarchyFor,
  openFrontsFor,
  progressFor,
  questDetailFor,
  recoveryOfferFor,
  statsFor,
  worldSystemsFor,
} from "./read-models.js";
import {
  classifyScale,
  estimateActiveMinutes,
  MAX_ACTS_PER_CAMPAIGN,
  MAX_QUESTS_PER_ACT,
  type ScaleProposal,
} from "./scale.js";
import type { RealmStore } from "./realm-store.js";
import { RealmBus } from "./realm-bus.js";
import { dungeonMasterView, type DungeonMasterView } from "./v1-views.js";
import { invalidateEvent, type InvalidationInput, type InvalidationOutcome } from "./invalidation.js";
import { createCharacter, type CharacterInput } from "./character.js";
import { recordUnexpectedRequirement } from "./horde-pressure.js";
import { recoverParty } from "./party-flow.js";
import { DEFAULT_PLAYER_ID, type PlayerId } from "./players.js";
import {
  abandonCampaign,
  acceptCampaign,
  buildAct,
  campaignTitleFrom,
  closeParents,
  createAct,
  createSaga,
  requireCampaign,
  type ActInput,
  type SagaInput,
} from "./campaign-flow.js";
import { addEvent, markEntityNotificationsRead, pushGameEvent } from "./realm-events.js";
import { createObligation, obligationsView, recordTransaction, updateObligation, type ObligationPatch } from "./treasury-flow.js";
import { isoAt, systemClock, type Clock } from "./clock.js";
import { deny, notFound } from "./errors.js";

export { questFromIntent } from "./codice.js";

function requireQuest(state: RealmState, questId: string): Quest {
  const quest = state.quests.find((candidate) => candidate.id === questId);
  if (!quest) throw notFound(`Quest no encontrada: ${questId}`);
  return quest;
}

export function battleFor(quest: Quest | null, nowMs: number, _gameEvents: GameEvent[] = []): BattleState | null {
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
export function grantQuestRewards(state: RealmState, quest: Quest, nowMs: number): RewardGrant | null {
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

/** Concede XP y, si cruza umbral, emite `hero_level_up` UNA sola vez. */
function applyXp(state: RealmState, heroId: HeroId, amount: number, key: string, questId: string, nowMs: number): void {
  const grant = grantHeroXp(state, heroId, amount, key, isoAt(nowMs));
  if (!grant?.leveledUp) return;
  const timestamp = isoAt(nowMs);
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
  }, nowMs);
}

/**
 * EJECUCIÓN VISIBLE.
 *
 * Permite que la pantalla muestre «OPUS HA ENTRADO EN COMBATE» sin esperar al
 * cierre de la Quest. Deduplicada por `executionRef`: la misma ejecución real
 * no se registra dos veces, y una lectura de MCP no se convierte en push.
 */
function registerExecution(state: RealmState, assist: CompanionAssist, quest: Quest, nowMs: number): CompanionExecution {
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
function markAgentParticipation(state: RealmState, assist: CompanionAssist, quest: Quest, nowMs: number): void {
  const hero = ensureHero(state, assist.companion, isoAt(nowMs));
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
      }, nowMs);
    }
    hero.stats.executions += 1;
    hero.stats.successfulExecutions += 1;
    // Telemetría de uso: cuenta trabajo real, nunca mensajes ni prompts.
    rolloverUsage(state.usage, nowMs);
    state.usage.companionExecutions += 1;
    state.usage.companionSuccessfulExecutions += 1;
  }
  applyXp(state, assist.companion, XP_REWARDS.agentExecution, `execution:${assist.id}`, quest.id, nowMs);
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
    isoAt(nowMs),
  );
}

/**
 * Una contribución ACEPTADA. Aquí —y sólo aquí— el agente deja de ser un
 * nombre disponible y pasa a tener carrera: XP, maestría y hazaña verificada.
 */
function markAgentValidation(
  nowMs: number,
  state: RealmState,
  assist: CompanionAssist,
  quest: Quest,
  impactAwarded: number,
  evidenceId: string,
): void {
  const hero = ensureHero(state, assist.companion, isoAt(nowMs));
  if (claimOnce(state, `validated_assist:${assist.id}`)) {
    hero.stats.validatedAssists += 1;
    hero.stats.supportedImpact += impactAwarded;
    rolloverUsage(state.usage, nowMs);
    state.usage.companionValidatedAssists += 1;
  }
  applyXp(state, assist.companion, XP_REWARDS.agentValidatedAssist, `validated_assist:${assist.id}`, quest.id, nowMs);
  grantMastery(state, assist.companion, HERO_DEFAULT_MASTERY[assist.companion], `assist:${assist.id}`, isoAt(nowMs));
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
    isoAt(nowMs),
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
    createdAt: isoAt(nowMs),
  });
}

/** Carrera del grupo y de los agentes al cerrarse un contrato al 100%. */
function applyCareerProgression(state: RealmState, quest: Quest, timestamp: string, nowMs: number): void {
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
    applyXp(state, heroId, XP_REWARDS.questCompleted, `quest_completed:${quest.id}`, quest.id, nowMs);
    grantMastery(state, heroId, quest.rewardProfile?.masteryDomain, `quest:${quest.id}`, isoAt(nowMs));
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
      isoAt(nowMs),
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
      isoAt(nowMs),
    );
  }

  const campaign = quest.campaignId ? state.campaigns.find((candidate) => candidate.id === quest.campaignId) : undefined;
  if (campaign?.status === "completed") {
    for (const heroId of PARTY_HERO_IDS) {
      const hero = ensureHero(state, heroId, timestamp);
      if (claimOnce(state, `campaign_completed:${heroId}:${campaign.id}`)) hero.stats.campaignsCompleted += 1;
      applyXp(state, heroId, XP_REWARDS.campaignCompleted, `campaign_completed:${campaign.id}`, quest.id, nowMs);
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
function completeQuest(state: RealmState, quest: Quest, timestamp: string, nowMs: number): void {
  if (quest.status === "completed") return;
  quest.status = "completed";
  quest.completedAt = timestamp;
  quest.updatedAt = timestamp;
  // LOS AVISOS DE UNA BATTLE MUEREN CON LA BATTLE. Ganar el contrato jubila
  // todo lo que este frente tenía pendiente: el plazo vencido que se replanificó,
  // la espera externa que se desbloqueó, la enmienda que se aceptó. Nada de eso
  // sigue reclamando atención, y el jugador no tiene que cerrarlo a mano.
  settleNotificationsFor(state, quest.id, nowMs);

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

  closeParents(state, quest, nowMs);
  addEvent(state, { type: "quest_completed", questId: quest.id, message: `KO: «${quest.title}» fue completada.` }, nowMs);

  const reward = grantQuestRewards(state, quest, nowMs);
  if (reward) {
    const mastery = reward.masteryDomain ? ` +${reward.masteryPoints} ${reward.masteryDomain}` : "";
    addEvent(state, {
    type: "reward_granted",
    questId: quest.id,
    message: `El resultado validado concede +${reward.xp} XP +${reward.aura} Aura${mastery}.`,
    }, nowMs);
  }

  applyCareerProgression(state, quest, timestamp, nowMs);

  // MEMORIA DE BATALLA: el reino aprende cuánto duró de verdad este trabajo.
  const report = storeAfterActionReport(state, buildAfterActionReport(state, quest, nowMs));
  upsertPlaybook(state, quest, report);
  addEvent(state, {
  type: "after_action_report",
  entityType: "quest",
  entityId: quest.id,
  questId: quest.id,
  message: `Informe de acción de «${quest.title}»: ${Math.round(report.actualActiveMs / 60_000)} min activos frente a ${report.plannedDurationMinutes} pactados.`,
  }, nowMs);
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

/** El frente donde se puede actuar: el comprometido o el que espera auxilio. */
function engagedOrRecoverable(state: RealmState): Quest | null {
  return (
    state.quests.find((quest) => quest.battle?.status === "active") ??
    state.quests.find((quest) => quest.battle && ["awaiting_replan", "awaiting_recovery"].includes(quest.battle.status)) ??
    null
  );
}

function requireStep(quest: Quest, stepId: string): QuestStep {
  const step = quest.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw notFound(`Paso no encontrado: ${stepId}`);
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
      if (["completed", "superseded"].includes(step.status)) throw deny(`No se puede modificar el paso histórico «${step.title}».`);
      if (change.patch.weight !== undefined && change.patch.weight < step.impactAwarded) {
        throw deny(`El nuevo peso de «${step.title}» no puede ser menor que su impacto ya concedido (${step.impactAwarded}).`);
      }
      Object.assign(step, change.patch);
    } else if (change.type === "SUPERSEDE_STEP") {
      if (step.status === "completed") throw deny(`El paso completado «${step.title}» ya es historia validada y no puede sustituirse.`);
      step.status = "superseded";
      step.supersededAt = timestamp;
      step.supersededReason = change.reason.trim();
      // El impacto no adjudicado vuelve al contrato; el impacto histórico queda intacto.
      step.weight = step.impactAwarded;
    } else if (change.type === "MARK_EXTERNAL_BLOCKER") {
      if (["completed", "superseded"].includes(step.status)) throw deny(`El paso «${step.title}» ya no puede bloquearse.`);
      step.status = "blocked";
      step.blockedBy = change.blockedBy.trim();
      step.blockedReason = change.blockedReason.trim();
      step.blockedSince = timestamp;
      step.playerActionAvailable = change.playerActionAvailable;
      step.followUpAfter = change.followUpAfter;
    } else if (change.type === "UNBLOCK_STEP") {
      if (step.status !== "blocked") throw deny(`El paso «${step.title}» no está bloqueado.`);
      step.status = step.impactAwarded > 0 ? "in_progress" : "pending";
      delete step.blockedBy;
      delete step.blockedReason;
      delete step.blockedSince;
      delete step.playerActionAvailable;
      delete step.followUpAfter;
    }
  }

  const total = quest.steps.reduce((sum, step) => sum + step.weight, 0);
  if (total !== 100) throw deny(`Tras el amendment, el impacto total debe seguir siendo 100; actualmente suma ${total}. Redistribuye sólo el impacto restante.`);
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
    private readonly store: RealmStore,
    private readonly codice: CodicePlanner = new HeuristicCodice(),
    private readonly dataDir = "./data",
    /** Etiqueta legible de esta instancia: distingue el reino local del de la nube. */
    private readonly instance = process.env.TORREON_INSTANCE?.trim() || "torreon-local",
    /**
     * EL SERVIDOR ES AUTORIDAD DEL TIEMPO, y esta es esa autoridad.
     * El Núcleo no consulta el reloj de pared: lo recibe (artículo 8, ADR-0006).
     */
    private readonly clock: Clock = systemClock,
    /**
     * DE QUIÉN ES EL REINO QUE ESTE SERVICIO TOCA (artículo 10, ADR-0002).
     *
     * Un servicio sirve a UN jugador. Saber quién pregunta es la etapa 5: aquí
     * sólo se garantiza que todo lo que se lee y se escribe es de alguien.
     */
    private readonly playerId: PlayerId = DEFAULT_PLAYER_ID,
    /** Por dónde sale el aviso de que la verdad cambió. */
    readonly bus: RealmBus = new RealmBus(),
  ) {}

  /** Toda lectura y toda escritura llevan sujeto. No hay «el reino». */
  private read(): Promise<RealmState> {
    return this.store.read(this.playerId);
  }

  private async mutate<T>(mutation: (state: RealmState) => T | Promise<T>): Promise<{ result: T; state: RealmState }> {
    const outcome = await this.store.mutate(mutation, this.playerId);
    // La verdad cambió: quien escuche se entera ahora, no en el próximo sondeo.
    this.bus.publish(this.playerId, outcome.state);
    return outcome;
  }

  get codiceName(): string {
    return this.codice.name;
  }

  /** Etiqueta de esta instancia. Distingue el reino local del de la nube. */
  get instanceName(): string {
    return this.instance;
  }

  /** De quién es el reino que este servicio sirve. */
  get playerIdOfRealm(): PlayerId {
    return this.playerId;
  }

  /** El reloj autoritativo. El transporte lo usa para sellar `serverTime`. */
  get realmClock(): Clock {
    return this.clock;
  }

  /**
   * EL SERVIDOR ES AUTORIDAD DEL TIEMPO.
   *
   * Antes de responder a nadie —app, MCP o Unity— el Core cobra lo que el reloj
   * debía haber cobrado mientras la app estaba cerrada. Sólo escribe si de
   * verdad hay algo pendiente: leer el reino no puede ensuciar el archivo.
   */
  /** Público para que la capa de vistas pueda leer el reino ya al día. */
  async tick(): Promise<RealmState> {
    const state = await this.read();
    // El zurrón inicial se entrega UNA vez. Recargar o redesplegar no repite.
    if (!state.inventory.initializedAt) {
      const { state: stocked } = await this.mutate((draft) => {
        if (draft.inventory.initializedAt) return null;
        const timestamp = this.clock.iso();
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
      if (!needsAdvance(stocked, this.clock.now())) return stocked;
      const { state: advanced } = await this.mutate((draft) => advanceBattles(draft, this.clock.now()));
      return advanced;
    }
    if (!needsAdvance(state, this.clock.now())) return state;
    const { state: fresh } = await this.mutate((draft) => advanceBattles(draft, this.clock.now()));
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
    const battle = battleFor(battleQuest, this.clock.now(), realm.gameEvents);
    const hierarchy = hierarchyFor(realm, quest, engaged?.id ?? null);
    const openFronts = openFrontsFor(realm);
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
      notifications: notificationViewsFor(realm, this.clock.now()),
      unreadNotifications: unread,
      treasury: treasuryViewFor(realm, this.clock.now()),
      entitlements: realm.entitlements,
      usage: realm.usage,
      // 🛡️ BARRACAS y 💰 TESORERÍA son sistemas del MUNDO, no hijos de las
      // Batallas Libres: la jerarquía la fija el Core y el renderer la obedece.
      barracks: barracksViewFor(realm),
      worldSystems: worldSystemsFor(realm, {
        engagedQuest: engaged,
        quickBattles: hierarchy.standaloneQuests.length,
        openFronts: openFronts.length,
        activeCampaigns: hierarchy.activeCampaignIds.length,
        unreadNotifications: unread,
      }),
      // Toda Battle viva, con su id exacto: la ruta normal a un frente que
      // nació dentro de una Campaña y sólo asomaba por su notificación.
      openFronts,
      recovery: recoveryOfferFor(realm, battleQuest?.id ?? null),
      afterActionReport: quest
        ? (realm.afterActionReports ?? []).find((report) => report.questId === quest.id) ?? null
        : null,
      battleMemory: battleMemoryFor(realm),
    };
  }

  /** 🛡️ Barracas: el grupo y los agentes con la historia que de verdad tienen. */
  /**
   * EL REINO COMO LO NECESITA EL DUNGEON MASTER.
   *
   * Compacto y decidido: `activeBattle` responde «¿quedó activa?» sin que nadie
   * tenga que deducirlo de 426 KB de estado.
   */
  async dungeonMasterState(): Promise<DungeonMasterView> {
    const realm = await this.tick();
    const engaged = engagedQuest(realm);
    return dungeonMasterView(realm, this.clock.now(), {
      instance: this.instance,
      serverTime: this.clock.iso(),
      engagedQuest: engaged,
      battle: battleFor(battleQuestOf(realm), this.clock.now(), realm.gameEvents),
    });
  }

  /**
   * CREAR O RENOMBRAR LA FICHA.
   *
   * Los ids del grupo no cambian: sólo el nombre que se resuelve al leer, así
   * que renombrar no reescribe una línea de historia. Las Battles vivas se
   * refrescan aquí mismo para que el frente no siga llamando al personaje por
   * su nombre viejo.
   */
  async createCharacter(input: CharacterInput): Promise<PlayerSheet> {
    const { result } = await this.mutate((state) => {
      const sheet = createCharacter(state, input, this.clock.now());
      for (const quest of state.quests) {
        if (quest.battle) refreshPartyDisplay(quest.battle.party, sheet);
      }
      return sheet;
    });
    return result;
  }

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
    const { result } = await this.mutate((state) => {
      // Varias campañas pueden tener quests listas a la vez. Lo que no puede
      // duplicarse es la Battle comprometida, y eso lo defiende start().
      const act = parents.actId ? state.acts.find((candidate) => candidate.id === parents.actId) : undefined;
      if (parents.actId && !act) throw notFound(`Acto no encontrado: ${parents.actId}`);
      if (act && act.questIds.length >= MAX_QUESTS_PER_ACT) {
        throw deny(`El acto «${act.title}» ya sostiene ${MAX_QUESTS_PER_ACT} Battles: parte el trabajo en otro Acto.`);
      }
      // Una quest puede colgar directamente de la campaña, sin Acto intermedio.
      const campaign = parents.campaignId ? requireCampaign(state, parents.campaignId) : act?.campaignId ? requireCampaign(state, act.campaignId) : undefined;
      if (act && campaign && act.campaignId && act.campaignId !== campaign.id) {
        throw deny(`El acto «${act.title}» pertenece a otra campaña.`);
      }
      const timestamp = this.clock.iso();
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
      addEvent(state, { type: "quest_created", questId: quest.id, message: `El Códice redactó «${quest.title}».` }, this.clock.now());
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
    if (clean.length < 8) throw deny("Describe una quest con un poco más de detalle.");
    const realm = await this.read();
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
    const { result } = await this.mutate((state) => {
      const quest = requireQuest(state, questId);
      if (quest.status !== "draft") throw deny("Solo se puede reformular una quest en borrador.");
      Object.assign(quest, plan, {
        steps: plan.steps.map((step) => ({ ...step, id: randomUUID(), status: "pending" as const, impactAwarded: 0, evidenceIds: [], artifactIds: [] })),
        updatedAt: this.clock.iso(),
      });
      addEvent(state, { type: "quest_revised", questId, message: `El contrato de «${quest.title}» fue reformulado.` }, this.clock.now());
      return quest;
    });
    return result;
  }

  async accept(questId: string, userAccepted: boolean): Promise<Quest> {
    if (!userAccepted) throw deny("La aceptación explícita del usuario es obligatoria.");
    const { result } = await this.mutate((state) => {
      const quest = requireQuest(state, questId);
      if (quest.status !== "draft") throw deny("Solo se puede aceptar una quest en borrador.");
      quest.status = "accepted";
      quest.acceptedAt = this.clock.iso();
      quest.updatedAt = quest.acceptedAt;
      // El pacto ya está sellado: su aviso de «aguarda tu sello» deja de pesar.
      markEntityNotificationsRead(state, quest.id, "quest_created", this.clock.now());
      addEvent(state, { type: "quest_accepted", questId, message: `El marqués aceptó «${quest.title}».` }, this.clock.now());
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
    const { result } = await this.mutate((state) => {
      const quest = requireQuest(state, questId);
      if (quest.status !== "accepted") throw deny("La quest debe estar aceptada antes de comenzar.");
      // PREFLIGHT: NADIE ENTRA A UN FRENTE NUEVO DESDE EL SUELO.
      //
      // Una Battle nueva estrena grupo entero, así que aquí el caso real es
      // reabrir una que ya tiene registro con el Marqués caído: eso no es
      // empezar, es reintentar, y reintentar exige levantarlo primero.
      if (quest.battle && quest.battle.party.marques.health === 0) {
        throw deny(
          "El Marqués está KO en este frente. Levántalo con un Tónico de Retorno o retira al grupo a las Barracas antes de volver a entrar.",
        );
      }
      const engaged = engagedQuest(state);
      if (engaged && engaged.id !== questId) {
        throw deny(`Ya hay una Battle comprometida: «${engaged.title}». Termínala, o espera a que un bloqueo externo libere el frente, antes de iniciar otra.`);
      }
      // DAILY BATTLE LIMIT: sólo cuenta inicios iniciales. Un reintento, un
      // replan o un recontrato del mismo Quest NO consumen cupo. El plan `dev`
      // no tiene tope: `dailyBattleLimit` es null y esto no bloquea a nadie.
      rolloverUsage(state.usage, this.clock.now());
      const gate = battleStartAllowed(state.entitlements, state.usage);
      if (!gate.allowed) throw deny(gate.reason!);
      state.usage.battlesStartedToday += 1;
      const startedAtMs = this.clock.now();
      const duration = clampBattleMinutes(durationMinutes ?? quest.durationMinutes);
      quest.status = "active";
      quest.startedAt = new Date(startedAtMs).toISOString();
      quest.updatedAt = quest.startedAt;
      quest.battle = createBattleRecord(startedAtMs, duration, state.player);
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
      }, this.clock.now());
      // El grupo entró de verdad a un frente con reloj. Un reintento sobre la
      // misma Quest no vuelve a contar: la clave es el id de la Quest.
      for (const heroId of PARTY_HERO_IDS) {
        const hero = ensureHero(state, heroId, this.clock.iso());
        if (claimOnce(state, `battle_entered:${heroId}:${quest.id}`)) hero.stats.battlesEntered += 1;
        applyXp(state, heroId, XP_REWARDS.battleEntered, `battle_entered:${quest.id}`, quest.id, this.clock.now());
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
    const { result } = await this.mutate((state) => {
      const quest = requireQuest(state, questId);
      const record = quest.battle;
      if (!record) throw deny("Esta quest todavía no tiene Battle que reintentar.");
      if (record.status === "active") throw deny("La Battle sigue en curso.");
      if (record.status === "suspended_external") throw deny("Este frente espera a un tercero: se reanuda al desbloquearse, no se reintenta.");
      if (record.status === "won") throw deny("Esta Battle ya está ganada.");
      if (!["active", "waiting_external"].includes(quest.status)) throw deny("Esta quest ya no tiene frente abierto: no hay Battle que reintentar.");
      // EL MARQUÉS CAÍDO NO VUELVE GRATIS: hay que levantarlo primero.
      if (record.party.marques.health === 0) {
        throw deny("El Marqués sigue en el suelo. Levántalo con un Tónico de Retorno antes de abrir otro intento.");
      }
      const engaged = engagedQuest(state);
      if (engaged && engaged.id !== questId) {
        throw deny(`Ya hay una Battle comprometida: «${engaged.title}». No puedes sostener dos frentes con reloj a la vez.`);
      }
      const startedAtMs = this.clock.now();
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
      }, this.clock.now());
      return { quest, battle: battleFor(quest, this.clock.now(), state.gameEvents)! };
    });
    return result;
  }

  /**
   * RETIRADA TÁCTICA — LA ÚLTIMA RUTA LEGAL.
   *
   * UN JUGADOR PUEDE PERDER UNA BATALLA. NO PUEDE PERDER EL ACCESO AL JUEGO.
   *
   * El Marqués cae, el zurrón se queda sin Tónico y `retryBattle` —con razón—
   * se niega a levantarlo gratis. Sin esta salida el frente quedaba clavado
   * para siempre: un estado terminal involuntario que ninguna regla del juego
   * pidió. Retirarse cierra el intento y devuelve al grupo con el mínimo de
   * reentrada que declara el Core.
   *
   * LO QUE ESTO NO HACE, Y NO PUEDE HACER:
   *   - no concede progreso de Quest ni crea evidencia;
   *   - no cura a la Horda ni le quita el daño recibido;
   *   - no devuelve consumibles gastados;
   *   - no borra heridas, historial ni intentos anteriores;
   *   - no revive dentro del intento: el intento se cierra como `withdrawn`.
   */
  async recoverParty(questId: string): Promise<{ battle: BattleState; raised: PartyMemberId[]; minHealth: number }> {
    // Primero se liquida el tiempo pendiente: si el plazo venció mientras la
    // app estaba cerrada, la salida legal depende del estado YA resuelto, no
    // del que quedó escrito antes de que la Horda cobrara lo suyo.
    await this.tick();
    const { result } = await this.mutate((state) => {
      const outcome = recoverParty(state, questId, this.clock.now());
      const quest = requireQuest(state, questId);
      return { battle: battleFor(quest, this.clock.now(), state.gameEvents)!, raised: outcome.raised, minHealth: outcome.minHealth };
    });
    return result;
  }

  /** Lo que el Core concedería fuera de Battle, sin conceder nada todavía. */
  async recoveryOffer(questId: string): Promise<RecoveryOffer> {
    return recoveryOfferFor(await this.tick(), questId);
  }

  /**
   * Códice propone repactar el tiempo cuando la realidad exige más.
   *
   * No es una derrota: el intento se cierra como `recontracted`, no como
   * timeout, y no se emite `battle_lost`. El nuevo intento sigue sin poder
   * pasar de 60 minutos: 55 + 30 no son 85.
   */
  async proposeBattleRecontract(questId: string, input: { reason: string; newDurationMinutes: number }): Promise<BattleState> {
    if (input.reason.trim().length < 10) throw deny("Explica qué cambió en la realidad antes de repactar el tiempo.");
    const { result } = await this.mutate((state) => {
      const quest = requireQuest(state, questId);
      const record = quest.battle;
      if (!record) throw deny("Esta quest todavía no tiene Battle.");
      if (record.status !== "active") throw deny("Sólo una Battle en curso puede repactar su tiempo.");
      // Proponer otra vez sustituye la anterior: sólo hay un pacto sobre la mesa.
      record.pendingRecontract = {
        id: randomUUID(),
        reason: input.reason.trim(),
        newDurationMinutes: clampBattleMinutes(input.newDurationMinutes),
        proposedAt: this.clock.iso(),
      };
      quest.updatedAt = record.pendingRecontract.proposedAt;
      addEvent(state, {
      type: "quest_amendment_proposed",
      questId,
      message: `Códice propone repactar el tiempo de «${quest.title}» a ${record.pendingRecontract.newDurationMinutes} min: ${record.pendingRecontract.reason}`,
      }, this.clock.now());
      return battleFor(quest, this.clock.now(), state.gameEvents)!;
    });
    return result;
  }

  async acceptBattleRecontract(questId: string, recontractId: string, userAccepted: boolean): Promise<BattleState> {
    if (!userAccepted) throw deny("Repactar el tiempo requiere aceptación explícita del jugador.");
    const { result } = await this.mutate((state) => {
      const quest = requireQuest(state, questId);
      const record = quest.battle;
      if (!record?.pendingRecontract) throw deny("No hay ningún nuevo pacto temporal esperando decisión.");
      const proposal = record.pendingRecontract;
      // Se sella una propuesta concreta: si Códice propuso 30 min y luego 15,
      // el jugador tiene que estar aceptando exactamente la que está mirando.
      if (proposal.id !== recontractId) {
        throw deny(`Ese pacto ya no está sobre la mesa. El vigente propone ${proposal.newDurationMinutes} min: acéptalo por su propio id.`);
      }
      // Todo el estado de combate se preserva: sólo cambia el reloj.
      openAttempt(record, this.clock.now(), proposal.newDurationMinutes, "recontracted");
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
      }, this.clock.now());
      return battleFor(quest, this.clock.now(), state.gameEvents)!;
    });
    return result;
  }

  /**
   * Usa un objeto del zurrón. El Core valida y decrementa; el renderer no.
   *
   * EL FRENTE SE NOMBRA, NO SE ADIVINA. Con dos Battles esperando auxilio,
   * `engagedOrRecoverable` elegía la primera del archivo: el jugador gastaba su
   * único Tónico en la pantalla de Bigle y levantaba a otro Marqués. Cuando el
   * cliente dice sobre qué frente actúa, es ese y no otro.
   */
  async useInventoryItem(
    itemId: InventoryItemId,
    target: PartyMemberId,
    questId?: string,
  ): Promise<{ battle: BattleState | null; remaining: number; message: string }> {
    const { result } = await this.mutate((state) => {
      const quest = questId ? requireQuest(state, questId) : engagedOrRecoverable(state);
      if (!quest?.battle) throw deny("No hay ningún frente abierto donde usar objetos.");
      if (quest.battle.status === "won") throw deny("Esta Battle ya está ganada: no hay a quién curar.");
      const applied = useItem(state.inventory, quest.battle.party, itemId, target);
      const timestamp = this.clock.iso();
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
      }, this.clock.now());
      return {
        battle: battleFor(quest, this.clock.now(), state.gameEvents),
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
    if (input.contributionSummary.trim().length < 5) throw deny("Describe qué hizo realmente el compañero.");
    const { result } = await this.mutate((state) => {
      const quest = requireQuest(state, input.questId);
      requireStep(quest, input.stepId);
      const timestamp = this.clock.iso();
      const key = assistKeyFor(input);
      const existing = findExistingAssist(state.companionAssists ?? [], key, Boolean(input.executionRef?.trim()), this.clock.now());
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
      registerExecution(state, assist, quest, this.clock.now());
      markAgentParticipation(state, assist, quest, this.clock.now());

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
    const { state } = await this.mutate((draft) => {
      ensureRoster(draft, this.clock.iso());
      const hero = ensureHero(draft, heroId, this.clock.iso());
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
    const { result } = await this.mutate((state) => {
      const quest = requireQuest(state, questId);
      if (quest.status !== "active") throw deny("La quest debe estar activa para evaluar evidencia.");
      if (quest.battle && ["awaiting_replan", "awaiting_recovery"].includes(quest.battle.status)) {
        throw deny("Este intento se cerró. Replanifica el tiempo —y levanta al Marqués si cayó— antes de entregar más evidencia.");
      }
      const step = quest.steps.find((candidate) => candidate.id === stepId);
      if (!step) throw notFound(`Paso no encontrado: ${stepId}`);
      if (step.status === "completed") throw deny("Este paso ya recibió todo su impacto.");
      if (step.status === "blocked") throw deny("Este frente está bloqueado; no hay evidencia que entregar hasta resolver la dependencia.");
      if (step.status === "superseded") throw deny("Este paso fue sustituido por un amendment y ya no exige acción.");
      if (!input.summary.trim()) throw deny("Describe brevemente la evidencia aportada.");
      if (!input.reasoning.trim()) throw deny("Códice debe explicar el veredicto.");
      const remaining = step.weight - step.impactAwarded;
      if (!Number.isInteger(input.impactAwarded) || input.impactAwarded < 0 || input.impactAwarded > remaining) {
        throw deny(`El impacto debe ser un entero entre 0 y ${remaining}.`);
      }
      if (input.verdict === "rejected" && input.impactAwarded !== 0) {
        throw deny("La evidencia rechazada no puede causar daño.");
      }
      if (input.verdict === "partial" && (input.impactAwarded <= 0 || input.impactAwarded >= remaining)) {
        throw deny("La evidencia parcial debe conceder parte, pero no todo, del impacto restante.");
      }
      if (input.verdict === "accepted" && input.impactAwarded !== remaining) {
        throw deny("La evidencia aceptada debe conceder todo el impacto restante.");
      }

      const timestamp = this.clock.iso();

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
        const already = findExistingAssist(state.companionAssists ?? [], key, Boolean(input.executionRef?.trim()), this.clock.now());
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
          registerExecution(state, assist, quest, this.clock.now());
          markAgentParticipation(state, assist, quest, this.clock.now());
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
              markAgentValidation(this.clock.now(), state, assist, quest, input.impactAwarded, evidenceId);
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
            }, this.clock.now());
          }
        }
      }
      addEvent(state, {
      type: "step_completed",
      questId,
      message: input.impactAwarded > 0 ? `${step.title}: impacto validado de ${input.impactAwarded} puntos.` : `${step.title}: evidencia rechazada; sin impacto.`,
      }, this.clock.now());
      let battle = battleFor(quest, this.clock.now(), state.gameEvents)!;
      if (battle.isKo) {
        // TODO EN LA MISMA MUTACIÓN: nada de proyecciones a medias.
        completeQuest(state, quest, this.clock.iso(), this.clock.now());
        battle = battleFor(quest, this.clock.now(), state.gameEvents)!;
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
    const state = await this.read();
    const quest = requireQuest(state, questId);
    if (["completed", "abandoned"].includes(quest.status)) {
      throw deny("Esta quest ya no admite evidencia.");
    }
    if (!quest.steps.some((step) => step.id === stepId)) throw notFound(`Paso no encontrado: ${stepId}`);

    const artifact = await ingestArtifact(this.clock.now(), input, questId, stepId, this.dataDir);

    const { result } = await this.mutate((fresh) => {
      const freshQuest = requireQuest(fresh, questId);
      const step = freshQuest.steps.find((candidate) => candidate.id === stepId);
      if (!step) throw notFound(`Paso no encontrado: ${stepId}`);
      fresh.artifacts.unshift(artifact);
      fresh.artifacts = fresh.artifacts.slice(0, 200);
      step.artifactIds.push(artifact.id);
      freshQuest.updatedAt = this.clock.iso();
      addEvent(fresh, {
      type: "evidence_attached",
      questId,
      message: `${step.title}: llegó ${artifact.label}${artifact.verification.verified ? " (comprobado)" : " (sin comprobar)"}.`,
      }, this.clock.now());
      return artifact;
    });
    return result;
  }

  /**
   * Registra un artefacto que el Dungeon Master examinó donde vive el archivo.
   * Permite jugar sin tocar el teléfono: la prueba nunca pasa por el juego.
   */
  async attestArtifact(questId: string, stepId: string, input: WitnessInput): Promise<EvidenceArtifact> {
    const { result } = await this.mutate((state) => {
      const quest = requireQuest(state, questId);
      if (["completed", "abandoned"].includes(quest.status)) {
        throw deny("Esta quest ya no admite evidencia.");
      }
      const step = quest.steps.find((candidate) => candidate.id === stepId);
      if (!step) throw notFound(`Paso no encontrado: ${stepId}`);

      const artifact = witnessArtifact(input, questId, stepId, this.clock.now());
      state.artifacts.unshift(artifact);
      state.artifacts = state.artifacts.slice(0, 200);
      step.artifactIds.push(artifact.id);
      quest.updatedAt = this.clock.iso();
      addEvent(state, {
      type: "evidence_attached",
      questId,
      message: `${step.title}: ${artifact.verification.witness} examinó ${artifact.label}.`,
      }, this.clock.now());
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

    const state = await this.read();
    const quest = requireQuest(state, questId);
    if (quest.status !== "active") throw deny("La quest debe estar activa para evaluar evidencia.");
    const step: QuestStep | undefined = quest.steps.find((candidate) => candidate.id === stepId);
    if (!step) throw notFound(`Paso no encontrado: ${stepId}`);
    if (step.status === "completed") throw deny("Este paso ya recibió todo su impacto.");

    const wanted = input.artifactIds?.length ? new Set(input.artifactIds) : new Set(step.artifactIds);
    const artifacts = state.artifacts.filter((artifact) => artifact.questId === questId && artifact.stepIds.includes(stepId) && wanted.has(artifact.id));
    const note = (input.note ?? "").trim();
    if (!note && artifacts.length === 0) {
      throw deny("Entrega un artefacto o describe la evidencia antes de pedir el veredicto.");
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
    if (!step) throw notFound(`Paso no encontrado: ${stepId}`);
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
    if (input.reason.trim().length < 10) throw deny("Explica qué cambió en la realidad antes de proponer el amendment.");
    if (input.changes.length === 0) throw deny("El amendment debe proponer al menos un cambio.");

    const { result } = await this.mutate((state) => {
      const quest = requireQuest(state, questId);
      if (!["active", "waiting_external"].includes(quest.status)) throw deny("Sólo una quest iniciada puede recibir un amendment.");
      if (quest.amendments.some((candidate) => candidate.status === "proposed")) throw deny("Ya existe un amendment esperando decisión del jugador.");

      // Validar sobre una copia garantiza que la propuesta aceptada será aplicable,
      // sin tocar todavía el contrato ni el impacto histórico.
      const preview = structuredClone(quest);
      applyAmendmentChanges(preview, input.changes, this.clock.iso());

      const amendment: QuestAmendment = {
        id: randomUUID(),
        status: "proposed",
        reason: input.reason.trim(),
        proposedBy: input.proposedBy.trim() || "codice",
        previousVersion: quest.version,
        newVersion: quest.version + 1,
        changes: input.changes,
        createdAt: this.clock.iso(),
      };
      quest.amendments.unshift(amendment);
      quest.updatedAt = amendment.createdAt;
      addEvent(state, { type: "quest_amendment_proposed", questId, message: `Códice propone adaptar «${quest.title}»: ${amendment.reason}` }, this.clock.now());
      return amendment;
    });
    return result;
  }

  async acceptAmendment(questId: string, amendmentId: string, userAccepted: boolean): Promise<{ quest: Quest; amendment: QuestAmendment; battle: BattleState }> {
    if (!userAccepted) throw deny("Los cambios materiales requieren aceptación explícita del jugador.");
    const { result } = await this.mutate((state) => {
      const quest = requireQuest(state, questId);
      const amendment = quest.amendments.find((candidate) => candidate.id === amendmentId);
      if (!amendment) throw notFound(`Amendment no encontrado: ${amendmentId}`);
      if (amendment.status !== "proposed") throw deny("Este amendment ya fue resuelto.");

      const historicalImpact = quest.steps.reduce((sum, step) => sum + step.impactAwarded, 0);
      const previousStatus = quest.status;
      const timestamp = this.clock.iso();
      applyAmendmentChanges(quest, amendment.changes, timestamp);
      const preservedImpact = quest.steps.reduce((sum, step) => sum + step.impactAwarded, 0);
      if (preservedImpact !== historicalImpact) throw deny("El amendment intentó alterar impacto histórico.");

      amendment.status = "accepted";
      amendment.acceptedAt = timestamp;
      quest.version = amendment.newVersion;
      quest.updatedAt = timestamp;
      const next = reconcileExternalWaiting(quest);
      addEvent(state, { type: "quest_amended", questId, message: `El campo de batalla cambió: «${quest.title}» ahora está en v${quest.version}.` }, this.clock.now());
      if (next === "waiting") {
        addEvent(state, { type: "quest_waiting_external", questId, message: `«${quest.title}» espera una condición externa. No hay acción requerida del Marqués.` }, this.clock.now());
      } else if (previousStatus === "waiting_external") {
        addEvent(state, { type: "quest_unblocked", questId, message: `El sello externo cedió: «${quest.title}» vuelve a estar activa.` }, this.clock.now());
      }
      return { quest, amendment, battle: battleFor(quest, this.clock.now(), state.gameEvents)! };
    });
    return result;
  }

  async reuseArtifact(questId: string, artifactId: string, targetStepId: string): Promise<EvidenceArtifact> {
    const { result } = await this.mutate((state) => {
      const quest = requireQuest(state, questId);
      const step = requireStep(quest, targetStepId);
      const artifact = state.artifacts.find((candidate) => candidate.id === artifactId && candidate.questId === questId);
      if (!artifact) throw notFound(`Artefacto no encontrado en esta quest: ${artifactId}`);
      if (!artifact.stepIds.includes(targetStepId)) artifact.stepIds.push(targetStepId);
      if (!step.artifactIds.includes(artifactId)) step.artifactIds.push(artifactId);
      quest.updatedAt = this.clock.iso();
      addEvent(state, { type: "evidence_attached", questId, message: `${artifact.label} también queda disponible para «${step.title}», sin duplicar bytes.` }, this.clock.now());
      return artifact;
    });
    return result;
  }

  /** La Horda sólo golpea por una exigencia real (`horde-pressure.ts`). */
  async recordUnexpectedRequirement(
    questId: string,
    input: { reason: string; damage: number; stepId?: string },
  ): Promise<{ battle: BattleState; lifeEventId: string; gameEventId: string }> {
    const { result, state } = await this.mutate((draft) => recordUnexpectedRequirement(draft, questId, input, this.clock.now()));
    const quest = requireQuest(state, questId);
    return { battle: battleFor(quest, this.clock.now(), state.gameEvents)!, lifeEventId: result.lifeEventId, gameEventId: result.gameEventId };
  }

  /** Anular no es borrar. Las reglas viven en `invalidation.ts` (artículo 9). */
  async invalidateEvent(input: InvalidationInput): Promise<InvalidationOutcome> {
    const { result } = await this.mutate((state) => invalidateEvent(state, input, this.clock.now()));
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
    await this.mutate((state) => {
      if (campaignId === null) {
        delete state.focusedCampaignId;
        return null;
      }
      const campaign = requireCampaign(state, campaignId);
      if (campaign.status === "draft") throw deny("Sella el pacto antes de poner esta campaña en foco.");
      // Idempotente: enfocar dos veces no genera dos hechos.
      if (state.focusedCampaignId === campaign.id) return campaign;
      state.focusedCampaignId = campaign.id;
      addEvent(state, {
      type: "campaign_focused",
      entityType: "campaign",
      entityId: campaign.id,
      message: `El reino mira ahora «${campaign.title}». Los demás frentes siguen abiertos.`,
      }, this.clock.now());
      return campaign;
    });
    return this.snapshot();
  }

  // -------------------------------------------------------------------------
  // SAGA, CAMPAÑA, ACTO — las reglas viven en `campaign-flow.ts` (artículo 9).
  // -------------------------------------------------------------------------

  async createSaga(input: SagaInput): Promise<Saga> {
    const { result } = await this.mutate((state) => createSaga(state, input, this.clock.now()));
    return result;
  }

  async acceptCampaign(campaignId: string, userAccepted: boolean): Promise<Campaign> {
    const { result } = await this.mutate((state) => acceptCampaign(state, campaignId, userAccepted, this.clock.now()));
    return result;
  }

  async abandonCampaign(campaignId: string, reason: string): Promise<Campaign> {
    const { result } = await this.mutate((state) => abandonCampaign(state, campaignId, reason, this.clock.now()));
    return result;
  }

  async createAct(input: ActInput): Promise<Act> {
    const { result } = await this.mutate((state) => createAct(state, input, this.clock.now()));
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
    if (input.title.trim().length < 3) throw deny("La campaña necesita un título.");
    const { result } = await this.mutate((state) => {
      const saga = input.sagaId ? state.sagas.find((candidate) => candidate.id === input.sagaId) : undefined;
      if (input.sagaId && !saga) throw notFound(`Saga no encontrada: ${input.sagaId}`);
      const timestamp = this.clock.iso();
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

      }, this.clock.now());
      for (const act of acts) {
        addEvent(state, { type: "act_created", entityType: "act", entityId: act.id, message: `Acto trazado: «${act.title}».` }, this.clock.now());
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
    if (intent.length < 8) throw deny("Describe el objetivo con un poco más de detalle.");
    const fronts = (input.fronts ?? []).map((front) => front.trim()).filter(Boolean).slice(0, MAX_ACTS_PER_CAMPAIGN);
    const proposal = this.classifyObjective(intent, { activeMinutes: input.activeMinutes, naturalCampaigns: 1 });
    if (proposal.scale === "quest") {
      throw deny(
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
    const { result } = await this.mutate((state) => {
      const campaign = requireCampaign(state, campaignId);
      if (campaign.status !== "draft") throw deny("Sólo se puede reformular una campaña en borrador.");
      const timestamp = this.clock.iso();
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
          throw deny(`Una campaña no sostiene más de ${MAX_ACTS_PER_CAMPAIGN} Actos.`);
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
      }, this.clock.now());
      return { campaign, acts: state.acts.filter((act) => act.campaignId === campaign.id) };
    });
    return result;
  }

  /**
   * Sella el pacto. Aceptar una campaña NO inicia ninguna Battle ni cierra
   * ninguna otra campaña: sólo la incorpora a los frentes vivos del reino.
   */
  /**
   * Vincula una quest YA EXISTENTE a una campaña y, si hace falta, a un acto.
   *
   * No la recrea: conserva su id, su estado, sus fechas, su evidencia y su
   * historial. Un `campaignTitle` coincidente NUNCA basta para inferir esto:
   * la relación autoritativa es por id y la declara alguien, no el azar.
   */
  async assignQuest(questId: string, target: { campaignId?: string; actId?: string }): Promise<{ quest: Quest; act: Act | null; campaign: Campaign | null }> {
    const { result } = await this.mutate((state) => {
      const quest = requireQuest(state, questId);
      const act = target.actId ? state.acts.find((candidate) => candidate.id === target.actId) ?? null : null;
      if (target.actId && !act) throw notFound(`Acto no encontrado: ${target.actId}`);
      const campaign = target.campaignId
        ? requireCampaign(state, target.campaignId)
        : act?.campaignId
          ? requireCampaign(state, act.campaignId)
          : null;
      if (act && campaign && act.campaignId && act.campaignId !== campaign.id) {
        throw deny(`El acto «${act.title}» pertenece a otra campaña.`);
      }
      if (!act && !campaign) throw deny("Indica al menos una campaña o un acto de destino.");
      if (act && act.questIds.length >= MAX_QUESTS_PER_ACT && !act.questIds.includes(questId)) {
        throw deny(`El acto «${act.title}» ya sostiene ${MAX_QUESTS_PER_ACT} Battles: parte el trabajo en otro Acto.`);
      }

      const timestamp = this.clock.iso();
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
      }, this.clock.now());
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
    await this.mutate((state) => {
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
      }, this.clock.now());
      return quest;
    });
    return this.snapshot();
  }

  /** Cambia el Acto en foco. Navegación pura: los demás Actos no se tocan. */
  async focusAct(actId: string | null): Promise<RealmSnapshot> {
    await this.mutate((state) => {
      if (actId === null) {
        delete state.focusedActId;
        return null;
      }
      const act = state.acts.find((candidate) => candidate.id === actId);
      if (!act) throw notFound(`Acto no encontrado: ${actId}`);
      if (state.focusedActId === act.id) return act;
      state.focusedActId = act.id;
      addEvent(state, {
      type: "act_focused",
      entityType: "act",
      entityId: act.id,
      message: `El reino mira ahora el acto «${act.title}». Los demás Actos siguen disponibles.`,
      }, this.clock.now());
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
    const { result } = await this.mutate((state) => {
      const quest = requireQuest(state, questId);
      if (quest.status !== "draft" || quest.acceptedAt) {
        throw deny("Sólo un borrador nunca aceptado puede eliminarse. Usa abandon_quest para una Quest ya iniciada.");
      }
      const hasValidatedEvidence = state.evidence.some(
        (record) => record.questId === questId && record.impactAwarded > 0,
      );
      if (hasValidatedEvidence) {
        throw deny("Este borrador tiene evidencia validada: es historia real y no se borra.");
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
      }, this.clock.now());
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
    return { notifications: notificationViewsFor(state, this.clock.now(), query), unread: unreadCount(state) };
  }

  async markNotificationRead(notificationId: string): Promise<NotificationRecord> {
    const { result } = await this.mutate((state) => markRead(state, notificationId, this.clock.now()));
    return result;
  }

  async archiveNotification(notificationId: string): Promise<NotificationRecord> {
    const { result } = await this.mutate((state) => archive(state, notificationId, this.clock.now()));
    return result;
  }

  async resendNotification(notificationId: string): Promise<NotificationRecord> {
    const { result } = await this.mutate((state) => resend(state, notificationId, this.clock.now()));
    return result;
  }

  async resendEntityNotification(input: {
    entityType: NotificationEntityType;
    entityId: string;
    notificationType?: NotificationType;
  }): Promise<NotificationRecord> {
    const { result } = await this.mutate((state) => resendForEntity(state, input, this.clock.now()));
    return result;
  }

  // -------------------------------------------------------------------------
  // TESORERÍA VIVA — las reglas viven en `treasury-flow.ts`.
  //
  // Aquí sólo queda la transacción: abrir la mutación y dejar que el flujo
  // decida. Sólo hechos financieros reales cambian el dinero (artículo 9).
  // -------------------------------------------------------------------------

  async createRecurringObligation(input: RecurringObligationInput): Promise<RecurringObligation> {
    const { result } = await this.mutate((state) => createObligation(state, input, this.clock.now()));
    return result;
  }

  async updateRecurringObligation(obligationId: string, patch: ObligationPatch): Promise<RecurringObligation> {
    const { result } = await this.mutate((state) => updateObligation(state, obligationId, patch, this.clock.now()));
    return result;
  }

  async getFinancialObligations(): Promise<{ obligations: ObligationView[]; treasury: TreasuryView }> {
    return obligationsView(await this.tick(), this.clock.now());
  }

  async recordFinancialTransaction(
    input: FinancialTransactionInput,
  ): Promise<{ transaction: FinancialTransaction; obligation: RecurringObligation | null; duplicate: boolean }> {
    const { result } = await this.mutate((state) => recordTransaction(state, input, this.clock.now()));
    return result;
  }

  /**
   * DESCARTAR UNA MISIÓN — el otro lado de JUGAR.
   *
   * No toda oportunidad que el reino detecta hay que jugarla. Torreón no puede
   * obligar a sostener una misión abierta sólo porque alguna vez fue creada.
   *
   * Escoge la vía honesta según lo que esa misión YA sea:
   *
   *   - Un borrador nunca sellado y sin evidencia validada no tiene historia
   *     que proteger: se borra de raíz y se lleva sus avisos.
   *   - Cualquier otra cosa —sellada, iniciada, con evidencia— SÍ tiene
   *     historia: se abandona. El registro se queda, el intento queda cerrado
   *     con su motivo, y deja de aparecer entre lo pendiente.
   *
   * Lo completado no se descarta: eso ya no pide nada.
   */
  async discardQuest(questId: string, reason: string): Promise<{ questId: string; title: string; outcome: "deleted" | "abandoned" }> {
    const state = await this.tick();
    const quest = state.quests.find((candidate) => candidate.id === questId);
    if (!quest) throw notFound(`Quest no encontrada: ${questId}`);
    if (quest.status === "completed") throw deny("Esta Quest ya está completada: su historia no se descarta.");
    if (quest.status === "abandoned") return { questId, title: quest.title, outcome: "abandoned" };

    const pristineDraft =
      quest.status === "draft" &&
      !quest.acceptedAt &&
      !state.evidence.some((record) => record.questId === questId && record.impactAwarded > 0);

    if (pristineDraft) {
      await this.deleteQuestDraft(questId);
      return { questId, title: quest.title, outcome: "deleted" };
    }
    const abandoned = await this.abandon(questId, reason || "Descartada por el jugador.");
    return { questId, title: abandoned.title, outcome: "abandoned" };
  }

  async abandon(questId: string, reason: string): Promise<Quest> {
    const { result } = await this.mutate((state) => {
      const quest = requireQuest(state, questId);
      if (!["draft", "accepted", "active", "waiting_external"].includes(quest.status)) {
        throw deny("Esta quest ya no puede abandonarse.");
      }
      quest.status = "abandoned";
      quest.abandonedAt = this.clock.iso();
      quest.updatedAt = quest.abandonedAt;
      if (state.focusedQuestId === quest.id) delete state.focusedQuestId;
      // Retirarse cierra el reloj: una quest abandonada ya no recibe ataques.
      if (quest.battle?.status === "active") {
        // Retirarse cierra el intento; no es un plazo vencido ni una caída.
        const attempt = quest.battle.attempts.find((candidate) => candidate.attempt === quest.battle!.attempt);
        resolveBattle(state, quest, quest.battle, "awaiting_replan", this.clock.now());
        if (attempt) attempt.endReason = "abandoned";
      }
      // Descartar una misión la saca de los asuntos pendientes DE VERDAD:
      // con sus avisos dentro, no sólo con su tarjeta fuera de la lista.
      settleNotificationsFor(state, quest.id, this.clock.now());
      addEvent(state, { type: "quest_abandoned", questId, message: `Retirada: ${reason.trim() || "sin motivo registrado"}.` }, this.clock.now());
      return quest;
    });
    return result;
  }

  async reset(): Promise<RealmSnapshot> {
    await this.store.reset(this.playerId);
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
