import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpApp } from "./app.js";
import { QuestService } from "./quest-service.js";
import { JsonRealmStore } from "./store.js";
import { fixedClock } from "./clock.js";

/**
 * EL RELOJ DEL REINO SE PLANTA (artículo 8, ADR-0006). Sin esto, la presión y
 * las ventanas críticas dependían del tiempo real que tardara la suite, y la
 * misma prueba pasaba aislada y fallaba bajo carga.
 */
const RELOJ_DEL_REINO = "2026-05-11T09:00:00.000Z";

/**
 * LA PUERTA DEL REINO.
 *
 * Un tapón mientras llega la identidad de jugador (ADR-0007): cierra el reino
 * de la nube al mundo, pero NO dice quién llama. Estas pruebas defienden lo
 * único que sí garantiza: que con llave declarada nadie entra sin ella, que la
 * salud del reino se puede consultar igual, y que destruir la campaña no cabe
 * en la misma llave con la que se juega.
 */
describe("La puerta del reino", () => {
  let directory: string;
  let app: ReturnType<typeof createHttpApp>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "torreon-puerta-"));
    const store = new JsonRealmStore(join(directory, "state.json"), fixedClock(RELOJ_DEL_REINO));
    await store.init();
    app = createHttpApp(new QuestService(store, undefined, directory, "torreon-puerta-test", fixedClock(RELOJ_DEL_REINO)));
  });

  afterEach(async () => {
    delete process.env.TORREON_API_TOKEN;
    delete process.env.TORREON_RESET_TOKEN;
    await rm(directory, { recursive: true, force: true });
  });

  it("sin llave declarada, el reino local sigue abierto como siempre", async () => {
    await request(app).get("/api/state").expect(200);
  });

  it("con llave declarada, quien no la trae no ve el reino", async () => {
    process.env.TORREON_API_TOKEN = "llave-de-la-marca";
    await request(app).get("/api/state").expect(401);
    await request(app).post("/api/demo/quest").expect(401);
  });

  it("una llave equivocada no vale más que ninguna", async () => {
    process.env.TORREON_API_TOKEN = "llave-de-la-marca";
    await request(app).get("/api/state").set("authorization", "Bearer otra-cosa").expect(401);
  });

  it("con la llave correcta, el reino responde entero", async () => {
    process.env.TORREON_API_TOKEN = "llave-de-la-marca";
    const response = await request(app).get("/api/state").set("authorization", "Bearer llave-de-la-marca").expect(200);
    expect(response.body.realm.realmId).toBeTruthy();
  });

  it("la salud del reino se consulta sin llave: Fly tiene que poder preguntar", async () => {
    process.env.TORREON_API_TOKEN = "llave-de-la-marca";
    const response = await request(app).get("/health").expect(200);
    expect(response.body.status).toBe("ok");
  });

  it("borrar el reino no cabe en la misma llave que abrirlo", async () => {
    process.env.TORREON_API_TOKEN = "llave-de-la-marca";
    await request(app).post("/api/reset").set("authorization", "Bearer llave-de-la-marca").expect(403);
  });

  it("con su propia llave, reiniciar sigue siendo posible", async () => {
    process.env.TORREON_API_TOKEN = "llave-de-la-marca";
    process.env.TORREON_RESET_TOKEN = "llave-de-ceniza";
    await request(app)
      .post("/api/reset")
      .set("authorization", "Bearer llave-de-la-marca")
      .set("x-torreon-reset", "llave-de-ceniza")
      .expect(200);
  });

  it("la llave de reinicio no se adivina desde la de jugar", async () => {
    process.env.TORREON_API_TOKEN = "llave-de-la-marca";
    process.env.TORREON_RESET_TOKEN = "llave-de-ceniza";
    await request(app)
      .post("/api/reset")
      .set("authorization", "Bearer llave-de-la-marca")
      .set("x-torreon-reset", "llave-de-la-marca")
      .expect(403);
  });

  it("sin ninguna llave, reiniciar en local sigue funcionando", async () => {
    await request(app).post("/api/reset").expect(200);
  });
});
