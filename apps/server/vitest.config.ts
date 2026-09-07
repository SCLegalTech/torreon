import { defineConfig } from "vitest/config";

/**
 * Las pruebas de Torreón no son unitarias: montan un reino de verdad en un
 * directorio temporal y lo escriben entero en cada mutación. Con la suite
 * completa en paralelo, un reino puede tardar varios segundos en un disco
 * ocupado, y el tope de 5 s de vitest las hacía fallar por lentitud —no por
 * estar mal—.
 *
 * Esto NO tapa una prueba inestable: la inestabilidad real venía del reloj de
 * pared y se cerró plantando el reloj del reino (ADR-0006). Lo que se reconoce
 * aquí es que el almacén de documento hace E/S de verdad. Cuando el reino viva
 * en SQLite (ADR-0003) este margen debería sobrar.
 */
export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
