/**
 * EL NÚCLEO EXPLICA POR QUÉ DIJO QUE NO.
 *
 * Hasta ahora todo error del dominio salía por HTTP como `400`: «no existe»,
 * «ya hay un frente comprometido» y «mandaste basura» eran indistinguibles para
 * el cliente. Unity necesita distinguirlos para reaccionar —volver atrás,
 * mostrar el motivo, o reportar un fallo— y por eso está en el contrato de
 * cliente y no en una lista de limpieza (artículo 7).
 *
 * El mensaje SIEMPRE está escrito para que lo lea el jugador. El renderer lo
 * muestra; no lo reescribe ni lo esconde.
 */
export type DomainErrorKind =
  /** La entidad no existe. El cliente vuelve atrás y refresca. */
  | "not_found"
  /** El estado del reino no lo permite ahora. El cliente muestra el motivo. */
  | "conflict"
  /** Los datos no cumplen la regla. El cliente muestra el motivo. */
  | "invalid"
  /** Existe, pero no es tuyo o no tienes permiso. */
  | "forbidden";

export class DomainError extends Error {
  constructor(
    readonly kind: DomainErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

/** No existe. */
export const notFound = (message: string): DomainError => new DomainError("not_found", message);

/**
 * La regla del reino lo prohíbe ahora mismo.
 *
 * Es el caso más común de Torreón y casi nunca es culpa de quien llama: «ya hay
 * una Battle con reloj», «este paso ya recibió todo su impacto». Por eso el
 * mensaje se redacta para el jugador.
 */
export const deny = (message: string): DomainError => new DomainError("conflict", message);

/** Los datos no cumplen la regla: un peso que no suma 100, un monto negativo. */
export const invalid = (message: string): DomainError => new DomainError("invalid", message);

/** Existe, pero no le pertenece a quien pregunta. */
export const forbidden = (message: string): DomainError => new DomainError("forbidden", message);

/** El código HTTP de cada clase. El transporte traduce; no decide (artículo 7). */
export const HTTP_STATUS: Record<DomainErrorKind, number> = {
  not_found: 404,
  conflict: 409,
  invalid: 422,
  forbidden: 403,
};

/**
 * Traduce cualquier fallo a una respuesta.
 *
 * Lo que NO es un `DomainError` es un fallo nuestro, no del jugador: sale como
 * `500` y no se le echa la culpa a quien llamó. Antes todo era `400`, así que
 * un `TypeError` nuestro parecía una petición mal formada.
 */
export function describeFailure(error: unknown): { status: number; kind: DomainErrorKind | "internal"; message: string } {
  if (error instanceof DomainError) {
    return { status: HTTP_STATUS[error.kind], kind: error.kind, message: error.message };
  }
  return {
    status: 500,
    kind: "internal",
    message: error instanceof Error ? error.message : "Error inesperado en el reino.",
  };
}
