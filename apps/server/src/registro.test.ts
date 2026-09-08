import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpApp } from "./app.js";
import { fixedClock } from "./clock.js";
import { IdentityStore } from "./identity-store.js";
import { Kingdom } from "./kingdom.js";
import { demoQuest } from "./quest-service.js";
import { JsonRealmStore } from "./store.js";

const RELOJ_DEL_REINO = "2026-05-11T09:00:00.000Z";
const LLAVE_A = "llave-del-telefono-de-diego-0001";
const LLAVE_B = "llave-del-telefono-de-un-amigo-02";

/**
 * LA BETA CERRADA.
 *
 * El nombre es único en el reino, y hay UNA partida que ya llevaba meses
 * jugándose. Quien la reclame por su nombre la recupera entera; nadie más puede
 * volver a reclamarla, y nadie puede llamarse como otro.
 */
describe("Registrarse en el reino", () => {
  let directory: string;
  let kingdom: Kingdom;
  let app: ReturnType<typeof createHttpApp>;

  beforeEach(async () => {
    process.env.TORREON_IDENTITY = "on";
    directory = await mkdtemp(join(tmpdir(), "torreon-registro-"));
    const statePath = join(directory, "torreon-state.json");
    const store = new JsonRealmStore(statePath, fixedClock(RELOJ_DEL_REINO));
    await store.init();
    kingdom = new Kingdom(
      store,
      undefined,
      directory,
      "torreon-registro-test",
      fixedClock(RELOJ_DEL_REINO),
      IdentityStore.beside(statePath, fixedClock(RELOJ_DEL_REINO)),
    );
    app = createHttpApp(kingdom.realmOf(), kingdom);
  });

  afterEach(async () => {
    delete process.env.TORREON_IDENTITY;
    await rm(directory, { recursive: true, force: true });
  });

  const registrar = (body: Record<string, unknown>) => request(app).post("/v1/session/register").send(body);

  it("registrarse crea jugador, sesión y ficha de una sola vez", async () => {
    const { body } = await registrar({ deviceKey: LLAVE_A, displayName: "Ainara", archetype: "cordera", petName: "Trueno" }).expect(201);
    expect(body.token).toMatch(/^tor_s_/);
    expect(body.player.displayName).toBe("Ainara");
    expect(body.player.archetype).toBe("cordera");
    expect(body.player.petName).toBe("Trueno");
    await request(app).get("/v1/realm/summary").set("authorization", `Bearer ${body.token}`).expect(200);
  });

  it("quien reclama el nombre heredado recupera la partida que ya existía", async () => {
    // Una partida en curso, del reino que ya estaba.
    await kingdom.realmOf().createDraft(demoQuest);

    const { body } = await registrar({ deviceKey: LLAVE_A, displayName: "Marqués", archetype: "marques" }).expect(201);
    expect(body.claimedLegacyRealm).toBe(true);

    const suyo = await request(app).get("/v1/map").set("authorization", `Bearer ${body.token}`).expect(200);
    expect(suyo.body.data.standaloneQuests.length).toBe(1);
  });

  it("el reino heredado se reclama UNA vez: después el nombre está en uso", async () => {
    await registrar({ deviceKey: LLAVE_A, displayName: "Marqués", archetype: "marques" }).expect(201);
    const segundo = await registrar({ deviceKey: LLAVE_B, displayName: "Marqués", archetype: "marques" }).expect(409);
    expect(segundo.body.error).toMatch(/ya está en uso/i);
  });

  it("«Marqués», «marques» y «  MARQUES  » son el mismo nombre", async () => {
    await registrar({ deviceKey: LLAVE_A, displayName: "Marqués", archetype: "marques" }).expect(201);
    await registrar({ deviceKey: LLAVE_B, displayName: "  MARQUES  ", archetype: "cordera" }).expect(409);
  });

  it("un amigo que llega después estrena SU reino, no el de nadie", async () => {
    await kingdom.realmOf().createDraft(demoQuest);
    const diego = await registrar({ deviceKey: LLAVE_A, displayName: "Marqués", archetype: "marques" }).expect(201);
    const amigo = await registrar({ deviceKey: LLAVE_B, displayName: "Ainara", archetype: "cordera" }).expect(201);

    expect(amigo.body.claimedLegacyRealm).toBe(false);
    expect(amigo.body.playerId).not.toBe(diego.body.playerId);

    const suyo = await request(app).get("/v1/map").set("authorization", `Bearer ${amigo.body.token}`).expect(200);
    expect(suyo.body.data.standaloneQuests).toHaveLength(0);
  });

  it("la pantalla puede preguntar si un nombre está libre antes de dejar seguir", async () => {
    const libre = await request(app).get("/v1/session/name-available?name=Ainara").expect(200);
    expect(libre.body.available).toBe(true);

    await registrar({ deviceKey: LLAVE_A, displayName: "Ainara", archetype: "cordera" }).expect(201);

    const ocupado = await request(app).get("/v1/session/name-available?name=ainara").expect(200);
    expect(ocupado.body.available).toBe(false);
  });

  /**
   * UNA BETA CERRADA SE CIERRA CON ALGO.
   *
   * Con el repositorio público, la dirección del reino deja de ser un secreto.
   * Si el reino declara un código, sin él no entra nadie.
   */
  it("con código declarado, registrarse sin él no entra", async () => {
    process.env.TORREON_INVITE_CODE = "los-compadres-2026";
    try {
      const sinCodigo = await registrar({ deviceKey: LLAVE_A, displayName: "Colado", archetype: "marques" }).expect(409);
      expect(sinCodigo.body.error).toMatch(/beta cerrada/i);

      await registrar({ deviceKey: LLAVE_A, displayName: "Colado", archetype: "marques", inviteCode: "cualquiera" }).expect(409);
      await registrar({ deviceKey: LLAVE_A, displayName: "Invitado", archetype: "marques", inviteCode: "los-compadres-2026" }).expect(201);
    } finally {
      delete process.env.TORREON_INVITE_CODE;
    }
  });

  it("la pantalla sabe si esta beta pide código", async () => {
    const abierta = await request(app).get("/v1/session/gate").expect(200);
    expect(abierta.body.inviteRequired).toBe(false);

    process.env.TORREON_INVITE_CODE = "los-compadres-2026";
    try {
      const cerrada = await request(app).get("/v1/session/gate").expect(200);
      expect(cerrada.body.inviteRequired).toBe(true);
    } finally {
      delete process.env.TORREON_INVITE_CODE;
    }
  });

  /**
   * EL AGENTE SE CONECTA SOLO, SIN QUE NADIE LE PASE UN SECRETO POR DEBAJO.
   *
   * Claude sabe mandar cabeceras y usa la dirección limpia. ChatGPT en modo
   * desarrollador sólo ofrece una URL: ahí la llave va dentro de la dirección,
   * que es más débil —se filtra en historiales— pero revocable por agente.
   */
  it("crear una concesión devuelve la dirección lista para pegar", async () => {
    const { body: diego } = await registrar({ deviceKey: LLAVE_A, displayName: "Marqués", archetype: "marques" }).expect(201);
    const { body } = await request(app)
      .post("/v1/agents")
      .set("authorization", `Bearer ${diego.token}`)
      .send({ label: "ChatGPT del portátil" })
      .expect(201);

    expect(body.mcpUrl).toContain(body.token);
    expect(body.mcpHeaderUrl).not.toContain(body.token);
    expect(body.mcpUrl.startsWith(body.mcpHeaderUrl)).toBe(true);
  });

  it("un agente entra por la llave en la ruta, y deja de entrar cuando lo cortan", async () => {
    const { body: diego } = await registrar({ deviceKey: LLAVE_A, displayName: "Marqués", archetype: "marques" }).expect(201);
    const { body: agente } = await request(app)
      .post("/v1/agents")
      .set("authorization", `Bearer ${diego.token}`)
      .send({ label: "ChatGPT del portátil" })
      .expect(201);

    // Lo que importa no es saludar: es EJECUTAR.
    const ejecutar = () =>
      request(app)
        .post(`/mcp/${agente.token}`)
        .set("accept", "application/json, text/event-stream")
        .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_realm_state", arguments: {} } });

    const conAcceso = await ejecutar().expect(200);
    expect(conAcceso.text).toContain("activeBattle");

    await request(app).delete(`/v1/agents/${agente.agent.id}`).set("authorization", `Bearer ${diego.token}`).expect(200);

    const cortado = await ejecutar().expect(200);
    expect(cortado.text).not.toContain("activeBattle");
    expect(cortado.text).toContain("CONCEDER ACCESO");
  });

  /**
   * UN 401 SECO DEJA AL AGENTE SIN SABER QUÉ HACER.
   *
   * Contestar 401 a TODO —incluido el saludo del protocolo— hacía que el
   * cliente viera un fallo de transporte y no un motivo. ChatGPT llegó a
   * deshabilitar el conector entero, y desde fuera parecía que el
   * descubrimiento funcionaba y la ejecución se rompía sola.
   */
  const rpc = (metodo: string, params: unknown, ruta = "/mcp") =>
    request(app)
      .post(ruta)
      .set("accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: metodo, params });

  it("sin concesión, el protocolo saluda y las herramientas se listan", async () => {
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } }).expect(200);
    const lista = await rpc("tools/list", {}).expect(200);
    expect(lista.text).toContain("get_realm_state");
  });

  it("sin concesión, ejecutar dice CÓMO conseguirla en vez de romperse", async () => {
    const respuesta = await rpc("tools/call", { name: "get_realm_state", arguments: {} }).expect(200);
    const cuerpo = respuesta.text;
    expect(cuerpo).toContain("AMIGOS");
    expect(cuerpo).toContain("CONCEDER ACCESO");
    expect(cuerpo).toContain('"isError":true');
  });

  it("y aun así no ejecuta nada: el reino no sale por ahí", async () => {
    const respuesta = await rpc("tools/call", { name: "get_realm_state", arguments: {} }).expect(200);
    expect(respuesta.text).not.toContain("activeBattle");
    expect(respuesta.text).not.toContain("openFronts");
  });

  it("sin credencial, cualquier otra cosa sigue cerrada", async () => {
    const respuesta = await rpc("resources/list", {});
    expect(respuesta.status).toBe(401);
  });

  it("un nombre de una letra no registra a nadie", async () => {
    await registrar({ deviceKey: LLAVE_A, displayName: "M", archetype: "marques" }).expect(422);
  });
});
