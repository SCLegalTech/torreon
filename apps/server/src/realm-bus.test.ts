import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpApp } from "./app.js";
import { fixedClock } from "./clock.js";
import { eventsSince, RealmBus } from "./realm-bus.js";
import { demoQuest, QuestService } from "./quest-service.js";
import { JsonRealmStore } from "./store.js";

const RELOJ_DEL_REINO = "2026-05-11T09:00:00.000Z";

describe("El aviso de que la verdad cambió", () => {
  it("entrega sólo lo posterior al cursor, del más antiguo al más reciente", () => {
    // El estado guarda los hechos del más NUEVO al más viejo.
    const events = [{ id: "c" }, { id: "b" }, { id: "a" }];
    expect(eventsSince(events, "a").map((e) => e.id)).toEqual(["b", "c"]);
    expect(eventsSince(events, "c")).toEqual([]);
    expect(eventsSince(events, undefined).map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("un cursor que ya se salió de la ventana no pierde hechos en silencio", () => {
    // Mejor rehidratar de más que perder uno: el cliente deduplica por id.
    const events = [{ id: "c" }, { id: "b" }];
    expect(eventsSince(events, "hecho-que-ya-no-esta").map((e) => e.id)).toEqual(["b", "c"]);
  });

  it("un oyente que revienta no tumba a los demás", () => {
    const bus = new RealmBus();
    const vistos: string[] = [];
    bus.subscribe("marques-phi", () => {
      throw new Error("este oyente está roto");
    });
    bus.subscribe("marques-phi", (tick) => vistos.push(tick.cursor));
    bus.publish("marques-phi", { events: [{ id: "uno" }], gameEvents: [] } as never);
    expect(vistos).toEqual(["uno"]);
  });

  it("dejar de escuchar deja de recibir", () => {
    const bus = new RealmBus();
    const vistos: string[] = [];
    const stop = bus.subscribe("marques-phi", (tick) => vistos.push(tick.cursor));
    bus.publish("marques-phi", { events: [{ id: "uno" }], gameEvents: [] } as never);
    stop();
    bus.publish("marques-phi", { events: [{ id: "dos" }], gameEvents: [] } as never);
    expect(vistos).toEqual(["uno"]);
    expect(bus.listenerCount("marques-phi")).toBe(0);
  });

  it("el reino de un jugador no avisa al de otro", () => {
    const bus = new RealmBus();
    const vistos: string[] = [];
    bus.subscribe("cordera-la-otra", (tick) => vistos.push(tick.cursor));
    bus.publish("marques-phi", { events: [{ id: "uno" }], gameEvents: [] } as never);
    expect(vistos).toEqual([]);
  });
});

/**
 * EL SONDEO SE MUERE.
 *
 * El cliente pedía el mundo entero cada 1,5 s porque no tenía otra forma de
 * enterarse. Con esto, carga la vista una vez y reacciona a lo que llega.
 */
describe("La suscripción del reino", () => {
  let directory: string;
  let server: Server;
  let base: string;
  let service: QuestService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "torreon-sse-"));
    const store = new JsonRealmStore(join(directory, "state.json"), fixedClock(RELOJ_DEL_REINO));
    await store.init();
    service = new QuestService(store, undefined, directory, "torreon-sse-test", fixedClock(RELOJ_DEL_REINO));
    server = createServer(createHttpApp(service));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    base = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  it("un hecho nuevo llega al cliente sin que lo pida", async () => {
    const abort = new AbortController();
    const response = await fetch(`${base}/v1/stream`, { signal: abort.signal });
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const lector = response.body!.getReader();
    const recibido = leerHasta(lector, "quest_created");

    // Se deja respirar a la suscripción antes de mover el reino.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await service.createDraft(demoQuest);

    const texto = await recibido;
    expect(texto).toContain("event: realm");
    expect(texto).toContain("quest_created");
    abort.abort();
  });
});

async function leerHasta(lector: ReadableStreamDefaultReader<Uint8Array>, marca: string): Promise<string> {
  const decoder = new TextDecoder();
  let acumulado = "";
  const limite = Date.now() + 8_000;
  while (Date.now() < limite) {
    const { value, done } = await lector.read();
    if (done) break;
    acumulado += decoder.decode(value, { stream: true });
    if (acumulado.includes(marca)) return acumulado;
  }
  return acumulado;
}
