import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const baseUrl = process.env.TORREON_URL ?? "http://127.0.0.1:3000";
const edgePath = process.env.EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const output = resolve("artifacts/screenshots");

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: edgePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

async function shot(name) {
  await page.screenshot({ path: resolve(output, name), fullPage: true });
}

try {
  await page.request.post(`${baseUrl}/api/reset`);
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await shot("01-menu.png");

  await page.getByRole("button", { name: "INICIAR" }).click();
  await page.getByText("La mesa está vacía").waitFor();
  await shot("02-bastion.png");

  await page.getByRole("button", { name: "INVOCAR MISIÓN DE PRUEBA" }).click();
  await page.getByRole("button", { name: "ABRIR QUEST" }).waitFor();
  await shot("03-bastion-quest.png");

  await page.getByRole("button", { name: "ABRIR QUEST" }).click();
  await page.getByRole("button", { name: "ACEPTAR CONTRATO" }).waitFor();
  await shot("04-quest-draft.png");

  await page.getByRole("button", { name: "ACEPTAR CONTRATO" }).click();
  await page.getByRole("button", { name: "INICIAR BATALLA" }).waitFor();
  await page.getByRole("button", { name: "INICIAR BATALLA" }).click();
  await page.getByText("EN BATALLA").waitFor();
  await shot("05-battle-active.png");

  while (await page.getByRole("button", { name: "ATACAR", disabled: false }).count()) {
    const attacks = page.getByRole("button", { name: "ATACAR", disabled: false });
    page.once("dialog", (dialog) => dialog.accept("Evidencia verificada por la prueba del MVP"));
    await attacks.first().click();
    await page.waitForTimeout(250);
  }

  await page.getByText("VICTORIA").waitFor();
  await shot("06-victory-ko.png");
  process.stdout.write(`Capturas creadas en ${output}\n`);
} finally {
  await browser.close();
}
