import type {
  CompanionId,
  HeroAbilityView,
  HeroCareerState,
  HeroCareerStats,
  HeroId,
  HeroKind,
  PartyMemberId,
} from "./domain.js";

/**
 * PROGRESIÓN CONFIG-DRIVEN.
 *
 * LEVEL IS NOT PERMISSION. Un Opus de nivel 50 sigue sin poder enviar un correo
 * sin confirmación, firmar, pagar, borrar ni desplegar producción: los permisos
 * los gobiernan la política de herramientas y la autorización humana real, y
 * nada de este archivo los toca.
 *
 * Y el nivel no se gana abriendo la app: sólo lo mueve un resultado validado.
 */

/** El id interno es estable; el nombre visible se resuelve aquí. */
export const HERO_DISPLAY_NAME: Record<HeroId, string> = {
  // CORRECCIÓN CANÓNICA: el personaje es Roku. El id `roko` sigue siendo válido
  // porque lo referencian eventos ya persistidos: renombrar la pantalla no
  // puede romper la historia.
  roko: "Roku",
  marques: "Marqués",
  cordera: "Cordera",
  opus: "Opus",
  codex: "Codex",
  claude: "Claude",
  gemini: "Gemini",
};

export const HERO_CLASS: Record<HeroId, string> = {
  roko: "Guardián / Bruiser",
  marques: "Explorador / DPS",
  cordera: "Sanadora / Apoyo",
  opus: "Asesino de Automatización",
  codex: "Ingeniero / Rompedor",
  claude: "Arquitecto / Forjador",
  gemini: "Oráculo / Testigo",
};

/**
 * REGISTRO DE CAPACIDADES.
 *
 * Configurable a propósito: mañana puede aparecer otro agente con otras manos.
 * Nada aquí concede autorización; sólo describe para qué sirve pedirle ayuda.
 */
export const HERO_CAPABILITIES: Record<HeroId, string[]> = {
  roko: ["defensa del frente", "resistencia"],
  marques: ["ejecución del jugador", "impacto validado"],
  cordera: ["sostén", "cuidado del grupo"],
  opus: ["operaciones legales", "Gmail", "Drive", "portales de cliente", "gestión de casos"],
  codex: ["implementación", "pruebas", "depuración", "transformaciones de código"],
  claude: ["arquitectura", "implementación", "refactors", "backend y frontend"],
  gemini: ["visión", "lectura de evidencia", "interpretación de documentos e imágenes"],
};

/**
 * HABILIDADES — SÓLO EL BOUNDARY.
 *
 * No hay árbol de habilidades y no hay botón de ATACAR: una habilidad se
 * enciende desde un hecho real del Core, nunca desde un toque en la pantalla.
 */
export const HERO_ABILITIES: Record<HeroId, HeroAbilityView[]> = {
  roko: [{ id: "guardia_fiel", name: "Guardia Fiel", description: "Recupera escudo cuando el reino valida un resultado.", triggeredBy: "evidencia aceptada" }],
  marques: [{ id: "disparo_certero", name: "Disparo Certero", description: "El impacto validado cae sobre enemigos concretos.", triggeredBy: "evidencia aceptada" }],
  cordera: [{ id: "pulso_de_luz", name: "Pulso de Luz", description: "Sostiene al aliado más herido tras un avance real.", triggeredBy: "evidencia aceptada" }],
  opus: [{ id: "ejecucion_automatizada", name: "Ejecución Automatizada", description: "Convierte una ejecución real validada en ataque combinado.", triggeredBy: "assist validado" }],
  codex: [{ id: "ruptura_de_build", name: "Ruptura de Build", description: "Ataque combinado sobre pasos de ingeniería validados.", triggeredBy: "assist validado" }],
  claude: [{ id: "segunda_forja", name: "Segunda Forja", description: "Ataque combinado sobre pasos de construcción validados.", triggeredBy: "assist validado" }],
  gemini: [{ id: "ojo_del_oraculo", name: "Ojo del Oráculo", description: "Ataque combinado cuando la lectura de una prueba se acepta.", triggeredBy: "assist validado" }],
};

/** Dominios de maestría por defecto de cada agente. Se suman por outcome. */
export const HERO_DEFAULT_MASTERY: Partial<Record<HeroId, string>> = {
  opus: "Legal Ops",
  codex: "Engineering",
  claude: "Architecture",
  gemini: "Evidence Reading",
};

export const PARTY_HERO_IDS: PartyMemberId[] = ["roko", "marques", "cordera"];
export const AGENT_HERO_IDS: CompanionId[] = ["opus", "claude", "codex", "gemini"];
export const ALL_HERO_IDS: HeroId[] = [...PARTY_HERO_IDS, ...AGENT_HERO_IDS];

export function heroKindOf(id: HeroId): HeroKind {
  return (PARTY_HERO_IDS as string[]).includes(id) ? "party" : "agent";
}

/**
 * CURVA DE NIVEL.
 *
 * Cuadrática suave: subir cuesta cada vez un poco más, y ningún nivel concede
 * permisos. Config en un solo sitio para que no haya reglas dispersas.
 */
export const LEVEL_BASE_XP = 100;
export const LEVEL_GROWTH = 60;
export const MAX_HERO_LEVEL = 50;

/** XP total necesaria para ALCANZAR `level` (nivel 1 = 0). */
export function xpForLevel(level: number): number {
  const target = Math.max(1, Math.min(MAX_HERO_LEVEL, Math.round(level)));
  let total = 0;
  for (let step = 1; step < target; step += 1) {
    total += LEVEL_BASE_XP + LEVEL_GROWTH * (step - 1);
  }
  return total;
}

export function levelForXp(xp: number): number {
  const points = Math.max(0, Math.round(xp));
  let level = 1;
  while (level < MAX_HERO_LEVEL && points >= xpForLevel(level + 1)) level += 1;
  return level;
}

export function levelProgress(xp: number): { level: number; xpIntoLevel: number; xpToNextLevel: number } {
  const level = levelForXp(xp);
  const floor = xpForLevel(level);
  if (level >= MAX_HERO_LEVEL) return { level, xpIntoLevel: 0, xpToNextLevel: 0 };
  const ceiling = xpForLevel(level + 1);
  return { level, xpIntoLevel: Math.max(0, xp - floor), xpToNextLevel: ceiling - floor };
}

/**
 * FUENTES DE XP.
 *
 * Todas exigen un hecho validado. Abrir la app, hacer clics o mandar mensajes
 * no aparecen aquí y no aparecerán.
 */
export const XP_REWARDS = {
  /** El grupo entró de verdad a un frente con reloj. */
  battleEntered: 5,
  /** El contrato quedó validado al 100%. */
  questCompleted: 25,
  /** Una campaña entera cayó. */
  campaignCompleted: 60,
  /** Una ejecución real de un agente, todavía sin validar. */
  agentExecution: 3,
  /** Evidencia aceptada que citó la ejecución del agente. */
  agentValidatedAssist: 15,
} as const;

export function freshCareerStats(): HeroCareerStats {
  return {
    battlesEntered: 0,
    battlesWon: 0,
    questsCompleted: 0,
    campaignsCompleted: 0,
    validatedImpact: 0,
    executions: 0,
    successfulExecutions: 0,
    validatedAssists: 0,
    supportedImpact: 0,
    questsAssisted: 0,
    battlesWonWithParty: 0,
  };
}

/**
 * Un héroe nace CONOCIDO y sin estadísticas inventadas.
 *
 * Que Claude exista en el registro no significa que haya peleado: sus
 * contadores empiezan en cero y ahí se quedan hasta que ejecute algo real.
 */
export function freshHero(id: HeroId, timestamp: string): HeroCareerState {
  return {
    id,
    kind: heroKindOf(id),
    xp: 0,
    level: 1,
    masteries: {},
    stats: freshCareerStats(),
    known: true,
    availability: heroKindOf(id) === "party" ? "connected" : "unknown",
    firstSeenAt: timestamp,
    deeds: [],
  };
}
