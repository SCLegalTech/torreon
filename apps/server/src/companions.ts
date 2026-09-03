import type { AgentSlot, CompanionAssist, CompanionId } from "./domain.js";
import { HERO_CLASS, HERO_DISPLAY_NAME } from "./progression.js";

/**
 * LOS ALIADOS SÓLO AYUDAN SI REALMENTE LUCHARON.
 *
 * Un compañero disponible no es un compañero que peleó. El cuarto slot del
 * grupo sólo se llena cuando una herramienta real se ejecutó de verdad, y el
 * bonus sólo llega cuando esa contribución termina en evidencia aceptada.
 */

export interface CompanionProfile {
  id: CompanionId;
  name: string;
  role: string;
  affinities: string[];
}

export const COMPANIONS: Record<CompanionId, CompanionProfile> = {
  opus: { id: "opus", name: HERO_DISPLAY_NAME.opus, role: HERO_CLASS.opus, affinities: ["solve-coagula", "legaltech", "automation"] },
  codex: { id: "codex", name: HERO_DISPLAY_NAME.codex, role: HERO_CLASS.codex, affinities: ["development", "software"] },
  claude: { id: "claude", name: HERO_DISPLAY_NAME.claude, role: HERO_CLASS.claude, affinities: ["development", "planning"] },
  gemini: { id: "gemini", name: HERO_DISPLAY_NAME.gemini, role: HERO_CLASS.gemini, affinities: ["analysis", "research"] },
};

/** El combo vale una parte del impacto validado, nunca un ataque aparte. */
export const COMPANION_ASSIST_MULTIPLIER = 0.25;

export function emptyAgentSlot(): AgentSlot {
  return { deployed: false, status: "undeployed", secondaryAssists: [], comboDamage: 0 };
}

/**
 * Despliega el cuarto slot con el primer compañero que ejecutó algo real.
 * Los siguientes quedan como apoyos secundarios: la formación sigue siendo
 * de cuatro, no de seis.
 */
export function deployAgent(agent: AgentSlot, companion: CompanionId): boolean {
  if (!agent.deployed) {
    const profile = COMPANIONS[companion];
    agent.deployed = true;
    agent.companion = companion;
    agent.name = profile.name;
    agent.role = profile.role;
    agent.status = "assist_ready";
    return true;
  }
  if (agent.companion !== companion && !agent.secondaryAssists.includes(companion)) {
    agent.secondaryAssists.push(companion);
  }
  if (agent.status === "undeployed") agent.status = "assist_ready";
  return false;
}

/**
 * Cuánto suma el combo de este paso.
 *
 * NO BONUS POR SPAM: cada compañero cuenta como mucho una vez por paso, así
 * que diez llamadas a Opus siguen valiendo un solo ataque combinado.
 */
export function pendingAssistsFor(assists: CompanionAssist[], questId: string, stepId: string): CompanionAssist[] {
  const seen = new Set<CompanionId>();
  return assists.filter((assist) => {
    if (assist.questId !== questId || assist.stepId !== stepId) return false;
    if (assist.status !== "used_pending_validation") return false;
    if (seen.has(assist.companion)) return false;
    seen.add(assist.companion);
    return true;
  });
}

/**
 * TECHO DEL COMBO.
 *
 * Aunque cuatro compañeros toquen el mismo paso, el apoyo NUNCA puede valer más
 * que la mitad del resultado real: el trabajo verificado sigue siendo la fuente
 * del daño, y llamar agentes en cadena no es una vía de progreso.
 */
export const COMPANION_COMBO_CAP_MULTIPLIER = 0.5;

export function comboDamageFor(impactAwarded: number, assistCount: number, jammed: boolean): number {
  if (assistCount === 0 || impactAwarded <= 0) return 0;
  // Un compañero cuenta como mucho UNA vez por paso; el resto es techo duro.
  const raw = Math.round(impactAwarded * COMPANION_ASSIST_MULTIPLIER) * assistCount;
  const capped = Math.min(raw, Math.max(1, Math.round(impactAwarded * COMPANION_COMBO_CAP_MULTIPLIER)));
  // Un Saboteador vivo recorta el combo una vez; no borra la contribución.
  return jammed ? Math.floor(capped / 2) : capped;
}

/**
 * SAME REAL EXECUTION -> SAME ASSIST RECORD.
 *
 * Con `executionRef` la identidad es exacta. Sin ella, la misma herramienta
 * sobre el mismo paso dentro de una ventana corta se considera el MISMO hecho:
 * un reintento técnico no puede fabricar historia.
 */
export const ASSIST_DEDUPE_WINDOW_MS = 10 * 60_000;

export function assistKeyFor(input: {
  questId: string;
  stepId: string;
  companion: CompanionId;
  executionRef?: string;
  sourceTool?: string;
}): string {
  const base = `${input.questId}:${input.stepId}:${input.companion}`;
  if (input.executionRef?.trim()) return `${base}:exec:${input.executionRef.trim()}`;
  return `${base}:tool:${input.sourceTool?.trim() || "unspecified"}`;
}

/** Busca el registro que ya representa esta misma ejecución real, si existe. */
export function findExistingAssist(
  assists: CompanionAssist[],
  key: string,
  hasExecutionRef: boolean,
  nowMs: number,
): CompanionAssist | undefined {
  return assists.find((assist) => {
    if (assist.assistKey !== key) return false;
    // Con referencia de ejecución la identidad no caduca: es el mismo hecho.
    if (hasExecutionRef) return true;
    return nowMs - Date.parse(assist.createdAt) <= ASSIST_DEDUPE_WINDOW_MS;
  });
}
