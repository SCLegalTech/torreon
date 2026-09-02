/**
 * LA ESCALA DEL MUNDO SIGUE LA ESCALA DE LA VIDA.
 *
 * El jugador sólo expresa el objetivo. Códice decide si eso es una Quest, un
 * Acto, una Campaña o una Saga; el servidor conserva la regla para que ningún
 * runtime pueda inventarse una jerarquía más grande de la que la vida pide.
 *
 * La clasificación mira MINUTOS DE TRABAJO ACTIVO, no tiempo de calendario:
 * diez minutos de trabajo y tres días esperando una firma siguen siendo una
 * Quest en espera externa, nunca una Campaña.
 */

export type ScaleKind = "quest" | "act" | "campaign" | "saga";

/** Una Battle es una representación temporizada: el reloj no puede ser eterno. */
export const MAX_BATTLE_MINUTES = 60;
/** Un Acto es una jornada jugable, no una vida entera. */
export const MAX_ACT_MINUTES = 480;
export const MAX_QUESTS_PER_ACT = 8;
export const MIN_QUESTS_PER_ACT = 2;
export const MAX_ACTS_PER_CAMPAIGN = 7;
/** Una Saga agrupa Campañas; con una sola no hay Saga que contar. */
export const MIN_CAMPAIGNS_PER_SAGA = 2;

export interface ScaleRequest {
  /** Minutos de trabajo activo del jugador. Es lo único que fija la escala. */
  activeMinutes: number;
  /** Espera ajena al jugador: no infla la escala, sólo explica el calendario. */
  externalWaitMinutes?: number;
  /** Campañas naturales que el objetivo ya contiene de por sí. */
  naturalCampaigns?: number;
}

export interface ScaleProposal {
  scale: ScaleKind;
  activeMinutes: number;
  externalWaitMinutes: number;
  /** Cuántas Battles hacen falta: ninguna puede pasar de 60 minutos. */
  suggestedQuests: number;
  suggestedActs: number;
  suggestedCampaigns: number;
  /** Si el trabajo activo cabe en una jornada aunque el calendario sea largo. */
  fitsInOneDay: boolean;
  /** La espera externa puede suspender la presión temporal sin cambiar escala. */
  waitingExternal: boolean;
  reason: string;
}

function positive(value: number | undefined, fallback = 0): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.round(value as number) : fallback;
}

/** Ninguna Battle puede exceder 60 minutos: el resto se descompone. */
export function questsNeededFor(activeMinutes: number): number {
  return Math.max(1, Math.ceil(activeMinutes / MAX_BATTLE_MINUTES));
}

/** Un Acto no sostiene más de 8 Battles; a partir de ahí se parte en Actos. */
export function actsNeededFor(quests: number): number {
  return Math.max(1, Math.ceil(quests / MAX_QUESTS_PER_ACT));
}

/** Una Campaña no sostiene más de 7 Actos; a partir de ahí nace una Saga. */
export function campaignsNeededFor(acts: number): number {
  return Math.max(1, Math.ceil(acts / MAX_ACTS_PER_CAMPAIGN));
}

/**
 * Regla MVP:
 *   <= 60 min activos                    -> Quest
 *   > 60 y <= 480, ejecutable en un día  -> Acto
 *   varios días activos, hasta 7 Actos   -> Campaña
 *   > 7 días activos o 2+ Campañas       -> Saga
 */
export function classifyScale(request: ScaleRequest): ScaleProposal {
  const activeMinutes = positive(request.activeMinutes, 0);
  const externalWaitMinutes = positive(request.externalWaitMinutes, 0);
  const naturalCampaigns = Math.max(1, positive(request.naturalCampaigns, 1));

  const suggestedQuests = questsNeededFor(activeMinutes);
  const suggestedActs = actsNeededFor(suggestedQuests);
  const derivedCampaigns = Math.max(naturalCampaigns, campaignsNeededFor(suggestedActs));
  const fitsInOneDay = activeMinutes <= MAX_ACT_MINUTES;
  const waitingExternal = externalWaitMinutes > 0;

  let scale: ScaleKind;
  let reason: string;

  if (naturalCampaigns >= MIN_CAMPAIGNS_PER_SAGA) {
    scale = "saga";
    reason = `El objetivo contiene ${naturalCampaigns} campañas naturales: eso ya es una Saga.`;
  } else if (activeMinutes <= MAX_BATTLE_MINUTES) {
    scale = "quest";
    reason = waitingExternal
      ? `${activeMinutes} min de trabajo activo caben en una sola Battle; los ${externalWaitMinutes} min de espera ajena no cambian la escala, sólo pueden suspender la presión.`
      : `${activeMinutes} min de trabajo activo caben en una sola Battle de máximo ${MAX_BATTLE_MINUTES} min.`;
  } else if (fitsInOneDay) {
    scale = "act";
    reason = `${activeMinutes} min de trabajo activo son una jornada: un Acto con ${suggestedQuests} Battles de máximo ${MAX_BATTLE_MINUTES} min.`;
  } else if (suggestedActs <= MAX_ACTS_PER_CAMPAIGN) {
    scale = "campaign";
    reason = `${activeMinutes} min de trabajo activo no caben en una jornada: una Campaña de ${suggestedActs} Actos.`;
  } else {
    scale = "saga";
    reason = `${activeMinutes} min de trabajo activo exigen ${suggestedActs} Actos, más de los ${MAX_ACTS_PER_CAMPAIGN} que sostiene una Campaña: nace una Saga.`;
  }

  return {
    scale,
    activeMinutes,
    externalWaitMinutes,
    suggestedQuests,
    suggestedActs,
    suggestedCampaigns: scale === "saga" ? Math.max(MIN_CAMPAIGNS_PER_SAGA, derivedCampaigns) : derivedCampaigns,
    fitsInOneDay,
    waitingExternal,
    reason,
  };
}

/**
 * Estimación sin modelo. No adivina la vida del jugador: usa los minutos que
 * él mismo declaró y, si no declaró ninguno, lee las unidades de tiempo que
 * escribió. Nunca convierte una espera («en tres semanas», «cuando respondan»)
 * en trabajo activo.
 */
export function estimateActiveMinutes(intent: string, declaredMinutes?: number): { activeMinutes: number; externalWaitMinutes: number } {
  if (Number.isFinite(declaredMinutes) && (declaredMinutes as number) > 0) {
    return { activeMinutes: Math.round(declaredMinutes as number), externalWaitMinutes: 0 };
  }
  const text = intent.toLowerCase();
  const waiting = /\b(esperar|esperando|espera|respondan|responda|firma|firmen|aprueben|aprobación|tercero|banco|notaria|notaría)\b/.test(text);

  const explicit = text.match(/\b(\d{1,3})\s*(min|mins|minutos?|h|hs|horas?|d[ií]as?|semanas?)\b/);
  if (explicit) {
    const value = Number(explicit[1]);
    const unit = explicit[2];
    if (/^min/.test(unit)) return { activeMinutes: value, externalWaitMinutes: waiting ? 60 : 0 };
    if (/^h/.test(unit)) return { activeMinutes: value * 60, externalWaitMinutes: waiting ? 60 : 0 };
    // Días y semanas de calendario no son minutos activos: se estima jornada corta.
    if (/^d/.test(unit)) return { activeMinutes: value * 120, externalWaitMinutes: waiting ? value * 1440 : 0 };
    return { activeMinutes: value * 600, externalWaitMinutes: waiting ? value * 10080 : 0 };
  }

  if (/\bhoy\b|\btodo el d[ií]a\b|\bjornada\b/.test(text)) return { activeMinutes: 240, externalWaitMinutes: 0 };
  if (/\besta semana\b|\ben la semana\b/.test(text)) return { activeMinutes: 900, externalWaitMinutes: 0 };
  if (/\beste mes\b|\bsemanas\b/.test(text)) return { activeMinutes: 3600, externalWaitMinutes: 0 };
  return { activeMinutes: 45, externalWaitMinutes: waiting ? 1440 : 0 };
}
