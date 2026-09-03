import type { AdPlacement, Entitlements, UsageCounters } from "./domain.js";

/**
 * PRODUCT FOUNDATION — sólo boundaries y estado.
 *
 * MONETIZATION MAY SELL ACCESS. IT MAY NEVER SELL A FAKE REAL-WORLD RESULT.
 *
 * Aquí no se integra Google Play Billing, ni AdMob, ni checkout. Se prepara la
 * capa config-driven para que un plan futuro pueda limitar el ACCESO al bucle
 * sin tocar el gameplay. Ningún límite se aplica al jugador actual: el plan por
 * defecto es `dev` y todos los topes son `null`.
 */

export const DEV_ENTITLEMENTS: Entitlements = {
  plan: "dev",
  dailyBattleLimit: null,
  dailyCodiceCallLimit: null,
  adsEnabled: false,
  reasoningCallsPerDay: null,
  visionValidationsPerDay: null,
  agentExecutionsPerDay: null,
};

/**
 * Perfiles FUTUROS. No se activan; existen para que la forma del plan esté
 * escrita y un feature flag pueda intercambiarlos más adelante.
 */
export const PLAN_PROFILES: Record<Entitlements["plan"], Entitlements> = {
  dev: DEV_ENTITLEMENTS,
  free: {
    plan: "free",
    dailyBattleLimit: 8,
    dailyCodiceCallLimit: 40,
    adsEnabled: true,
    reasoningCallsPerDay: 40,
    visionValidationsPerDay: 20,
    agentExecutionsPerDay: 10,
  },
  premium: {
    plan: "premium",
    dailyBattleLimit: null,
    dailyCodiceCallLimit: null,
    adsEnabled: false,
    reasoningCallsPerDay: null,
    visionValidationsPerDay: null,
    agentExecutionsPerDay: null,
  },
};

/** "YYYY-MM-DD" en UTC. El período de conteo rota sin borrar historia. */
export function usagePeriodKey(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function freshUsage(nowMs = Date.now()): UsageCounters {
  return {
    period: usagePeriodKey(nowMs),
    battlesStartedToday: 0,
    codiceReasoningCalls: 0,
    visionValidations: 0,
    agentOrchestrations: 0,
    companionExecutions: 0,
    companionSuccessfulExecutions: 0,
    companionValidatedAssists: 0,
  };
}

/**
 * Rota los contadores cuando cambia el día. No borra: empieza un período nuevo.
 * Devuelve `true` si hubo rotación (para que el llamador sepa que debe persistir).
 */
export function rolloverUsage(usage: UsageCounters, nowMs = Date.now()): boolean {
  const period = usagePeriodKey(nowMs);
  if (usage.period === period) return false;
  usage.period = period;
  usage.battlesStartedToday = 0;
  usage.codiceReasoningCalls = 0;
  usage.visionValidations = 0;
  usage.agentOrchestrations = 0;
  return true;
}

/**
 * ¿El plan permite iniciar OTRA Battle hoy? Cuenta sólo inicios iniciales.
 * Un reintento, un replan o un recontrato del mismo Quest NO consumen cupo.
 */
export function battleStartAllowed(entitlements: Entitlements, usage: UsageCounters): { allowed: boolean; reason?: string } {
  if (entitlements.dailyBattleLimit === null) return { allowed: true };
  if (usage.battlesStartedToday < entitlements.dailyBattleLimit) return { allowed: true };
  return {
    allowed: false,
    reason: `El plan ${entitlements.plan} permite ${entitlements.dailyBattleLimit} Battles nuevas por día y ya se iniciaron ${usage.battlesStartedToday}. Un reintento o un replan del mismo Quest no cuenta; abrir otro frente sí.`,
  };
}

/**
 * ADS — FUNDACIÓN, NO SDK.
 *
 * El teléfono debe poder quedarse quieto: nada de vídeo con audio periódico ni
 * interstitial que tape el timer. Un ad JAMÁS concede daño ni progreso validado.
 */
export const AD_PLACEMENTS: AdPlacement[] = [
  {
    id: "battle_passive",
    style: "native_static",
    grantsProgress: false,
    description: "Ranura nativa discreta durante la Battle. No exige interacción.",
  },
  {
    id: "extra_battle_reward",
    style: "rewarded_optional",
    grantsProgress: false,
    description: "Rewarded voluntario para sumar +1 Battle al cupo diario. Nunca obligatorio.",
  },
  {
    id: "battle_result",
    style: "result_optional",
    grantsProgress: false,
    description: "Placement opcional en la pantalla de resultado, después de resolver.",
  },
];
