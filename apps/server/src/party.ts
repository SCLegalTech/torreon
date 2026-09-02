import type { GameEvent, PartyMemberId, PartyState, Quest } from "./domain.js";

/**
 * ROKO PROTEGE. MARQUÉS ATACA. CORDERA SOSTIENE. LA HORDA PRESIONA.
 *
 * El grupo no se guarda: se deriva reproduciendo los GameEvents de la Battle
 * en curso. Así el estado del combate nunca puede desincronizarse del historial
 * que lo produjo, y Unity podrá reconstruirlo con los mismos eventos.
 */

export const PARTY_MAX_HEALTH = 100;
/** Roko no es tanque puro: mitiga, no absorbe indefinidamente. */
export const ROKO_MAX_SHIELD = 20;
/** Cada resultado validado devuelve algo de escudo y algo de vida. */
export const SHIELD_PER_VALIDATED_IMPACT = 5;
export const HEAL_PER_VALIDATED_IMPACT = 5;

/** Diez ventanas de ataque por Battle: el intervalo es duración / 10. */
export const HORDE_ATTACK_SLOTS = 10;
export const HORDE_BASE_DAMAGE = 10;
export const HORDE_CRITICAL_MULTIPLIER = 1.5;
export const HORDE_CRITICAL_CHANCE = 0.2;

export const PARTY_ORDER: PartyMemberId[] = ["roko", "marques", "cordera"];

const PROFILE: Record<PartyMemberId, { name: string; role: string; maxShield?: number }> = {
  roko: { name: "Roko", role: "Bruiser / Guardia", maxShield: ROKO_MAX_SHIELD },
  marques: { name: "Marqués", role: "Arquero / DPS" },
  cordera: { name: "Cordera", role: "Sanadora / Apoyo" },
};

export function freshParty(): PartyState {
  const member = (id: PartyMemberId) => ({
    id,
    name: PROFILE[id].name,
    role: PROFILE[id].role,
    health: PARTY_MAX_HEALTH,
    maxHealth: PARTY_MAX_HEALTH,
    shield: PROFILE[id].maxShield,
    maxShield: PROFILE[id].maxShield,
    status: "active" as const,
  });
  return { roko: member("roko"), marques: member("marques"), cordera: member("cordera") };
}

/**
 * RNG AUTORITATIVO.
 *
 * El crítico NO lo decide el renderer. Se deriva de `combatSeed + intento +
 * índice de ataque`, así que cerrar y reabrir la app no vuelve a tirar el dado:
 * la misma Battle produce siempre la misma secuencia.
 */
function hash32(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 0 <= valor < 1, determinista para la misma clave. */
export function seededUnit(seed: string, attempt: number, attackIndex: number): number {
  return hash32(`${seed}:${attempt}:${attackIndex}`) / 0x1_0000_0000;
}

export interface HordeRoll {
  attackIndex: number;
  critical: boolean;
  damage: number;
}

export function rollHordeAttack(seed: string, attempt: number, attackIndex: number): HordeRoll {
  const critical = seededUnit(seed, attempt, attackIndex) < HORDE_CRITICAL_CHANCE;
  return {
    attackIndex,
    critical,
    damage: critical ? Math.round(HORDE_BASE_DAMAGE * HORDE_CRITICAL_MULTIPLIER) : HORDE_BASE_DAMAGE,
  };
}

/**
 * TARGETING MVP: sin tablas de amenaza.
 * Roko aguanta el frente mientras viva; después cae sobre el Marqués.
 */
export function nextTarget(party: PartyState): PartyMemberId {
  return PARTY_ORDER.find((id) => party[id].health > 0) ?? "marques";
}

/** Escudo primero, vida después. Devuelve cuánto absorbió el escudo. */
export function applyDamage(party: PartyState, target: PartyMemberId, damage: number): { absorbed: number; toHealth: number } {
  const member = party[target];
  const absorbed = member.shield !== undefined ? Math.min(member.shield, damage) : 0;
  if (member.shield !== undefined) member.shield -= absorbed;
  const toHealth = Math.max(0, damage - absorbed);
  member.health = Math.max(0, member.health - toHealth);
  member.status = member.health === 0 ? "ko" : "active";
  return { absorbed, toHealth };
}

/** Cordera cura al aliado VIVO con menor porcentaje de vida. No resucita. */
export function healTarget(party: PartyState): PartyMemberId | null {
  if (party.cordera.health === 0) return null;
  const candidates = PARTY_ORDER.filter((id) => party[id].health > 0 && party[id].health < party[id].maxHealth);
  if (candidates.length === 0) return null;
  return candidates.reduce((lowest, id) =>
    party[id].health / party[id].maxHealth < party[lowest].health / party[lowest].maxHealth ? id : lowest,
  );
}

/**
 * Reconstruye el grupo reproduciendo los eventos de ESTE intento de Battle.
 *
 * Sólo tres tipos mueven el estado: el golpe de la Horda, la cura de Cordera y
 * el escudo de Roko. `shield_absorbed` y `party_member_ko` son narrativa para
 * el renderer, no fuentes de verdad; contarlos duplicaría el efecto.
 */
export function partyFor(quest: Quest, gameEvents: GameEvent[]): PartyState {
  const party = freshParty();
  const attempt = quest.battle?.attempt ?? 1;
  const own = gameEvents
    .filter((event) => event.questId === quest.id && (event.battleAttempt ?? 1) === attempt)
    .slice()
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  for (const event of own) {
    if (event.type === "horde_attack") {
      // Los reinos anteriores al grupo golpeaban directamente al Marqués.
      applyDamage(party, event.target ?? "marques", event.damage);
    } else if (event.type === "party_heal" && event.target) {
      const member = party[event.target];
      if (member.health > 0) member.health = Math.min(member.maxHealth, member.health + event.damage);
    } else if (event.type === "shield_gained") {
      const roko = party.roko;
      if (roko.health > 0 && roko.shield !== undefined && roko.maxShield !== undefined) {
        roko.shield = Math.min(roko.maxShield, roko.shield + event.damage);
      }
    }
  }

  for (const id of PARTY_ORDER) party[id].status = party[id].health === 0 ? "ko" : "active";
  return party;
}
