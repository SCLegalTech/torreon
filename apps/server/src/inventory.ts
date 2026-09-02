import type { InventoryItemId, InventoryState, PartyMemberId, PartyState } from "./domain.js";

/**
 * LOS OBJETOS SE GASTAN.
 *
 * El Core valida existencia, cantidad, destino y estado del destino ANTES de
 * aplicar nada, y sólo él decrementa. Un renderer que reste por su cuenta
 * estaría inventando recursos.
 */

export interface ItemDefinition {
  id: InventoryItemId;
  name: string;
  description: string;
  /** Sobre quién puede usarse. Un tónico no cura y una poción no resucita. */
  requires: "ko" | "alive";
  effect: "revive" | "heal";
  /** Fracción de la vida máxima con la que vuelve, o puntos que cura. */
  amount: number;
}

export const ITEMS: Record<InventoryItemId, ItemDefinition> = {
  revive_tonic: {
    id: "revive_tonic",
    name: "Tónico de Retorno",
    description: "Levanta a un caído con una parte de su vida. Volver no es estar entero.",
    requires: "ko",
    effect: "revive",
    amount: 0.35,
  },
  health_potion: {
    id: "health_potion",
    name: "Poción Carmesí",
    description: "Cierra heridas de quien sigue en pie. No devuelve a nadie del suelo.",
    requires: "alive",
    effect: "heal",
    amount: 30,
  },
};

/** Reparto inicial. Se concede UNA vez: recargar o redesplegar no repite. */
export const STARTER_INVENTORY: Array<{ itemId: InventoryItemId; quantity: number }> = [
  { itemId: "revive_tonic", quantity: 1 },
  { itemId: "health_potion", quantity: 2 },
];

export function quantityOf(inventory: InventoryState, itemId: InventoryItemId): number {
  return inventory.items.find((entry) => entry.itemId === itemId)?.quantity ?? 0;
}

export function grantItem(inventory: InventoryState, itemId: InventoryItemId, quantity: number): void {
  const entry = inventory.items.find((candidate) => candidate.itemId === itemId);
  if (entry) entry.quantity += quantity;
  else inventory.items.push({ itemId, quantity });
}

export interface ItemUseResult {
  item: ItemDefinition;
  target: PartyMemberId;
  healed: number;
  revived: boolean;
  remaining: number;
}

/**
 * Aplica un objeto sobre un miembro del grupo.
 *
 * Lanza si el objeto no existe, si no queda ninguno o si el destino no está en
 * el estado que el objeto exige. Nunca supera la vida máxima.
 */
export function useItem(inventory: InventoryState, party: PartyState, itemId: InventoryItemId, target: PartyMemberId): ItemUseResult {
  const item = ITEMS[itemId];
  if (!item) throw new Error(`Objeto desconocido: ${itemId}`);
  const entry = inventory.items.find((candidate) => candidate.itemId === itemId);
  if (!entry || entry.quantity <= 0) throw new Error(`No queda ningún ${item.name} en el zurrón.`);
  const member = party[target];
  if (!member) throw new Error(`Miembro del grupo desconocido: ${target}`);

  if (item.requires === "ko" && member.health > 0) {
    throw new Error(`${member.name} sigue en pie: el ${item.name} es para levantar a un caído.`);
  }
  if (item.requires === "alive" && member.health === 0) {
    throw new Error(`${member.name} está caído: la ${item.name} cierra heridas, no resucita.`);
  }

  const before = member.health;
  if (item.effect === "revive") {
    member.health = Math.max(1, Math.round(member.maxHealth * item.amount));
    member.status = "active";
  } else {
    member.health = Math.min(member.maxHealth, member.health + item.amount);
  }
  entry.quantity -= 1;

  return {
    item,
    target,
    healed: member.health - before,
    revived: item.effect === "revive",
    remaining: entry.quantity,
  };
}
