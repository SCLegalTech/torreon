import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const baseUrl = process.env.TORREON_URL ?? "http://127.0.0.1:3000";
const edgePath = process.env.EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const output = resolve("artifacts/screenshots");

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: edgePath, headless: true });
const page = await browser.newPage({
  viewport: { width: 804, height: 360 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});

async function shot(name) {
  await page.screenshot({ path: resolve(output, name), fullPage: true });
}

try {
  await page.request.post(`${baseUrl}/api/reset`);
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await shot("01-loading.png");

  await page.getByRole("button", { name: "Encender Torreon" }).click();
  await page.getByRole("button", { name: "CAMPAÑAS Crear quest" }).waitFor();
  await shot("02-realm-menu.png");

  await page.getByRole("button", { name: "CAMPAÑAS Crear quest" }).click();
  await page.getByPlaceholder("Escribe tu intención real. Ej: necesito enviar cinco hojas de vida.").fill("necesito enviar cinco hojas de vida");
  await shot("03-quest-composer.png");

  await page.getByRole("button", { name: "ABRIR CÓDICE" }).click();
  await page.getByRole("button", { name: "ACEPTAR CONTRATO" }).waitFor({ timeout: 90_000 });
  await shot("04-quest-draft.png");

  // Aceptar el contrato transforma la batalla; no abre otra pantalla.
  await page.getByRole("button", { name: "ACEPTAR CONTRATO" }).click();
  await page.getByRole("button", { name: "INICIAR BATALLA" }).waitFor();
  await page.getByText("ACEPTADA", { exact: true }).waitFor();
  await shot("04b-contract-accepted.png");

  await page.getByRole("button", { name: "INICIAR BATALLA" }).click();
  await page.getByText("EN BATALLA").waitFor();
  await shot("05-battle-active.png");

  await page.getByRole("button", { name: /ABRIR ÓRDENES/ }).click();
  const fightingState = await (await page.request.get(`${baseUrl}/api/state`)).json();
  await page.request.post(`${baseUrl}/api/quests/${fightingState.currentQuest.id}/horde-attacks/unexpected-requirement`, {
    data: {
      stepId: fightingState.currentQuest.steps[0].id,
      reason: "La entidad exigió un certificado adicional no contemplado.",
      damage: 7,
    },
  });
  await page.getByText("−7 HP", { exact: true }).waitFor({ timeout: 10_000 });
  await shot("05b-horde-attack-orders-open.png");
  await page.getByRole("button", { name: "CERRAR ÓRDENES", exact: true }).click();

  const state = await (await page.request.get(`${baseUrl}/api/state`)).json();
  for (const step of state.currentQuest.steps) {
    await page.request.post(`${baseUrl}/api/quests/${state.currentQuest.id}/steps/${step.id}/evidence`, {
      data: {
        summary: `Evidencia verificada para ${step.title}`,
        source: "api",
        verdict: "accepted",
        reasoning: "La prueba automatizada satisface la condición pactada.",
        impactAwarded: step.weight,
      },
    });
    await page.waitForTimeout(350);
  }

  await page.getByText("VICTORIA", { exact: true }).waitFor();
  await page.waitForTimeout(900);
  await shot("06-victory-ko.png");

  // La hoja de personaje se abre desde el retrato, sin salir del flujo.
  await page.getByRole("button", { name: "Abrir hoja de personaje" }).click();
  await page.getByText("MAESTRÍA", { exact: true }).waitFor();
  await shot("06b-character-stats.png");
  await page.getByRole("button", { name: "← VOLVER" }).click();

  // E2E foreground: otra superficie cambia el mismo Realm y la app abierta
  // reacciona por eventId, sin refresh manual.
  await page.request.post(`${baseUrl}/api/reset`);
  await page.goto(`${baseUrl}/?screen=realm`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "CAMPAÑAS Crear quest" }).waitFor();
  await page.waitForTimeout(1_800);
  const externalDraft = await (await page.request.post(`${baseUrl}/api/demo/quest`)).json();
  await page.request.post(`${baseUrl}/api/quests/${externalDraft.quest.id}/accept`, { data: { userAccepted: true } });
  await page.request.post(`${baseUrl}/api/quests/${externalDraft.quest.id}/start`);
  await page.getByText("⚔️ NUEVA ORDEN DEL CÓDICE", { exact: true }).waitFor({ timeout: 10_000 });
  await shot("07-realtime-external.png");
  process.stdout.write(`Capturas creadas en ${output}\n`);
} finally {
  await browser.close();
}
