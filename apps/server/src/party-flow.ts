import { randomUUID } from "node:crypto";
import { isoAt } from "./clock.js";
import type { BattleState, PartyMemberId, RealmState } from "./domain.js";
import { deny } from "./errors.js";
import { recoverFallen } from "./party.js";
import { recoveryOfferFor } from "./read-models.js";
import { addEvent } from "./realm-events.js";

/**
 * LA RETIRADA TÁCTICA.
 *
 * Extraída de `quest-service.ts` (artículo 9). Es la última ruta legal cuando
 * ya no queda ninguna dentro: el Marqués cayó y el frente no puede seguir.
 *
 * No concede progreso, no crea evidencia, no devuelve objetos y —esto es lo
 * importante— **no revive dentro del intento**: lo cierra, y deja al grupo con
 * el mínimo de reentrada. Volver del suelo nunca ocurre dentro del intento que
 * lo tumbó.
 */
export interface RecoveryOutcome {
  raised: PartyMemberId[];
  minHealth: number;
  questTitle: string;
}

export function recoverParty(state: RealmState, questId: string, nowMs: number): RecoveryOutcome {
  const offer = recoveryOfferFor(state, questId);
  if (!offer.available) throw deny(offer.reason ?? "La retirada táctica no está disponible ahora.");
  const quest = state.quests.find((candidate) => candidate.id === questId);
  if (!quest?.battle) throw deny("Este frente no tiene una Battle que recuperar.");

  const record = quest.battle;
  const raised = recoverFallen(record.party);
  const timestamp = isoAt(nowMs);

  // El intento se cierra: volver del suelo NUNCA ocurre dentro del mismo.
  const current = record.attempts.find((attempt) => attempt.attempt === record.attempt);
  if (current && !current.endedAt) {
    current.endedAt = timestamp;
    current.endReason = "timeout";
  }
  // El frente sigue esperando un pacto nuevo: retirarse no lo reabre solo.
  record.status = "awaiting_replan";
  quest.updatedAt = timestamp;

  const names = raised.map((id) => record.party[id].name).join(", ");
  state.gameEvents.unshift({
    id: randomUUID(),
    type: "party_member_revived",
    questId,
    damage: 0,
    battleAttempt: record.attempt,
    message: `Retirada táctica: ${names} vuelve(n) de las Barracas con ${offer.minHealth} HP.`,
    createdAt: timestamp,
  });
  state.gameEvents = state.gameEvents.slice(0, 200);
  addEvent(
    state,
    {
      type: "battle_restarted",
      questId,
      message:
        `Retirada táctica de «${quest.title}»: ${names} se recupera(n) en las Barracas hasta ${offer.minHealth} HP. ` +
        "El progreso validado, la Horda, las heridas del resto y el zurrón siguen exactamente como estaban.",
    },
    nowMs,
  );

  return { raised, minHealth: offer.minHealth, questTitle: quest.title };
}

export type { BattleState };
