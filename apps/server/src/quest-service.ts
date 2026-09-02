import { randomUUID } from "node:crypto";
import { ingestArtifact, witnessArtifact, type ArtifactInput, type WitnessInput } from "./artifacts.js";
import { advanceBattles, battleClock, clampBattleMinutes, createBattleRecord, needsAdvance, resolve as resolveBattle } from "./battle.js";
import { HeuristicCodice, questFromIntent, validatePlan, type CodicePlanner, type Judgement } from "./codice.js";
import type {
  Act,
  BattleState,
  Campaign,
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
  RewardProfile,
  Saga,
} from "./domain.js";
import {
  applyDamage,
  HEAL_PER_VALIDATED_IMPACT,
  healTarget,
  nextTarget,
  partyFor,
  SHIELD_PER_VALIDATED_IMPACT,
} from "./party.js";
import { consistencyFor, currentStepFor, hierarchyFor, progressFor, questDetailFor, statsFor } from "./read-models.js";
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

function addEvent(state: RealmState, event: Omit<RealmEvent, "id" | "createdAt">): void {
  state.events.unshift({ id: randomUUID(), createdAt: now(), ...event });
  state.events = state.events.slice(0, 100);
}

export function battleFor(quest: Quest | null, gameEvents: GameEvent[] = [], nowMs = Date.now()): BattleState | null {
  if (!quest) return null;
  const damage = quest.steps.reduce((sum, step) => sum + step.impactAwarded, 0);
  const attempt = quest.battle?.attempt ?? 1;
  // El grupo se reconstruye con los eventos de ESTE intento: un reintento no
  // arrastra el daño del anterior. La vida del Marqués es la del jugador.
  const party = partyFor(quest, gameEvents);
  const playerHealth = party.marques.health;
  const enemyHealth = Math.max(0, 100 - damage);
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
    isKo: damage === 100,
    isPlayerKo: playerHealth === 0,
    durationMinutes: quest.battle?.durationMinutes ?? clampBattleMinutes(quest.durationMinutes),
    status: quest.battle?.status ?? "pending",
    attempt,
    party,
    // El reloj no corre en el borrador: sólo existe desde que el jugador inicia.
    clock: quest.battle ? battleClock(quest.battle, nowMs) : null,
  };
}

/**
 * Recompensa por defecto de un contrato que no declaró la suya.
 *
 * XP mide la gesta pactada —la mitad de los minutos acordados—, no el tiempo
 * que el jugador pasó en la app. Aura crece con los cuidados que el contrato se
 * comprometió a respetar, porque Aura es calidad de vida y no productividad.
 * Sin dominio declarado no hay maestría: no se inventa una especialidad.
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

/**
 * Qué mira el jugador ahora mismo.
 *
 * Primero el frente comprometido —si hay reloj corriendo, eso manda—; después
 * lo accionable de la campaña EN FOCO; y sólo entonces cualquier otra cosa. El
 * foco no cierra ninguna campaña: sólo decide a dónde apunta la mirada.
 */
function currentQuest(state: RealmState): Quest | null {
  const engaged = engagedQuest(state);
  if (engaged) return engaged;
  const focused = state.focusedCampaignId
    ? actionableIn(state.quests.filter((quest) => quest.campaignId === state.focusedCampaignId))
    : null;
  return focused ?? actionableIn(state.quests) ?? state.quests[0] ?? null;
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

  const campaign = act.campaignId ? state.campaigns.find((candidate) => candidate.id === act.campaignId) : undefined;
  if (!campaign) return;
  const actsOfCampaign = campaign.actIds
    .map((actId) => state.acts.find((candidate) => candidate.id === actId))
    .filter((candidate): candidate is Act => Boolean(candidate));
  if (!actsOfCampaign.every((candidate) => ["completed", "abandoned"].includes(candidate.status))) return;
  campaign.status = "completed";
  campaign.completedAt = timestamp;
  campaign.updatedAt = timestamp;

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
    if (!needsAdvance(state, Date.now())) return state;
    const { state: fresh } = await this.store.mutate((draft) => advanceBattles(draft, Date.now()));
    return fresh;
  }

  async snapshot(): Promise<RealmSnapshot> {
    const realm = await this.tick();
    const quest = currentQuest(realm);
    const { availableBalance, expectedIncome, committedExpenses, reserveTarget } = realm.financial;
    const battle = battleFor(quest, realm.gameEvents);
    return {
      realm,
      currentQuest: quest,
      progress: progressFor(quest),
      currentStep: currentStepFor(quest),
      battle,
      stats: statsFor(realm, battle),
      hierarchy: hierarchyFor(realm, quest, engagedQuest(realm)?.id ?? null),
      rewardPreview: quest ? previewRewards(quest) : null,
      consistency: consistencyFor(realm, this.instance, quest),
      projectedMargin: availableBalance + expectedIncome - committedExpenses - reserveTarget,
    };
  }

  /**
   * Lectura detallada de una misión: pasos, artefactos y veredictos unidos.
   * Responde «¿qué ocurre exactamente dentro de esta misión?», que es distinto
   * de la panorámica que da snapshot().
   */
  async questDetail(questId: string): Promise<QuestDetail> {
    return questDetailFor(await this.tick(), questId);
  }

  async createDraft(plan: QuestPlanInput, parents: { actId?: string } = {}): Promise<Quest> {
    validatePlan(plan);
    const { result } = await this.store.mutate((state) => {
      // Varias campañas pueden tener quests listas a la vez. Lo que no puede
      // duplicarse es la Battle comprometida, y eso lo defiende start().
      const act = parents.actId ? state.acts.find((candidate) => candidate.id === parents.actId) : undefined;
      if (parents.actId && !act) throw new Error(`Acto no encontrado: ${parents.actId}`);
      if (act && act.questIds.length >= MAX_QUESTS_PER_ACT) {
        throw new Error(`El acto «${act.title}» ya sostiene ${MAX_QUESTS_PER_ACT} Battles: parte el trabajo en otro Acto.`);
      }
      const timestamp = now();
      const quest: Quest = {
        ...plan,
        id: randomUUID(),
        status: "draft",
        actId: act?.id,
        campaignId: act?.campaignId,
        sagaId: act?.sagaId,
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
        if (act.status === "pending") act.status = "active";
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
  async createDraftFromIntent(intent: string, minutesAvailable?: number, actId?: string): Promise<Quest> {
    const clean = intent.trim();
    if (clean.length < 8) throw new Error("Describe una quest con un poco más de detalle.");
    const realm = await this.store.read();
    const plan = await this.codice.plan({
      intent: clean,
      playerTitle: `${realm.player.displayName}, ${realm.player.title}`,
      activeCampaign: realm.quests.find((quest) => quest.status === "active")?.campaignTitle,
      minutesAvailable,
    });
    return this.createDraft(plan, { actId });
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
      const startedAtMs = Date.now();
      const duration = clampBattleMinutes(durationMinutes ?? quest.durationMinutes);
      quest.status = "active";
      quest.startedAt = new Date(startedAtMs).toISOString();
      quest.updatedAt = quest.startedAt;
      quest.battle = createBattleRecord(startedAtMs, duration);
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
      if (!quest.battle || quest.battle.status !== "lost") throw new Error("Sólo una Battle perdida puede reintentarse.");
      if (!["active", "waiting_external"].includes(quest.status)) throw new Error("Esta quest ya no tiene frente abierto: no hay Battle que reintentar.");
      const engaged = engagedQuest(state);
      if (engaged && engaged.id !== questId) {
        throw new Error(`Ya hay una Battle comprometida: «${engaged.title}». No puedes sostener dos frentes con reloj a la vez.`);
      }
      if (quest.steps.every((step) => step.impactAwarded >= step.weight)) throw new Error("Esta quest ya no tiene impacto pendiente.");
      const startedAtMs = Date.now();
      const duration = clampBattleMinutes(durationMinutes ?? quest.battle.durationMinutes);
      const attempt = quest.battle.attempt + 1;
      quest.battle = createBattleRecord(startedAtMs, duration, attempt);
      quest.status = "active";
      quest.updatedAt = quest.battle.startedAt;
      state.gameEvents.unshift({
        id: randomUUID(),
        type: "battle_started",
        questId,
        damage: 0,
        battleAttempt: attempt,
        message: `Segunda oportunidad sobre «${quest.title}»: ${duration} min pactados.`,
        createdAt: quest.battle.startedAt,
      });
      state.gameEvents = state.gameEvents.slice(0, 200);
      addEvent(state, {
        type: "battle_restarted",
        questId,
        message: `El Marqués vuelve al frente de «${quest.title}» (intento ${attempt}). La evidencia validada se conserva.`,
      });
      return { quest, battle: battleFor(quest, state.gameEvents)! };
    });
    return result;
  }

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
    },
  ): Promise<{ quest: Quest; battle: BattleState; evidenceId: string; lifeEventId: string; gameEventId: string | null }> {
    const { result } = await this.store.mutate((state) => {
      const quest = requireQuest(state, questId);
      if (quest.status !== "active") throw new Error("La quest debe estar activa para evaluar evidencia.");
      if (quest.battle?.status === "lost") {
        throw new Error("El tiempo pactado terminó con la Horda viva. Reinicia la Battle o pide un replan al Códice antes de entregar más evidencia.");
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
        // MARQUÉS ATACA: el impacto validado es su flecha.
        state.gameEvents.unshift({
          id: gameEventId,
          type: "quest_attack",
          sourceLifeEventId: lifeEventId,
          questId,
          stepId,
          damage: input.impactAwarded,
          target: "marques",
          battleAttempt: quest.battle?.attempt ?? 1,
          message: `${step.title}: ataque de ${input.impactAwarded}.`,
          createdAt: timestamp,
        });
        state.gameEvents = state.gameEvents.slice(0, 200);

        // CORDERA SOSTIENE y ROKO PROTEGE: sólo el resultado real los mueve.
        // Una evidencia rechazada no cura ni escuda, por convincente que suene.
        if (quest.battle?.status === "active") {
          const party = partyFor(quest, state.gameEvents);
          const healed = healTarget(party);
          if (healed) {
            state.gameEvents.unshift({
              id: randomUUID(),
              type: "party_heal",
              sourceLifeEventId: lifeEventId,
              questId,
              stepId,
              damage: HEAL_PER_VALIDATED_IMPACT,
              target: healed,
              battleAttempt: quest.battle.attempt,
              message: `Cordera sostiene a ${party[healed].name}: +${HEAL_PER_VALIDATED_IMPACT} HP.`,
              createdAt: timestamp,
            });
          }
          const roko = party.roko;
          if (roko.health > 0 && roko.shield !== undefined && roko.maxShield !== undefined && roko.shield < roko.maxShield) {
            state.gameEvents.unshift({
              id: randomUUID(),
              type: "shield_gained",
              sourceLifeEventId: lifeEventId,
              questId,
              stepId,
              damage: SHIELD_PER_VALIDATED_IMPACT,
              target: "roko",
              battleAttempt: quest.battle.attempt,
              message: `Instinto Protector: Roko recupera +${SHIELD_PER_VALIDATED_IMPACT} de escudo.`,
              createdAt: timestamp,
            });
          }
          state.gameEvents = state.gameEvents.slice(0, 200);
        }
      }
      addEvent(state, {
        type: "step_completed",
        questId,
        message: input.impactAwarded > 0 ? `${step.title}: impacto validado de ${input.impactAwarded} puntos.` : `${step.title}: evidencia rechazada; sin impacto.`,
      });
      const battle = battleFor(quest, state.gameEvents)!;
      if (battle.isKo) {
        quest.status = "completed";
        quest.completedAt = now();
        quest.updatedAt = quest.completedAt;
        // Si la Horda cae antes del plazo, el reloj deja de ser enemigo.
        if (quest.battle?.status === "active") resolveBattle(state, quest, quest.battle, "won", Date.now());
        closeParents(state, quest);
        addEvent(state, { type: "quest_completed", questId, message: `KO: «${quest.title}» fue completada.` });
        const reward = grantQuestRewards(state, quest);
        if (reward) {
          const mastery = reward.masteryDomain ? ` +${reward.masteryPoints} ${reward.masteryDomain}` : "";
          addEvent(state, {
            type: "reward_granted",
            questId,
            message: `El resultado validado concede +${reward.xp} XP +${reward.aura} Aura${mastery}.`,
          });
        }
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
    input: { note?: string; artifactIds?: string[]; attach?: ArtifactInput },
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
    });

    return { ...applied, judgement, artifacts };
  }

  async completeStep(questId: string, stepId: string, evidenceNote: string): Promise<{ quest: Quest; battle: BattleState }> {
    const snapshot = await this.snapshot();
    const step = snapshot.realm.quests.find((quest) => quest.id === questId)?.steps.find((candidate) => candidate.id === stepId);
    if (!step) throw new Error(`Paso no encontrado: ${stepId}`);
    const result = await this.submitEvidence(questId, stepId, {
      summary: evidenceNote,
      source: "user_declaration",
      verdict: "accepted",
      reasoning: "Compatibilidad del MVP: evidencia declarada como suficiente.",
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

  async recordUnexpectedRequirement(
    questId: string,
    input: { reason: string; damage: number; stepId?: string },
  ): Promise<{ battle: BattleState; lifeEventId: string; gameEventId: string }> {
    if (input.reason.trim().length < 10) throw new Error("Describe el requisito inesperado que representa este ataque.");
    if (!Number.isInteger(input.damage) || input.damage < 1 || input.damage > 50) throw new Error("El daño debe ser un entero entre 1 y 50.");
    const { result } = await this.store.mutate((state) => {
      const quest = requireQuest(state, questId);
      if (quest.status !== "active") throw new Error("La Horda sólo puede atacar un frente activo con presión real; una espera externa no recibe daño automático.");
      if (input.stepId) requireStep(quest, input.stepId);
      const timestamp = now();
      const lifeEventId = randomUUID();
      state.lifeEvents.unshift({ id: lifeEventId, type: "unexpected_requirement", questId, stepId: input.stepId, reason: input.reason.trim(), createdAt: timestamp });
      const gameEventId = randomUUID();
      // Un requisito inesperado golpea el frente igual que el reloj: Roko lo
      // aguanta mientras viva, y su escudo se gasta antes que su vida.
      const before = partyFor(quest, state.gameEvents);
      const target = nextTarget(before);
      const { absorbed } = applyDamage(before, target, input.damage);
      state.gameEvents.unshift({
        id: gameEventId,
        type: "horde_attack",
        sourceLifeEventId: lifeEventId,
        questId,
        stepId: input.stepId,
        damage: input.damage,
        reason: input.reason.trim(),
        battleAttempt: quest.battle?.attempt ?? 1,
        target,
        message: `La Horda contraataca sobre ${before[target].name}: ${input.reason.trim()} (-${input.damage}).`,
        createdAt: timestamp,
      });
      if (absorbed > 0) {
        state.gameEvents.unshift({
          id: randomUUID(),
          type: "shield_absorbed",
          questId,
          damage: absorbed,
          target,
          battleAttempt: quest.battle?.attempt ?? 1,
          message: `El escudo de ${before[target].name} absorbe ${absorbed}.`,
          createdAt: timestamp,
        });
      }
      if (before[target].health === 0) {
        state.gameEvents.unshift({
          id: randomUUID(),
          type: "party_member_ko",
          questId,
          damage: 0,
          target,
          battleAttempt: quest.battle?.attempt ?? 1,
          message: `${before[target].name} cae en el frente.`,
          createdAt: timestamp,
        });
      }
      state.lifeEvents = state.lifeEvents.slice(0, 200);
      state.gameEvents = state.gameEvents.slice(0, 200);
      let battle = battleFor(quest, state.gameEvents)!;
      addEvent(state, {
        type: "horde_attack",
        questId,
        message: `La Horda golpea a ${before[target].name} (-${input.damage}). El Marqués conserva ${battle.playerHealth} HP.`,
      });
      if (battle.isPlayerKo && quest.battle?.status === "active") {
        resolveBattle(state, quest, quest.battle, "lost", Date.now());
        battle = battleFor(quest, state.gameEvents)!;
      }
      return { battle, lifeEventId, gameEventId };
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
      const campaign = state.campaigns.find((candidate) => candidate.id === campaignId);
      if (!campaign) throw new Error(`Campaña no encontrada: ${campaignId}`);
      state.focusedCampaignId = campaign.id;
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

  async createCampaign(input: {
    title: string;
    summary?: string;
    objective?: string;
    sagaId?: string;
    estimatedActiveMinutes?: number;
    scenario?: string;
    bossTitle?: string;
    bossDescription?: string;
  }): Promise<Campaign> {
    if (input.title.trim().length < 3) throw new Error("La campaña necesita un título.");
    const { result } = await this.store.mutate((state) => {
      const saga = input.sagaId ? state.sagas.find((candidate) => candidate.id === input.sagaId) : undefined;
      if (input.sagaId && !saga) throw new Error(`Saga no encontrada: ${input.sagaId}`);
      const timestamp = now();
      const campaign: Campaign = {
        id: randomUUID(),
        sagaId: saga?.id,
        title: input.title.trim().slice(0, 120),
        summary: input.summary?.trim().slice(0, 500),
        objective: input.objective?.trim().slice(0, 500),
        status: "active",
        actIds: [],
        estimatedActiveMinutes: Math.max(0, Math.round(input.estimatedActiveMinutes ?? 0)),
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
      return campaign;
    });
    return result;
  }

  async createAct(input: {
    title: string;
    subtitle?: string;
    campaignId?: string;
    scenario?: string;
    estimatedActiveMinutes?: number;
  }): Promise<Act> {
    if (input.title.trim().length < 3) throw new Error("El acto necesita un título.");
    const { result } = await this.store.mutate((state) => {
      const campaign = input.campaignId ? state.campaigns.find((candidate) => candidate.id === input.campaignId) : undefined;
      if (input.campaignId && !campaign) throw new Error(`Campaña no encontrada: ${input.campaignId}`);
      if (campaign && campaign.actIds.length >= MAX_ACTS_PER_CAMPAIGN) {
        throw new Error(`La campaña «${campaign.title}» ya sostiene ${MAX_ACTS_PER_CAMPAIGN} Actos: abre otra Campaña bajo una Saga.`);
      }
      const timestamp = now();
      const act: Act = {
        id: randomUUID(),
        campaignId: campaign?.id,
        sagaId: campaign?.sagaId,
        title: input.title.trim().slice(0, 120),
        subtitle: input.subtitle?.trim().slice(0, 200),
        status: "pending",
        questIds: [],
        estimatedActiveMinutes: Math.max(0, Math.round(input.estimatedActiveMinutes ?? 0)),
        scenario: input.scenario?.trim().slice(0, 120),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      state.acts.unshift(act);
      if (campaign) {
        campaign.actIds.push(act.id);
        campaign.updatedAt = timestamp;
      }
      return act;
    });
    return result;
  }

  /** Adopta una quest ya existente dentro de un Acto, sin duplicarla. */
  async assignQuestToAct(questId: string, actId: string): Promise<{ quest: Quest; act: Act }> {
    const { result } = await this.store.mutate((state) => {
      const quest = requireQuest(state, questId);
      const act = state.acts.find((candidate) => candidate.id === actId);
      if (!act) throw new Error(`Acto no encontrado: ${actId}`);
      if (act.questIds.includes(questId)) return { quest, act };
      if (act.questIds.length >= MAX_QUESTS_PER_ACT) {
        throw new Error(`El acto «${act.title}» ya sostiene ${MAX_QUESTS_PER_ACT} Battles: parte el trabajo en otro Acto.`);
      }
      const previous = quest.actId ? state.acts.find((candidate) => candidate.id === quest.actId) : undefined;
      if (previous) previous.questIds = previous.questIds.filter((candidate) => candidate !== questId);
      act.questIds.push(questId);
      act.updatedAt = now();
      if (act.status === "pending") act.status = "active";
      quest.actId = act.id;
      quest.campaignId = act.campaignId;
      quest.sagaId = act.sagaId;
      quest.updatedAt = act.updatedAt;
      return { quest, act };
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
      // Retirarse cierra el reloj: una quest abandonada ya no recibe ataques.
      if (quest.battle?.status === "active") resolveBattle(state, quest, quest.battle, "lost", Date.now());
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
