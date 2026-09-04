import type { PartyMemberId, PartyState } from "./domain.js";
import { HERO_CLASS, HERO_DISPLAY_NAME } from "./progression.js";

/**
 * ROKU PROTEGE. MARQUÉS ATACA. CORDERA SOSTIENE.
 *
 * El grupo se guarda en la Battle y sobrevive a los replanes: replanificar
 * repacta el tiempo, no borra las cicatrices.
 *
 * NOMBRE VISIBLE ≠ ID INTERNO. El personaje se llama Roku; su id sigue siendo
 * `roko` porque lo referencian eventos ya persistidos. Nunca se rompe historia
 * por renombrar una pantalla: el nombre se resuelve aquí, en la lectura.
 */

export const PARTY_MAX_HEALTH = 100;
/** Roku no es tanque puro: mitiga, no absorbe indefinidamente. */
export const ROKO_MAX_SHIELD = 20;
/** Cada resultado validado devuelve algo de escudo y algo de vida. */
export const SHIELD_PER_VALIDATED_IMPACT = 5;
export const HEAL_PER_VALIDATED_IMPACT = 5;

export const PARTY_ORDER: PartyMemberId[] = ["roko", "marques", "cordera"];

const PROFILE: Record<PartyMemberId, { name: string; role: string; maxShield?: number }> = {
  roko: { name: HERO_DISPLAY_NAME.roko, role: HERO_CLASS.roko, maxShield: ROKO_MAX_SHIELD },
  marques: { name: HERO_DISPLAY_NAME.marques, role: HERO_CLASS.marques, maxShield: undefined },
  cordera: { name: HERO_DISPLAY_NAME.cordera, role: HERO_CLASS.cordera, maxShield: undefined },
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
 * Escudo primero, vida después. Devuelve cuánto absorbió el escudo.
 * `shieldBreak` multiplica el desgaste del escudo sin atravesarlo.
 */
export function applyDamage(
  party: PartyState,
  target: PartyMemberId,
  damage: number,
  shieldBreak = 1,
): { absorbed: number; toHealth: number; ko: boolean } {
  const member = party[target];
  const before = member.health;
  let absorbed = 0;
  if (member.shield !== undefined && member.shield > 0) {
    const shieldCost = Math.min(member.shield, Math.round(damage * shieldBreak));
    absorbed = Math.min(damage, shieldCost);
    member.shield -= shieldCost;
    if (member.shield < 0) member.shield = 0;
  }
  const toHealth = Math.max(0, damage - absorbed);
  member.health = Math.max(0, member.health - toHealth);
  member.status = member.health === 0 ? "ko" : "active";
  return { absorbed, toHealth, ko: before > 0 && member.health === 0 };
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

export function healMember(party: PartyState, target: PartyMemberId, amount: number): number {
  const member = party[target];
  if (member.health === 0) return 0;
  const before = member.health;
  member.health = Math.min(member.maxHealth, member.health + amount);
  return member.health - before;
}

export function refreshShield(party: PartyState, amount: number): number {
  const roko = party.roko;
  if (roko.health === 0 || roko.shield === undefined || roko.maxShield === undefined) return 0;
  const before = roko.shield;
  roko.shield = Math.min(roko.maxShield, roko.shield + amount);
  return roko.shield - before;
}

/**
 * Refresca el nombre y el rol visibles de una formación ya guardada.
 *
 * Una Battle persistida antes de la corrección canónica lleva «Roko» dentro del
 * registro. Esto NO reescribe historia: el id, el HP, el escudo y las cicatrices
 * se conservan intactos; sólo el nombre que se muestra pasa a ser el correcto.
 */
export function refreshPartyDisplay(party: PartyState): void {
  for (const id of PARTY_ORDER) {
    party[id].name = PROFILE[id].name;
    party[id].role = PROFILE[id].role;
  }
}

/**
 * RECUPERACIÓN FUERA DE BATTLE.
 *
 * UN JUGADOR PUEDE PERDER UNA BATALLA. NO PUEDE PERDER EL ACCESO AL JUEGO.
 *
 * Con el Marqués en el suelo y el zurrón vacío no queda ninguna ruta legal:
 * `retryBattle` exige levantarlo y no hay tónico con el que hacerlo. Esa es la
 * única salida, y por eso vive aquí y no en la pantalla: es la fracción de vida
 * con la que el grupo vuelve al frente tras una retirada.
 *
 * NO ES UNA RESURRECCIÓN GRATIS DENTRO DEL INTENTO: el intento se cierra, la
 * evidencia, la Horda, el progreso y el zurrón siguen exactamente como estaban.
 */
export const RECOVERY_HEALTH_RATIO = 0.25;

/** Vida mínima de reentrada. Configuración del Core, nunca de la UI. */
export function recoveryHealth(maxHealth: number): number {
  return Math.max(1, Math.round(maxHealth * RECOVERY_HEALTH_RATIO));
}

/**
 * Levanta del suelo a quien haya caído, hasta el mínimo de reentrada.
 *
 * Sólo toca a los caídos: quien sigue en pie conserva sus heridas. Devuelve a
 * quién levantó, para que el evento de mundo pueda decirlo con nombre propio.
 */
export function recoverFallen(party: PartyState): PartyMemberId[] {
  const raised: PartyMemberId[] = [];
  for (const id of PARTY_ORDER) {
    const member = party[id];
    if (member.health > 0) continue;
    member.health = recoveryHealth(member.maxHealth);
    member.status = "active";
    raised.push(id);
  }
  return raised;
}
