import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpApp } from "./app.js";
import { fixedClock } from "./clock.js";
import { demoQuest, QuestService } from "./quest-service.js";
import { JsonRealmStore } from "./store.js";

const RELOJ_DEL_REINO = "2026-05-11T09:00:00.000Z";

/**
 * QUIÉN ENCARNA EL JUGADOR.
 *
 * El grupo eran tres nombres cableados. Con varios jugadores en el reino cada
 * uno encarna a alguien y le pone nombre a lo suyo — y **Roku no se encarna:
 * Roku es la mascota**.
 *
 * La regla que protege la historia: el id interno NUNCA cambia. `roko` sigue
 * siendo `roko` en todo lo persistido; lo que cambia es el nombre que se
 * resuelve al leer.
 */
describe("La ficha del jugador", () => {
  let directory: string;
  let service: QuestService;
  let app: ReturnType<typeof createHttpApp>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "torreon-ficha-"));
    const store = new JsonRealmStore(join(directory, "state.json"), fixedClock(RELOJ_DEL_REINO));
    await store.init();
    service = new QuestService(store, undefined, directory, "torreon-ficha-test", fixedClock(RELOJ_DEL_REINO));
    app = createHttpApp(service);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("un reino sin ficha la pide; con ficha, deja de pedirla", async () => {
    const antes = await request(app).get("/v1/realm/summary").expect(200);
    expect(antes.body.data.needsCharacter).toBe(true);

    await request(app)
      .post("/api/character")
      .send({ archetype: "cordera", displayName: "Ainara", petName: "Trueno" })
      .expect(200);

    const despues = await request(app).get("/v1/realm/summary").expect(200);
    expect(despues.body.data.needsCharacter).toBe(false);
    expect(despues.body.data.player.displayName).toBe("Ainara");
    expect(despues.body.data.player.archetype).toBe("cordera");
    expect(despues.body.data.player.petName).toBe("Trueno");
  });

  it("mujer encarna a la Cordera; hombre, al Marqués", async () => {
    const ella = await service.createCharacter({ archetype: "cordera", displayName: "Ainara" });
    expect(ella.title).toBe("Guardiana de la Marca");
    const el = await service.createCharacter({ archetype: "marques", displayName: "Diego" });
    expect(el.title).toBe("Guardián de la Marca");
  });

  it("el arquetipo encarnado lleva el nombre del jugador; el otro, el suyo", async () => {
    await service.createCharacter({ archetype: "cordera", displayName: "Ainara", petName: "Trueno" });
    const draft = await service.createDraft(demoQuest);
    await service.accept(draft.id, true);
    const iniciada = await service.start(draft.id);

    expect(iniciada.battle!.party.cordera.name).toBe("Ainara");
    expect(iniciada.battle!.party.marques.name).toBe("Marqués");
    expect(iniciada.battle!.party.roko.name).toBe("Trueno");
  });

  it("Roku es la mascota: no se puede encarnar", async () => {
    await expect(service.createCharacter({ archetype: "roko" as never, displayName: "Diego" })).rejects.toThrow(/mascota/i);
    const respuesta = await request(app).post("/api/character").send({ archetype: "roko", displayName: "Diego" }).expect(422);
    expect(respuesta.body.kind).toBe("invalid");
  });

  it("renombrar al personaje NO reescribe la historia: los ids no se mueven", async () => {
    await service.createCharacter({ archetype: "marques", displayName: "Diego", petName: "Roku" });
    const draft = await service.createDraft(demoQuest);
    await service.accept(draft.id, true);
    await service.start(draft.id);

    const antes = await service.snapshot();
    const hechosAntes = antes.realm.gameEvents.length;

    await service.createCharacter({ archetype: "marques", displayName: "El Marqués Phi", petName: "Roku el Bravo" });

    const despues = await service.snapshot();
    // El frente vivo ya llama al grupo por su nombre nuevo…
    expect(despues.battle!.party.marques.name).toBe("El Marqués Phi");
    expect(despues.battle!.party.roko.name).toBe("Roku el Bravo");
    // …y los ids y la historia siguen exactamente igual.
    expect(despues.battle!.party.roko.id).toBe("roko");
    expect(despues.battle!.party.marques.id).toBe("marques");
    expect(despues.realm.gameEvents.length).toBe(hechosAntes);
  });

  it("un nombre sin letras no crea personaje", async () => {
    await expect(service.createCharacter({ archetype: "marques", displayName: " " })).rejects.toThrow(/nombre/i);
  });

  it("sin nombre de mascota, la mascota sigue siendo Roku", async () => {
    const ficha = await service.createCharacter({ archetype: "marques", displayName: "Diego" });
    expect(ficha.petName).toBe("Roku");
  });
});
