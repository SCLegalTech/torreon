import { randomUUID } from "node:crypto";
import { isoAt } from "./clock.js";
import type { RealmState } from "./domain.js";
import { deny, notFound } from "./errors.js";
import { addEvent, pushGameEvent } from "./realm-events.js";
import { applyDamage, freshParty } from "./party.js";
import { enemyTarget as enemyTargetFor } from "./horde.js";
import { resolve as resolveBattle } from "./battle.js";
import type { PartyMemberId, Quest, QuestStep } from "./domain.js";

/**
 * NI UN REINTENTO NI EL RELOJ SON EXIGENCIAS NUEVAS.
 *
 * La presión temporal ya la cobra el servidor por ventanas. Dejar que además se
 * cobre a mano por «tardó mucho» sería castigar dos veces lo mismo, y eso es
 * mentirle al jugador sobre por qué perdió vida.
 */
const FORBIDDEN_REQUIREMENT_REASON =
  /\b(reintent\w*|retry|reintento|timeout|time-?out|latenc\w*|debug\w*|depurac\w*|duplicad\w*|duplicate|stack ?trace|500|502|503|rate ?limit|tard\w+ (mucho|demasiado)|se demor\w+|tiempo (transcurrido|agotado)|error (t[eé]cnico|de red|de conexi[oó]n))\b/i;

function requireQuest(state: RealmState, questId: string): Quest {
  const quest = state.quests.find((candidate) => candidate.id === questId);
  if (!quest) throw notFound(`Quest no encontrada: ${questId}`);
  return quest;
}

function requireStep(quest: Quest, stepId: string): QuestStep {
  const step = quest.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw notFound(`Paso no encontrado: ${stepId}`);
  return step;
}

/**
 * LA HORDA SÓLO GOLPEA POR UNA EXIGENCIA REAL.
 *
 * `unexpected_requirement` representa una condición nueva e imprevista que
 * AUMENTA el trabajo del jugador. Jamás puede nacer de un reintento de
 * herramienta, de una traza de depuración, de latencia, de un assist
 * duplicado ni del simple paso del tiempo: la presión temporal ya la cobra el
 * propio servidor por ventanas, y castigar dos veces lo mismo sería mentir.
 */
export interface PressureOutcome {
  lifeEventId: string;
  gameEventId: string;
  /** A quién alcanzó el golpe. La formación decide, no el azar del cliente. */
  target: PartyMemberId;
  /** `true` si el golpe dejó al Marqués en el suelo y cerró el intento. */
  marquesKo: boolean;
}

export function recordUnexpectedRequirement(
  state: RealmState,
  questId: string,
  input: { reason: string; damage: number; stepId?: string },
  nowMs: number,
): PressureOutcome {
  if (input.reason.trim().length < 10) throw deny("Describe el requisito inesperado que representa este ataque.");
  if (!Number.isInteger(input.damage) || input.damage < 1 || input.damage > 50) throw deny("El daño debe ser un entero entre 1 y 50.");
  if (FORBIDDEN_REQUIREMENT_REASON.test(input.reason)) {
    throw deny(
      "Un reintento, un error técnico, la latencia, un assist duplicado o el tiempo transcurrido NO son exigencias nuevas de la realidad. La presión del reloj ya la cobra el servidor: no la cobres otra vez a mano.",
    );
  }

  const quest = requireQuest(state, questId);
  if (quest.status !== "active") throw deny("La Horda sólo puede atacar un frente activo con presión real; una espera externa no recibe daño automático.");
  if (input.stepId) requireStep(quest, input.stepId);
  const timestamp = isoAt(nowMs);
  const lifeEventId = randomUUID();
  state.lifeEvents.unshift({ id: lifeEventId, type: "unexpected_requirement", questId, stepId: input.stepId, reason: input.reason.trim(), createdAt: timestamp });
  const gameEventId = randomUUID();
  // Un requisito inesperado golpea el frente igual que el reloj: cae sobre
  // quien la formación deje expuesto, y el escudo se gasta antes que la vida.
  const record = quest.battle;
  const party = record?.party ?? freshParty();
  const attacker = record?.enemies.find((enemy) => enemy.status === "active");
  const target: PartyMemberId = attacker
    ? enemyTargetFor(attacker, party, record!.combatSeed, record!.attempt)
    : party.roko.health > 0
      ? "roko"
      : "marques";
  const { absorbed, ko } = applyDamage(party, target, input.damage);
  state.gameEvents.unshift({
    id: gameEventId,
    type: "horde_attack",
    sourceLifeEventId: lifeEventId,
    questId,
    stepId: input.stepId,
    damage: input.damage,
    reason: input.reason.trim(),
    battleAttempt: record?.attempt ?? 1,
    target,
    sourceEnemyId: attacker?.id,
    message: `La Horda contraataca sobre ${party[target].name}: ${input.reason.trim()} (-${input.damage}).`,
    createdAt: timestamp,
    });
  if (absorbed > 0) {
    state.gameEvents.unshift({
      id: randomUUID(),
      type: "shield_absorbed",
      sourceLifeEventId: lifeEventId,
      questId,
      damage: absorbed,
      target,
      battleAttempt: record?.attempt ?? 1,
      message: `El escudo de ${party[target].name} absorbe ${absorbed}.`,
      createdAt: timestamp,
    });
  }
  if (ko) {
    state.gameEvents.unshift({
      id: randomUUID(),
      type: "party_member_ko",
      sourceLifeEventId: lifeEventId,
      questId,
      damage: 0,
      target,
      battleAttempt: record?.attempt ?? 1,
      message: `${party[target].name} cae en el frente.`,
      createdAt: timestamp,
    });
  }
  state.lifeEvents = state.lifeEvents.slice(0, 200);
  state.gameEvents = state.gameEvents.slice(0, 200);
  addEvent(
    state,
    {
      type: "horde_attack",
      questId,
      message: `La Horda golpea a ${party[target].name} (-${input.damage}). El grupo encaja el golpe.`,
    },
    nowMs,
  );
  // EL MARQUÉS EN EL SUELO CIERRA EL INTENTO. La proyección de la Battle la
  // compone el servicio: aquí se decide, no se dibuja.
  const marquesKo = party.marques.health <= 0;
  if (marquesKo && record?.status === "active") {
    resolveBattle(state, quest, record, "awaiting_recovery", nowMs);
  }
  return { lifeEventId, gameEventId, target, marquesKo };
}
