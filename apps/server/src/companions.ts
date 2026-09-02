import type { AgentSlot, CompanionAssist, CompanionId } from "./domain.js";

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
  opus: { id: "opus", name: "Opus", role: "Asesino de Automatización", affinities: ["solve-coagula", "legaltech", "automation"] },
  codex: { id: "codex", name: "Codex", role: "Asesino de Ingeniería", affinities: ["development", "software"] },
  claude: { id: "claude", name: "Claude", role: "Asesino Estratega", affinities: ["development", "planning"] },
  gemini: { id: "gemini", name: "Gemini", role: "Asesino Oráculo", affinities: ["analysis", "research"] },
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

export function comboDamageFor(impactAwarded: number, assistCount: number, jammed: boolean): number {
  if (assistCount === 0 || impactAwarded <= 0) return 0;
  const raw = Math.round(impactAwarded * COMPANION_ASSIST_MULTIPLIER) * assistCount;
  // Un Saboteador vivo recorta el combo una vez; no borra la contribución.
  return jammed ? Math.floor(raw / 2) : raw;
}
