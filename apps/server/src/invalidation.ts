import { isoAt } from "./clock.js";
import type { RealmState } from "./domain.js";
import { deny, notFound } from "./errors.js";
import { addEvent } from "./realm-events.js";

/**
 * ANULAR UN HECHO REGISTRADO POR ERROR (artículo 3).
 *
 * NO HARD DELETE. El hecho se queda en la auditoría marcado `invalidated`,
 * con quién lo anuló, cuándo y por qué; las proyecciones de gameplay dejan de
 * contarlo. Corregir un error operativo no puede exigir falsificar historia.
 *
 * Si el hecho anulado fue un `unexpected_requirement`, su daño se devuelve al
 * grupo con exactitud —vida y escudo por separado—, porque ese golpe nunca
 * debió existir. Lo que sí es historia real (evidencia validada, impacto,
 * dinero) no se toca aquí y no se toca nunca.
 */
export interface InvalidationInput {
  eventId: string;
  reason: string;
  invalidatedBy?: string;
}

export interface InvalidationOutcome {
  eventId: string;
  type: string;
  healed: number;
  shieldRestored: number;
  message: string;
}

export function invalidateEvent(state: RealmState, input: InvalidationInput, nowMs: number): InvalidationOutcome {
  if (input.reason.trim().length < 10) throw deny("Explica por qué este hecho fue un error operativo antes de anularlo.");

  const timestamp = isoAt(nowMs);
  const by = input.invalidatedBy?.trim().slice(0, 60) || "codice";
  const lifeEvent = (state.lifeEvents ?? []).find((candidate) => candidate.id === input.eventId);
  const gameEvent = (state.gameEvents ?? []).find((candidate) => candidate.id === input.eventId);
  if (!lifeEvent && !gameEvent) throw notFound(`Hecho no encontrado: ${input.eventId}`);
  if (lifeEvent?.status === "invalidated" || gameEvent?.status === "invalidated") {
  throw deny("Ese hecho ya estaba anulado. Anular dos veces no devuelve el doble.");
  }

  let healed = 0;
  let shieldRestored = 0;
  const target = lifeEvent ?? gameEvent!;
  const type = lifeEvent ? lifeEvent.type : gameEvent!.type;

  const stamp = (record: { status?: string; invalidatedAt?: string; invalidatedBy?: string; invalidationReason?: string }) => {
  record.status = "invalidated";
  record.invalidatedAt = timestamp;
  record.invalidatedBy = by;
  record.invalidationReason = input.reason.trim().slice(0, 300);
  };
  stamp(target as never);

  if (lifeEvent) {
  // Los hechos visuales derivados dejan de contar con él.
  const derived = (state.gameEvents ?? []).filter((candidate) => candidate.sourceLifeEventId === lifeEvent.id);
  for (const event of derived) stamp(event as never);

  if (lifeEvent.type === "unexpected_requirement") {
      const quest = state.quests.find((candidate) => candidate.id === lifeEvent.questId);
      const party = quest?.battle?.party;
      const attack = derived.find((event) => event.type === "horde_attack");
      const absorbedEvent = derived.find((event) => event.type === "shield_absorbed");
      if (party && attack?.target) {
        const member = party[attack.target];
        const absorbed = absorbedEvent?.damage ?? 0;
        const toHealth = Math.max(0, attack.damage - absorbed);
        const beforeHealth = member.health;
        member.health = Math.min(member.maxHealth, member.health + toHealth);
        healed = member.health - beforeHealth;
        if (member.maxShield !== undefined && member.shield !== undefined && absorbed > 0) {
          const beforeShield = member.shield;
          member.shield = Math.min(member.maxShield, member.shield + absorbed);
          shieldRestored = member.shield - beforeShield;
        }
        if (member.health > 0) member.status = "active";
      }
  }
  }

  const message =
  healed > 0 || shieldRestored > 0
      ? `Hecho anulado. El grupo recupera ${healed} HP y ${shieldRestored} de escudo que un error operativo le había quitado. La auditoría conserva el registro.`
      : "Hecho anulado. Sigue en la auditoría marcado como inválido y las proyecciones de gameplay dejan de contarlo.";

  addEvent(state, {
  type: "event_invalidated",
  entityType: "quest",
  entityId: (lifeEvent?.questId ?? gameEvent?.questId) || input.eventId,
  message: `Hecho «${type}» anulado por ${by}: ${input.reason.trim()}`,

  }, nowMs);

  return { eventId: input.eventId, type, healed, shieldRestored, message };
}
