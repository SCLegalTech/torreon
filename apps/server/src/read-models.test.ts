import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { demoQuest, QuestService } from "./quest-service.js";
import { JsonRealmStore } from "./store.js";
import { fixedClock } from "./clock.js";

/**
 * EL RELOJ DEL REINO SE PLANTA (artículo 8, ADR-0006). Sin esto, la presión y
 * las ventanas críticas dependían del tiempo real que tardara la suite, y la
 * misma prueba pasaba aislada y fallaba bajo carga.
 */
const RELOJ_DEL_REINO = "2026-05-11T09:00:00.000Z";

/**
 * Regresiones del reporte TORREON_FIX_MISSION_STATE_DESYNC.
 *
 * La causa raíz reportada (desincronización de estado) resultó ser falsa: eran
 * dos instancias distintas de Torreón. Estas pruebas fijan por escrito que el
 * ciclo de vida sí persiste, y cubren la señal que sí faltaba —saber con qué
 * reino se está hablando— para que el diagnóstico no vuelva a errarse.
 */
describe("Lectura del reino para el Dungeon Master", () => {
  let directory: string;
  let statePath: string;
  let service: QuestService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "torreon-read-"));
    statePath = join(directory, "state.json");
    const store = new JsonRealmStore(statePath);
    await store.init();
    service = new QuestService(store, undefined, directory, "torreon-prueba", fixedClock(RELOJ_DEL_REINO));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("TEST-R-001: una quest iniciada sigue activa en una lectura posterior", async () => {
    const draft = await service.createDraft(demoQuest);
    await service.accept(draft.id, true);
    await service.start(draft.id);

    // Servicio y store nuevos: si el estado viviera en memoria, esto fallaría.
    const otroStore = new JsonRealmStore(statePath);
    await otroStore.init();
    const otroServicio = new QuestService(otroStore, undefined, directory, "torreon-prueba", fixedClock(RELOJ_DEL_REINO));

    const snapshot = await otroServicio.snapshot();
    expect(snapshot.currentQuest?.id).toBe(draft.id);
    expect(snapshot.currentQuest?.status).toBe("active");
    expect(snapshot.currentQuest?.startedAt).toBeTruthy();
    expect(snapshot.consistency.activeQuestCount).toBe(1);
    expect(snapshot.consistency.currentQuestId).toBe(draft.id);
  });

  it("TEST-R-002: un reino vacío avisa que la campaña puede vivir en otra instancia", async () => {
    const snapshot = await service.snapshot();
    expect(snapshot.currentQuest).toBeNull();
    expect(snapshot.battle).toBeNull();
    expect(snapshot.consistency.status).toBe("warning");
    expect(snapshot.consistency.instance).toBe("torreon-prueba");
    const vacio = snapshot.consistency.issues.find((issue) => issue.code === "EMPTY_REALM");
    expect(vacio?.message).toContain("otra instancia");
  });

  it("TEST-R-003: el progreso sale del impacto validado, no de los pasos marcados", async () => {
    const draft = await service.createDraft(demoQuest);
    await service.accept(draft.id, true);
    const active = await service.start(draft.id);

    await service.submitEvidence(active.id, active.steps[0].id, {
      summary: "Criterios definidos y registrados.",
      source: "user_declaration",
      verdict: "partial",
      reasoning: "Faltó el horario.",
      impactAwarded: 6,
    });

    const snapshot = await service.snapshot();
    expect(snapshot.progress?.validatedImpact).toBe(6);
    expect(snapshot.progress?.percent).toBe(6);
    expect(snapshot.progress?.remainingImpact).toBe(94);
    // Ningún paso está completo, pero el progreso ya avanzó: parcial es progreso.
    expect(snapshot.progress?.completedSteps).toBe(0);
    expect(snapshot.currentStep?.id).toBe(active.steps[0].id);
    expect(snapshot.currentStep?.remainingImpact).toBe(active.steps[0].weight - 6);
  });

  it("TEST-R-004: el detalle une artefactos y veredictos bajo su paso", async () => {
    const draft = await service.createDraft(demoQuest);
    await service.accept(draft.id, true);
    const active = await service.start(draft.id);
    const step = active.steps[0];

    await service.attestArtifact(active.id, step.id, {
      kind: "file",
      label: "constancia-enero.pdf",
      observed: "PDF de una página con el radicado 2026-0001 y fecha 15 de enero.",
      witness: "chatgpt",
    });
    await service.verifyStep(active.id, step.id, { note: "Adjunté la constancia de enero." });

    const detail = await service.questDetail(active.id);
    const detalleDelPaso = detail.steps.find((candidate) => candidate.id === step.id)!;
    expect(detalleDelPaso.artifacts).toHaveLength(1);
    expect(detalleDelPaso.artifacts[0].verification.verifiedBy).toBe("witness");
    expect(detalleDelPaso.artifacts[0].verification.witness).toBe("chatgpt");
    expect(detalleDelPaso.verdicts).toHaveLength(1);
    expect(detail.progress.validatedImpact).toBeGreaterThan(0);
  });

  it("el paso actual avanza al siguiente cuando el anterior queda cerrado", async () => {
    const draft = await service.createDraft(demoQuest);
    await service.accept(draft.id, true);
    const active = await service.start(draft.id);

    await service.completeStep(active.id, active.steps[0].id, "Criterios completos y registrados.");

    const snapshot = await service.snapshot();
    expect(snapshot.currentStep?.id).toBe(active.steps[1].id);
    expect(snapshot.currentStep?.position).toBe(2);
  });

  it("rechaza transiciones ilegales del ciclo de vida", async () => {
    const draft = await service.createDraft(demoQuest);

    // DRAFT -> ACTIVE
    await expect(service.start(draft.id)).rejects.toThrow("aceptada");

    await service.accept(draft.id, true);
    // ACCEPTED -> ACCEPTED
    await expect(service.accept(draft.id, true)).rejects.toThrow("borrador");

    await service.start(draft.id);
    // ACTIVE -> ACTIVE
    await expect(service.start(draft.id)).rejects.toThrow("aceptada");

    await service.abandon(draft.id, "prueba");
    // ABANDONED -> ACTIVE
    await expect(service.start(draft.id)).rejects.toThrow("aceptada");
    await expect(service.abandon(draft.id, "otra vez")).rejects.toThrow("no puede abandonarse");
  });

  it("una quest que no existe es un error identificable, no genérico", async () => {
    // El `code: QUEST_NOT_FOUND` improvisado se convirtió en una clase del
    // dominio, que el borde traduce a 404 sin adivinar por el texto.
    await expect(service.questDetail("00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({
      kind: "not_found",
    });
  });
});
