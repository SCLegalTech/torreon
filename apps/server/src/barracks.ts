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
  HERO_DEFAULT_MASTERY,
  HERO_DISPLAY_NAME,
  PARTY_HERO_IDS,
  XP_REWARDS,
  freshHero,
  heroKindOf,
  levelForXp,
  levelProgress,
} from "./progression.js";
import { assistKeyFor } from "./companions.js";
import { buildAfterActionReport, storeAfterActionReport, upsertPlaybook } from "./battle-memory.js";

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

// ---------------------------------------------------------------------------
// MIGRACIÓN — LA HISTORIA QUE YA EXISTÍA
//
// Un reino anterior a las Barracas ya tiene historia real: asistencias
// registradas y Quests completadas. Reconstruir la carrera desde ahí es
// legítimo. Inventarla no.
//
// RETRIES MUST NOT CREATE FAKE HISTORY: el registro antiguo contiene llamadas
// repetidas a `record_companion_assist` sobre la MISMA ejecución real, porque
// hasta ahora la API las aceptaba. La reconstrucción las deduplica por su clave
// de ejecución, así que un reintento de red no se convierte en una hazaña.
//
// Si un dato es ambiguo —una asistencia que apunta a una Quest que ya no
// existe— NO SE INVENTA: simplemente no cuenta.
// ---------------------------------------------------------------------------

export function backfillHeroCareer(state: RealmState): boolean {
  if (state.heroesBackfilledAt) return false;
  const timestamp = now();
  ensureRoster(state, timestamp);

  // 1. ASISTENCIAS REALES, una por ejecución.
  //
  // Se agrupan por clave y de cada grupo sobrevive UN registro: el que quedó
  // validado si lo hay, y si no el más antiguo. Elegir por posición en la lista
  // perdería la validación real cuando el reintento llegó después.
  const byKey = new Map<string, (typeof state.companionAssists)[number]>();
  for (const assist of state.companionAssists ?? []) {
    assist.assistKey ??= assistKeyFor(assist);
    const previous = byKey.get(assist.assistKey);
    if (!previous) {
      byKey.set(assist.assistKey, assist);
      continue;
    }
    const previousValidated = previous.status === "contribution_validated";
    const currentValidated = assist.status === "contribution_validated";
    if (currentValidated && !previousValidated) byKey.set(assist.assistKey, assist);
    else if (currentValidated === previousValidated && Date.parse(assist.createdAt) < Date.parse(previous.createdAt)) {
      byKey.set(assist.assistKey, assist);
    }
  }

  const assisted = new Set<string>();
  for (const assist of byKey.values()) {
    const quest = state.quests.find((candidate) => candidate.id === assist.questId);
    if (!quest) continue;

    const hero = ensureHero(state, assist.companion, timestamp);
    hero.availability = "connected";
    hero.lastDeployedAt = assist.createdAt;
    hero.lastQuestId = quest.id;
    if (claimOnce(state, `execution:${assist.id}`)) {
      hero.stats.executions += 1;
      hero.stats.successfulExecutions += 1;
    }
    grantHeroXp(state, assist.companion, XP_REWARDS.agentExecution, `execution:${assist.id}`);
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

    if (assist.status === "contribution_validated") {
      if (claimOnce(state, `validated_assist:${assist.id}`)) {
        hero.stats.validatedAssists += 1;
        hero.stats.supportedImpact += assist.bonusDamage ?? 0;
      }
      grantHeroXp(state, assist.companion, XP_REWARDS.agentValidatedAssist, `validated_assist:${assist.id}`);
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
        },
        `validated:${assist.id}`,
      );
      assisted.add(`${assist.companion}:${quest.id}`);
    }
  }

  for (const pair of assisted) {
    const [companion, questId] = pair.split(":") as [CompanionId, string];
    const quest = state.quests.find((candidate) => candidate.id === questId);
    if (!quest) continue;
    const hero = ensureHero(state, companion, timestamp);
    if (claimOnce(state, `quest_assisted:${companion}:${questId}`)) {
      hero.stats.questsAssisted += 1;
      if (quest.status === "completed") hero.stats.battlesWonWithParty += 1;
    }
    if (quest.status === "completed") {
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
  }

  // 2. EL GRUPO. Una Quest completada es un resultado validado, no un clic.
  for (const quest of state.quests) {
    const validatedImpact = quest.steps.reduce((sum, step) => sum + (step.impactAwarded ?? 0), 0);
    for (const heroId of PARTY_HERO_IDS) {
      const hero = ensureHero(state, heroId, timestamp);
      if (quest.battle && claimOnce(state, `battle_entered:${heroId}:${quest.id}`)) {
        hero.stats.battlesEntered += 1;
      }
      if (quest.battle) grantHeroXp(state, heroId, XP_REWARDS.battleEntered, `battle_entered:${quest.id}`);
      if (quest.status !== "completed") continue;
      if (claimOnce(state, `quest_completed:${heroId}:${quest.id}`)) {
        hero.stats.questsCompleted += 1;
        hero.stats.validatedImpact += validatedImpact;
        if (quest.battle) hero.stats.battlesWon += 1;
        hero.lastQuestId = quest.id;
      }
      grantHeroXp(state, heroId, XP_REWARDS.questCompleted, `quest_completed:${quest.id}`);
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
  }

  for (const campaign of state.campaigns) {
    if (campaign.status !== "completed") continue;
    for (const heroId of PARTY_HERO_IDS) {
      const hero = ensureHero(state, heroId, timestamp);
      if (claimOnce(state, `campaign_completed:${heroId}:${campaign.id}`)) hero.stats.campaignsCompleted += 1;
      grantHeroXp(state, heroId, XP_REWARDS.campaignCompleted, `campaign_completed:${campaign.id}`);
    }
  }

  // 3. MEMORIA DE BATALLA de lo ya ganado: duraciones reales frente a pactadas.
  for (const quest of state.quests) {
    if (quest.status !== "completed" || !quest.battle) continue;
    const report = storeAfterActionReport(state, buildAfterActionReport(state, quest));
    upsertPlaybook(state, quest, report);
  }

  // El nivel se recalcula al final: la carrera manda sobre el número guardado.
  for (const hero of Object.values(state.heroes)) {
    hero.level = levelForXp(hero.xp);
  }

  state.heroesBackfilledAt = timestamp;
  return true;
}
