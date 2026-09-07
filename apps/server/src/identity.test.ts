import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpApp } from "./app.js";
import { fixedClock } from "./clock.js";
import { IdentityStore } from "./identity-store.js";
import { Kingdom } from "./kingdom.js";
import { JsonRealmStore } from "./store.js";

const RELOJ_DEL_REINO = "2026-05-11T09:00:00.000Z";
const LLAVE_A = "llave-del-telefono-de-diego-0001";
const LLAVE_B = "llave-del-telefono-de-cordera-002";

/**
 * DOS IDENTIDADES, NO UNA (artículo 11, ADR-0007).
 *
 * Un secreto compartido cierra la puerta pero no dice quién llama. Esto sí:
 * cada jugador entra con lo suyo, cada agente actúa EN NOMBRE DE alguien con un
 * alcance declarado, y cortar a un agente no deja al jugador fuera de su reino.
 */
describe("Quién pregunta", () => {
  let directory: string;
  let kingdom: Kingdom;
  let app: ReturnType<typeof createHttpApp>;

  beforeEach(async () => {
    process.env.TORREON_IDENTITY = "on";
    directory = await mkdtemp(join(tmpdir(), "torreon-identidad-"));
    const statePath = join(directory, "torreon-state.json");
    const store = new JsonRealmStore(statePath, fixedClock(RELOJ_DEL_REINO));
    await store.init();
    kingdom = new Kingdom(
      store,
      undefined,
      directory,
      "torreon-identidad-test",
      fixedClock(RELOJ_DEL_REINO),
      IdentityStore.beside(statePath, fixedClock(RELOJ_DEL_REINO)),
    );
    app = createHttpApp(kingdom.realmOf(), kingdom);
  });

  afterEach(async () => {
    delete process.env.TORREON_IDENTITY;
    await rm(directory, { recursive: true, force: true });
  });

  async function entrar(deviceKey: string): Promise<{ token: string; playerId: string }> {
    const { body } = await request(app).post("/v1/session/device").send({ deviceKey }).expect(201);
    return { token: body.token, playerId: body.playerId };
  }

  it("sin credencial no se juega", async () => {
    const response = await request(app).get("/v1/realm/summary").expect(403);
    expect(response.body.error).toMatch(/identificarse/i);
  });

  it("el teléfono entra y recibe una llave que sólo se enseña una vez", async () => {
    const { body } = await request(app).post("/v1/session/device").send({ deviceKey: LLAVE_A }).expect(201);
    expect(body.token).toMatch(/^tor_s_/);
    expect(body.playerId).toBeTruthy();
    await request(app).get("/v1/realm/summary").set("authorization", `Bearer ${body.token}`).expect(200);
  });

  it("reinstalar la app devuelve al MISMO jugador, no a un reino nuevo", async () => {
    const primera = await entrar(LLAVE_A);
    const segunda = await entrar(LLAVE_A);
    expect(segunda.playerId).toBe(primera.playerId);
    // Y son sesiones distintas: la llave nueva vale, la vieja también.
    expect(segunda.token).not.toBe(primera.token);
  });

  it("dos teléfonos son dos jugadores, y no se ven el reino", async () => {
    const diego = await entrar(LLAVE_A);
    const cordera = await entrar(LLAVE_B);
    expect(cordera.playerId).not.toBe(diego.playerId);

    await request(app)
      .post("/v1/quests/from-intent")
      .set("authorization", `Bearer ${diego.token}`)
      .send({ intent: "Pagar el arriendo del mes" })
      .expect(200);

    const suyo = await request(app).get("/v1/map").set("authorization", `Bearer ${diego.token}`).expect(200);
    const ajeno = await request(app).get("/v1/map").set("authorization", `Bearer ${cordera.token}`).expect(200);
    expect(suyo.body.data.standaloneQuests.length).toBeGreaterThan(0);
    expect(ajeno.body.data.standaloneQuests).toHaveLength(0);
  });

  it("una llave inventada no abre nada", async () => {
    await request(app).get("/v1/realm/summary").set("authorization", "Bearer tor_s_inventado").expect(403);
  });

  it("cerrar sesión invalida esa llave", async () => {
    const diego = await entrar(LLAVE_A);
    await request(app).delete("/v1/session").set("authorization", `Bearer ${diego.token}`).expect(200);
    await request(app).get("/v1/realm/summary").set("authorization", `Bearer ${diego.token}`).expect(403);
  });

  describe("Los agentes son jugadores de primera clase", () => {
    it("una concesión actúa en nombre del jugador, sobre SU reino", async () => {
      const diego = await entrar(LLAVE_A);
      const { body } = await request(app)
        .post("/v1/agents")
        .set("authorization", `Bearer ${diego.token}`)
        .send({ label: "ChatGPT del portátil" })
        .expect(201);
      expect(body.token).toMatch(/^tor_a_/);

      await request(app)
        .post("/v1/quests/from-intent")
        .set("authorization", `Bearer ${body.token}`)
        .send({ intent: "Ordenar el estudio" })
        .expect(200);

      const reino = await request(app).get("/v1/map").set("authorization", `Bearer ${diego.token}`).expect(200);
      expect(reino.body.data.standaloneQuests.length).toBe(1);
    });

    it("conceder no es actuar: hasta que no hace algo, no ha hecho nada", async () => {
      const diego = await entrar(LLAVE_A);
      await request(app).post("/v1/agents").set("authorization", `Bearer ${diego.token}`).send({ label: "Claude" }).expect(201);
      const antes = await request(app).get("/v1/agents").set("authorization", `Bearer ${diego.token}`).expect(200);
      expect(antes.body.agents[0].used).toBe(false);
      expect(antes.body.agents[0].lastUsedAt).toBeNull();
    });

    it("un agente no alcanza lo que su alcance no declara", async () => {
      const diego = await entrar(LLAVE_A);
      const { body } = await request(app)
        .post("/v1/agents")
        .set("authorization", `Bearer ${diego.token}`)
        .send({ label: "Sólo mirar", scopes: ["realm:read"] })
        .expect(201);
      const identity = await kingdom.identity.read();
      expect(identity.grants[0].scopes).toEqual(["realm:read"]);
      // Y su llave sí sirve para mirar.
      await request(app).get("/v1/realm/summary").set("authorization", `Bearer ${body.token}`).expect(200);
    });

    it("cortar a un agente NO cierra la sesión del jugador", async () => {
      const diego = await entrar(LLAVE_A);
      const { body } = await request(app)
        .post("/v1/agents")
        .set("authorization", `Bearer ${diego.token}`)
        .send({ label: "ChatGPT del portátil" })
        .expect(201);

      await request(app)
        .delete(`/v1/agents/${body.agent.id}`)
        .set("authorization", `Bearer ${diego.token}`)
        .send({ reason: "ya no lo uso" })
        .expect(200);

      // El agente queda fuera…
      await request(app).get("/v1/realm/summary").set("authorization", `Bearer ${body.token}`).expect(403);
      // …y el jugador sigue dentro de su propio reino.
      await request(app).get("/v1/realm/summary").set("authorization", `Bearer ${diego.token}`).expect(200);
    });

    it("un jugador no puede cortar la concesión de otro", async () => {
      const diego = await entrar(LLAVE_A);
      const cordera = await entrar(LLAVE_B);
      const { body } = await request(app)
        .post("/v1/agents")
        .set("authorization", `Bearer ${diego.token}`)
        .send({ label: "ChatGPT del portátil" })
        .expect(201);

      const response = await request(app)
        .delete(`/v1/agents/${body.agent.id}`)
        .set("authorization", `Bearer ${cordera.token}`)
        .expect(403);
      expect(response.body.error).toMatch(/no es tuya/i);
    });

    it("el reino guarda huellas, nunca la llave", async () => {
      const diego = await entrar(LLAVE_A);
      const { body } = await request(app)
        .post("/v1/agents")
        .set("authorization", `Bearer ${diego.token}`)
        .send({ label: "ChatGPT del portátil" })
        .expect(201);

      const identity = JSON.stringify(await kingdom.identity.read());
      expect(identity).not.toContain(diego.token);
      expect(identity).not.toContain(body.token);
      expect(identity).not.toContain(LLAVE_A);
    });
  });
});

/**
 * Y con la identidad apagada, NADA cambia: encenderla en un reino que ya está
 * jugando es una decisión de persona, no el efecto de un despliegue.
 */
describe("Con la identidad apagada", () => {
  let directory: string;
  let app: ReturnType<typeof createHttpApp>;

  beforeEach(async () => {
    delete process.env.TORREON_IDENTITY;
    directory = await mkdtemp(join(tmpdir(), "torreon-sin-identidad-"));
    const statePath = join(directory, "torreon-state.json");
    const store = new JsonRealmStore(statePath, fixedClock(RELOJ_DEL_REINO));
    await store.init();
    const kingdom = new Kingdom(store, undefined, directory, "torreon-abierto-test", fixedClock(RELOJ_DEL_REINO));
    app = createHttpApp(kingdom.realmOf(), kingdom);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("el reino de siempre responde sin que nadie se identifique", async () => {
    const response = await request(app).get("/v1/realm/summary").expect(200);
    expect(response.body.data.stats.displayName).toBeTruthy();
  });
});
