import { randomUUID } from "node:crypto";
import type {
  AgentDeploymentState,
  BarracksView,
  CompanionId,
  HeroCareerState,
  HeroDeed,
  HeroId,
  HeroProfileView,
  LastFormationView,
  MasteryBreakdown,
  Quest,
  RealmState,
} from "./domain.js";
import {
  ALL_HERO_IDS,
  AGENT_HERO_IDS,
  HERO_ABILITIES,
  HERO_CAPABILITIES,
  HERO_CLASS,
  HERO_DISPLAY_NAME,
  PARTY_HERO_IDS,
  freshHero,
  heroKindOf,
  levelProgress,
} from "./progression.js";

/**
 * 🛡️ BARRACAS.
 *
 * No es inventario, no es Campaña y no es historial de Battles: es donde vive
 * la representación persistente del jugador, sus compañeros y sus agentes.
 *
 * Códice NO ocupa slot de héroe. Es Dungeon Master, intérprete y orquestador.
 */

const now = () => new Date().toISOString();
const LEDGER_LIMIT = 800;
const DEEDS_PER_HERO = 30;

export function ensureHero(state: RealmState, heroId: HeroId, timestamp = now()): HeroCareerState {
  state.heroes ??= {};
  const existing = state.heroes[heroId];
  if (existing) return existing;
  const hero = freshHero(heroId, timestamp);
  state.heroes[heroId] = hero;
  return hero;
}

/** Deja el roster base reconocido sin fabricarle estadísticas a nadie. */
export function ensureRoster(state: RealmState, timestamp = now()): void {
  for (const heroId of ALL_HERO_IDS) ensureHero(state, heroId, timestamp);
}

/**
 * RETRIES MUST NOT CREATE FAKE HISTORY.
 *
 * Devuelve `false` —y no ejecuta nada— si esta recompensa ya se concedió. Un
 * reintento de red, un doble POST o un redeploy encuentran su clave y pasan de
 * largo: ni XP doble, ni stats dobles, ni hazaña duplicada.
 */
export function claimOnce(state: RealmState, key: string): boolean {
  state.progressionLedger ??= [];
  if (state.progressionLedger.includes(key)) return false;
  state.progressionLedger.unshift(key);
  state.progressionLedger = state.progressionLedger.slice(0, LEDGER_LIMIT);
  return true;
}

export interface HeroXpGrant {
  heroId: HeroId;
  xp: number;
  level: number;
  leveledUp: boolean;
}

/**
 * Concede XP a un héroe UNA sola vez por clave.
 *
 * La clave describe el hecho real («assist:<id>», «quest_completed:<id>»), así
 * que el mismo hecho nunca puede pagar dos veces.
 */
export function grantHeroXp(state: RealmState, heroId: HeroId, amount: number, key: string): HeroXpGrant | null {
  if (amount <= 0) return null;
  if (!claimOnce(state, `xp:${heroId}:${key}`)) return null;
  const hero = ensureHero(state, heroId);
  const before = levelProgress(hero.xp).level;
  hero.xp += Math.round(amount);
  const after = levelProgress(hero.xp).level;
  hero.level = after;
  return { heroId, xp: hero.xp, level: after, leveledUp: after > before };
}

/** Una maestría sube por outcome validado relacionado. Nunca por un número mágico. */
export function grantMastery(state: RealmState, heroId: HeroId, domain: string | undefined, key: string): void {
  const clean = domain?.trim();
  if (!clean) return;
  if (!claimOnce(state, `mastery:${heroId}:${clean}:${key}`)) return;
  const hero = ensureHero(state, heroId);
  hero.masteries[clean] = (hero.masteries[clean] ?? 0) + 1;
}

/** Una hazaña SIEMPRE cita un hecho: quest, paso, herramienta y veredicto. */
export function recordDeed(state: RealmState, deed: Omit<HeroDeed, "id" | "createdAt">, key: string): HeroDeed | null {
  if (!claimOnce(state, `deed:${deed.heroId}:${key}`)) return null;
  const hero = ensureHero(state, deed.heroId);
  const record: HeroDeed = { ...deed, id: randomUUID(), createdAt: now() };
  hero.deeds.unshift(record);
  hero.deeds = hero.deeds.slice(0, DEEDS_PER_HERO);
  hero.lastQuestId = deed.questId;
  return record;
}

/**
 * ESTADO DE DESPLIEGUE.
 *
 * `Opus instalado ≠ Opus participó`. Sólo una ejecución real da `participated`,
 * y sólo una evidencia aceptada que la cite da `contribution_validated`.
 */
export function deploymentStateOf(state: RealmState, hero: HeroCareerState, deployedAgent: CompanionId | null): AgentDeploymentState {
  if (hero.kind === "party") return "deployed";
  if (hero.availability === "unavailable") return "unavailable";
  if (deployedAgent === hero.id) return "deployed";
  if (hero.stats.validatedAssists > 0) return "contribution_validated";
  if (hero.stats.executions > 0) return "participated";
  if (hero.availability === "connected" || hero.availability === "available") return "available";
  return "known";
}

/**
 * MASTERY MUST BE EXPLAINABLE.
 *
 * Si la pantalla dice «Opus — Legal Ops 4», aquí está de dónde salió: assists
 * validados, Battles asistidas y las herramientas que de verdad se ejecutaron.
 */
export function masteryBreakdownFor(hero: HeroCareerState): MasteryBreakdown[] {
  const toolCounts = new Map<string, number>();
  for (const deed of hero.deeds) {
    if (!deed.sourceTool) continue;
    toolCounts.set(deed.sourceTool, (toolCounts.get(deed.sourceTool) ?? 0) + 1);
  }
  const shared: string[] = [];
  if (hero.kind === "agent") {
    if (hero.stats.validatedAssists > 0) shared.push(`${hero.stats.validatedAssists} assist(s) validados`);
    if (hero.stats.questsAssisted > 0) shared.push(`${hero.stats.questsAssisted} Battle(s) asistidas`);
    if (hero.stats.successfulExecutions > 0) shared.push(`${hero.stats.successfulExecutions} ejecución(es) con éxito`);
  } else {
    if (hero.stats.battlesWon > 0) shared.push(`${hero.stats.battlesWon} Battle(s) ganadas`);
    if (hero.stats.questsCompleted > 0) shared.push(`${hero.stats.questsCompleted} Quest(s) completadas`);
    if (hero.stats.validatedImpact > 0) shared.push(`${hero.stats.validatedImpact} de impacto validado`);
  }
  for (const [tool, count] of toolCounts) shared.push(`${count} × ${tool}`);

  return Object.entries(hero.masteries)
    .map(([domain, points]) => ({ domain, points, evidence: shared.slice(0, 6) }))
    .sort((a, b) => b.points - a.points);
}

export function heroProfileFor(state: RealmState, hero: HeroCareerState, deployedAgent: CompanionId | null): HeroProfileView {
  const progress = levelProgress(hero.xp);
  return {
    id: hero.id,
    kind: hero.kind,
    displayName: HERO_DISPLAY_NAME[hero.id] ?? hero.id,
    className: HERO_CLASS[hero.id] ?? "",
    level: progress.level,
    xp: hero.xp,
    xpIntoLevel: progress.xpIntoLevel,
    xpToNextLevel: progress.xpToNextLevel,
    availability: hero.availability,
    deployment: deploymentStateOf(state, hero, deployedAgent),
    stats: hero.stats,
    masteries: masteryBreakdownFor(hero),
    capabilities: HERO_CAPABILITIES[hero.id] ?? [],
    abilities: HERO_ABILITIES[hero.id] ?? [],
    recentDeeds: hero.deeds.slice(0, 8),
    lastDeployedAt: hero.lastDeployedAt,
  };
}

/** La última formación que peleó de verdad, con el resultado de esa Battle. */
export function lastFormationFor(state: RealmState): LastFormationView | null {
  const withBattle = state.quests
    .filter((quest) => Boolean(quest.battle))
    .sort((a, b) => Date.parse(b.battle!.startedAt) - Date.parse(a.battle!.startedAt));
  const quest: Quest | undefined = withBattle[0];
  if (!quest?.battle) return null;
  const agent = quest.battle.agent;
  const heroes: LastFormationView["heroes"] = PARTY_HERO_IDS.map((id) => ({
    id,
    displayName: HERO_DISPLAY_NAME[id],
    kind: "party" as const,
  }));
  if (agent.deployed && agent.companion) {
    heroes.push({ id: agent.companion, displayName: HERO_DISPLAY_NAME[agent.companion], kind: "agent" });
  }
  return {
    questId: quest.id,
    questTitle: quest.title,
    result: quest.status === "completed" ? "victory" : quest.battle.status === "active" ? "in_progress" : "unresolved",
    heroes,
    endedAt: quest.battle.endedAt,
  };
}

/**
 * Vista completa de Barracas.
 *
 * Un héroe sin historia aparece igual —conocido, sin estadísticas inventadas—
 * y un conector caído NO borra al héroe ni sus hazañas: sólo lo marca.
 */
export function barracksViewFor(state: RealmState): BarracksView {
  const engaged = state.quests.find((quest) => quest.status === "active" && quest.battle?.status === "active");
  const deployedAgent = engaged?.battle?.agent.deployed ? engaged.battle.agent.companion ?? null : null;
  const heroes = ALL_HERO_IDS.map((id) => {
    const hero = state.heroes?.[id] ?? freshHero(id, state.updatedAt);
    return heroProfileFor(state, hero, deployedAgent);
  });
  return { heroes, lastFormation: lastFormationFor(state) };
}

/** Agentes que el reino reconoce hoy. Usado para el aviso de nuevo aliado. */
export function knownAgents(state: RealmState): CompanionId[] {
  return AGENT_HERO_IDS.filter((id) => Boolean(state.heroes?.[id]?.known));
}

export { heroKindOf };
