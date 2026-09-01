import { resolve } from "node:path";
import { createHttpApp } from "./app.js";
import { QuestService } from "./quest-service.js";
import { JsonRealmStore } from "./store.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const statePath = resolve(process.env.TORREON_STATE_PATH ?? "./data/torreon-state.json");

const store = new JsonRealmStore(statePath);
await store.init();
const service = new QuestService(store);
const app = createHttpApp(service);

app.listen(port, host, () => {
  process.stdout.write(`Torreón listo en http://${host}:${port}\nMCP: http://${host}:${port}/mcp\n`);
});

