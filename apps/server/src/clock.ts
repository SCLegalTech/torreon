/**
 * EL RELOJ ES UNA DEPENDENCIA, NO UN HECHO DEL UNIVERSO.
 *
 * Torreón es un dominio de plazos: ventanas críticas, presión temporal,
 * períodos de facturación, vencimientos recurrentes. Con el reloj cableado, el
 * dominio sólo se puede probar el día correcto —`F-001` pasaba los días 1 a 5
 * del mes y fallaba los otros 25— y las pruebas de tiempo real resbalan bajo
 * carga.
 *
 * El Núcleo RECIBE el instante. No lo consulta. Artículo 8 de la constitución,
 * ADR-0006, y una prueba de aptitud que lo vigila.
 */
export interface Clock {
  /** Milisegundos desde época. */
  now(): number;
  /** El mismo instante en ISO-8601 UTC, que es como se persiste todo aquí. */
  iso(): string;
}

/** Convierte un instante en la marca que el reino guarda. */
export const isoAt = (nowMs: number): string => new Date(nowMs).toISOString();

/** El reloj de pared. Sólo lo monta el arranque del servidor y las pruebas que quieren tiempo real. */
export const systemClock: Clock = {
  now: () => Date.now(),
  iso: () => new Date().toISOString(),
};

/**
 * Un reloj detenido en un instante. Para probar un vencimiento sin esperar al
 * calendario.
 */
export function fixedClock(at: string | number): Clock {
  const fixed = typeof at === "number" ? at : Date.parse(at);
  if (Number.isNaN(fixed)) throw new Error(`Instante no interpretable: ${at}`);
  return { now: () => fixed, iso: () => isoAt(fixed) };
}

/**
 * Un reloj que avanza sólo cuando alguien lo mueve. Para probar una Battle
 * entera —presión, ventanas, vencimiento— sin dormir ni un milisegundo.
 */
export function manualClock(start: string | number = 0): Clock & { advance(ms: number): void; set(at: string | number): void } {
  let current = typeof start === "number" ? start : Date.parse(start);
  if (Number.isNaN(current)) throw new Error(`Instante no interpretable: ${start}`);
  return {
    now: () => current,
    iso: () => isoAt(current),
    advance: (ms: number) => {
      current += ms;
    },
    set: (at: string | number) => {
      current = typeof at === "number" ? at : Date.parse(at);
    },
  };
}
