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
  await page.getByRole("button", { name: "ACEPTAR CONTRATO" }).waitFor();
  await shot("04-quest-draft.png");

  await page.getByRole("button", { name: "ACEPTAR CONTRATO" }).click();
  await page.getByRole("button", { name: "INICIAR BATALLA" }).waitFor();
  await page.getByRole("button", { name: "INICIAR BATALLA" }).click();
  await page.getByText("EN BATALLA").waitFor();
  await shot("05-battle-active.png");

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

  await page.getByText("VICTORIA").waitFor();
  await page.waitForTimeout(900);
  await shot("06-victory-ko.png");
  process.stdout.write(`Capturas creadas en ${output}\n`);
} finally {
  await browser.close();
}
