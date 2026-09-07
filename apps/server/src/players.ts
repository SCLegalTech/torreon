/**
 * EL JUGADOR ES LA RAÍZ (artículo 10, ADR-0002).
 *
 * Hasta ahora el proceso entero era un reino: `JsonRealmStore` recibía una ruta
 * y todas las lecturas eran «el reino», sin dueño. No faltaba autenticación:
 * faltaba el SUJETO, y no había dónde poner al segundo jugador.
 *
 * Esto entra ANTES que la persistencia real a propósito: un esquema que nace
 * sin `playerId` se migra dos veces.
 *
 * Aquí no hay credenciales ni sesiones. Saber QUIÉN pregunta es la etapa 5
 * (ADR-0007); esto sólo dice que todo lo que se guarda es de ALGUIEN.
 */
export type PlayerId = string;

/**
 * EL MARQUÉS QUE YA ESTABA.
 *
 * El reino que existe hoy en `torreon.fly.dev` no puede quedarse huérfano al
 * introducir el sujeto: se le adopta bajo este id, que además es el que sigue
 * usando su archivo de siempre (`torreon-state.json`). Ninguna migración de
 * datos, ninguna partida perdida.
 */
export const DEFAULT_PLAYER_ID: PlayerId = "marques-phi";

/**
 * Los ids de jugador viajan en rutas y en nombres de archivo. Nada que pueda
 * salirse del directorio del reino o colarse en una ruta ajena.
 */
export function isPlayerId(value: unknown): value is PlayerId {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{2,63}$/.test(value);
}

export function requirePlayerId(value: unknown): PlayerId {
  if (!isPlayerId(value)) {
    throw new Error("Un jugador se nombra con 3 a 64 caracteres: minúsculas, dígitos, guion y guion bajo.");
  }
  return value;
}
