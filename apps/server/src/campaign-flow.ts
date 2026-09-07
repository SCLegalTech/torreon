import { randomUUID } from "node:crypto";
import type { Act, Campaign, Quest, RealmState, Saga } from "./domain.js";
import { isoAt } from "./clock.js";
import { deny, notFound } from "./errors.js";
import { addEvent } from "./realm-events.js";
import { MAX_ACTS_PER_CAMPAIGN } from "./scale.js";

/**
 * SAGA, CAMPAÑA, ACTO.
 *
 * Extraído de `quest-service.ts` (artículo 9: el orquestador sólo puede
 * encoger). Aquí vive la estructura del mundo, con dos reglas que no se
 * negocian:
 *
 *   - Una Campaña EXIGE pacto: nace en borrador y sólo el jugador la sella.
 *   - Un Acto NO tiene ceremonia propia: es planificación operativa del
 *     Códice, nace disponible y no bloquea a nadie por su posición.
 *
 * Funciones puras sobre el estado: no conocen el almacén ni el transporte.
 */

/**
 * EL PROGRESO SUBE SOLO CON RESULTADOS REALES.
 *
 * Una Quest completada cierra su Acto cuando ya no queda ninguna Quest viva en
 * el; un Acto cerrado cierra su Campaña; una Campaña cerrada cierra su Saga.
 * Nada de esto se marca a mano ni con un clic.
 */
export function closeParents(state: RealmState, quest: Quest, nowMs: number): void {
  const timestamp = isoAt(nowMs);
  const act = quest.actId ? state.acts.find((candidate) => candidate.id === quest.actId) : undefined;
  if (!act) return;
  const questsOfAct = act.questIds
    .map((questId) => state.quests.find((candidate) => candidate.id === questId))
    .filter((candidate): candidate is Quest => Boolean(candidate));
  if (!questsOfAct.every((candidate) => ["completed", "abandoned"].includes(candidate.status))) return;
  act.status = "completed";
  act.completedAt = timestamp;
  act.updatedAt = timestamp;
  addEvent(state, { type: "act_completed", entityType: "act", entityId: act.id, message: `El acto «${act.title}» quedó cerrado.` }, nowMs);

  const campaign = act.campaignId ? state.campaigns.find((candidate) => candidate.id === act.campaignId) : undefined;
  if (!campaign) return;
  const actsOfCampaign = campaign.actIds
    .map((actId) => state.acts.find((candidate) => candidate.id === actId))
    .filter((candidate): candidate is Act => Boolean(candidate));
  if (!actsOfCampaign.every((candidate) => ["completed", "abandoned"].includes(candidate.status))) return;
  campaign.status = "completed";
  campaign.completedAt = timestamp;
  campaign.updatedAt = timestamp;
  addEvent(state, { type: "campaign_completed", entityType: "campaign", entityId: campaign.id, message: `Campaña conquistada: «${campaign.title}».` }, nowMs);

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
export function campaignTitleFrom(intent: string): string {
  const core = intent
    .replace(/^(necesito|quiero|tengo que|debo|me toca|hay que|voy a|deseo)\s+/i, "")
    .replace(/[.?!]+$/g, "")
    .trim();
  const short = core.length > 44 ? `${core.slice(0, 41).trim()}...` : core;
  const named = short.charAt(0).toUpperCase() + short.slice(1);
  return `La Forja de ${named}`.slice(0, 120);
}

export function requireCampaign(state: RealmState, campaignId: string): Campaign {
  const campaign = state.campaigns.find((candidate) => candidate.id === campaignId);
  if (!campaign) throw notFound(`Campaña no encontrada: ${campaignId}`);
  return campaign;
}

/** Un Acto nace disponible: es planificación, no un pacto aparte. */
export function buildAct(
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


// ---------------------------------------------------------------------------
// OPERACIONES. El servicio las envuelve en una mutación; ellas deciden.
// ---------------------------------------------------------------------------

export interface SagaInput {
  title: string;
  summary?: string;
  estimatedActiveMinutes?: number;
}

/** Una Saga sólo tiene sentido con dos o más campañas naturales debajo. */
export function createSaga(state: RealmState, input: SagaInput, nowMs: number): Saga {
  if (input.title.trim().length < 3) throw deny("La saga necesita un título.");
  const timestamp = isoAt(nowMs);
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
}

/** Sellar una campaña NO inicia ninguna Battle y NO cierra ninguna otra campaña. */
export function acceptCampaign(state: RealmState, campaignId: string, userAccepted: boolean, nowMs: number): Campaign {
  if (!userAccepted) throw deny("La aceptación explícita del usuario es obligatoria.");
  const campaign = requireCampaign(state, campaignId);
  // Idempotente: reintentar un sello ya puesto no rompe nada.
  if (campaign.status === "active") return campaign;
  if (campaign.status !== "draft") throw deny(`Esta campaña ya está ${campaign.status}.`);
  campaign.status = "active";
  campaign.acceptedAt = isoAt(nowMs);
  campaign.updatedAt = campaign.acceptedAt;
  state.focusedCampaignId ??= campaign.id;
  addEvent(
    state,
    {
      type: "campaign_accepted",
      entityType: "campaign",
      entityId: campaign.id,
      message: `El pacto de «${campaign.title}» ha sido sellado.`,
    },
    nowMs,
  );
  return campaign;
}

/** Retirarse tiene motivo y queda escrito. Lo conquistado es historia y no se retira. */
export function abandonCampaign(state: RealmState, campaignId: string, reason: string, nowMs: number): Campaign {
  const campaign = requireCampaign(state, campaignId);
  if (campaign.status === "abandoned") return campaign;
  if (campaign.status === "completed") throw deny("Una campaña conquistada es historia: no se retira.");
  campaign.status = "abandoned";
  campaign.updatedAt = isoAt(nowMs);
  if (state.focusedCampaignId === campaign.id) delete state.focusedCampaignId;
  addEvent(
    state,
    {
      type: "campaign_abandoned",
      entityType: "campaign",
      entityId: campaign.id,
      message: `Retirada de «${campaign.title}»: ${reason.trim() || "sin motivo registrado"}.`,
    },
    nowMs,
  );
  return campaign;
}

export interface ActInput {
  title: string;
  subtitle?: string;
  outcome?: string;
  campaignId?: string;
  scenario?: string;
  estimatedActiveMinutes?: number;
  /** Dependencias EXPLÍCITAS. Sin esto el Acto nace disponible, en paralelo. */
  dependsOnActIds?: string[];
}

export function createAct(state: RealmState, input: ActInput, nowMs: number): Act {
  if (input.title.trim().length < 3) throw deny("El acto necesita un título.");
  const campaign = input.campaignId ? requireCampaign(state, input.campaignId) : undefined;
  if (campaign && campaign.actIds.length >= MAX_ACTS_PER_CAMPAIGN) {
    throw deny(`La campaña «${campaign.title}» ya sostiene ${MAX_ACTS_PER_CAMPAIGN} Actos: abre otra Campaña bajo una Saga.`);
  }
  const timestamp = isoAt(nowMs);
  const act = buildAct(campaign, input, timestamp);
  act.scenario = input.scenario?.trim().slice(0, 120);
  state.acts.unshift(act);
  if (campaign) {
    campaign.actIds.push(act.id);
    campaign.updatedAt = timestamp;
  }
  addEvent(state, { type: "act_created", entityType: "act", entityId: act.id, message: `Acto trazado: «${act.title}».` }, nowMs);
  return act;
}
