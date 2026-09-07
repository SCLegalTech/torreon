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

  it("un nombre de una letra no registra a nadie", async () => {
    await registrar({ deviceKey: LLAVE_A, displayName: "M", archetype: "marques" }).expect(422);
  });
});
