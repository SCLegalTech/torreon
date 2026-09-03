import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QuestPlanInput, RealmState } from "./domain.js";
import { QuestService } from "./quest-service.js";
import { JsonRealmStore } from "./store.js";

/**
 * CENTRO DE NOTIFICACIONES.
 *
 * A PUSH IS A KNOCK ON THE GATE. THE NOTIFICATION CENTER IS THE RECORD.
 * A KNOCK MAY BE MISSED. THE PACT MUST NOT DISAPPEAR.
 */

function planFor(title: string): QuestPlanInput {
  return {
    campaignTitle: undefined,
    title,
    intent: `Avanzar ${title}.`,
    outcome: `${title} queda cerrado de forma verificable.`,
    rationale: "Una Quick Battle real de diez minutos.",
    durationMinutes: 10,
    wellbeingConstraints: [],
    allowedApps: [],
    steps: [{ title: "Cerrar el frente", actor: "user", evidence: "Constancia", evidenceKind: "declaration", weight: 100 }],
  };
}

describe("Centro de Notificaciones", () => {
  let directory: string;
  let statePath: string;
  let store: JsonRealmStore;
  let service: QuestService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "torreon-notif-"));
    statePath = join(directory, "state.json");
    store = new JsonRealmStore(statePath);
    await store.init();
    service = new QuestService(store, undefined, directory, "torreon-notif-test");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("N-001/N-002: dos Quests seguidas conservan DOS notificaciones; la última no borra la primera", async () => {
    const a = await service.createDraft(planFor("El Tributo del Refugio"));
    const b = await service.createDraft(planFor("El Sello de la Señal"));

    const { notifications } = await service.getNotifications({});
    const forA = notifications.find((n) => n.entityId === a.id);
    const forB = notifications.find((n) => n.entityId === b.id);
    expect(forA).toBeTruthy();
    expect(forB).toBeTruthy();
    // Deep link EXACTO por entityId, nunca por título.
    expect(forA!.deepLink).toEqual({ screen: "quest", entityId: a.id });
    expect(forB!.deepLink.entityId).toBe(b.id);
    // Push es un intento de entrega; su estado no implica «visto».
    expect(forA!.push.attempts).toBeGreaterThanOrEqual(1);
  });

  it("N-004: resend usa el mismo id, suma un intento y NO duplica Quest ni NotificationRecord", async () => {
    const a = await service.createDraft(planFor("El Tributo del Refugio"));
    const { notifications: first } = await service.getNotifications({});
    const notif = first.find((n) => n.entityId === a.id)!;
    const attemptsBefore = notif.push.attempts;

    const resent = await service.resendNotification(notif.id);
    expect(resent.id).toBe(notif.id);
    expect(resent.push.attempts).toBe(attemptsBefore + 1);

    const after = await service.snapshot();
    expect(after.realm.quests).toHaveLength(1);
    expect(after.realm.notifications.filter((n) => n.entityId === a.id)).toHaveLength(1);
  });

  it("resend_entity_notification reenvía sin crear una nueva y falla si no existe", async () => {
    const a = await service.createDraft(planFor("El Tributo del Refugio"));
    const record = await service.resendEntityNotification({ entityType: "quest", entityId: a.id, notificationType: "quest_created" });
    expect(record.entityId).toBe(a.id);
    expect(record.push.attempts).toBeGreaterThanOrEqual(2);
    await expect(
      service.resendEntityNotification({ entityType: "campaign", entityId: a.id }),
    ).rejects.toThrow(/no crea una nueva/i);
  });

  it("N-006: recibir la notificación de B no cambia el foco", async () => {
    const a = await service.createDraft(planFor("El Tributo del Refugio"));
    await service.focusQuest(a.id);
    await service.createDraft(planFor("El Sello de la Señal"));
    const snapshot = await service.snapshot();
    expect(snapshot.hierarchy.focusedQuestId).toBe(a.id);
    expect(snapshot.focusedQuest?.id).toBe(a.id);
    // Y no hay ninguna Battle comprometida.
    expect(snapshot.hierarchy.engagedQuestId).toBeNull();
  });

  it("N-005: abrir el deep link no acepta ni inicia — sólo mueve la mirada", async () => {
    const a = await service.createDraft(planFor("El Tributo del Refugio"));
    const snapshot = await service.focusQuest(a.id);
    expect(snapshot.focusedQuest?.status).toBe("draft");
    // El reloj no corre: no hay Battle comprometida por mirar un borrador.
    expect(snapshot.battle?.clock).toBeNull();
    expect(snapshot.battle?.status).toBe("pending");
    expect(snapshot.hierarchy.engagedQuestId).toBeNull();
  });

  it("N-007/N-008: badge de no leídas y marcar como leída", async () => {
    await service.createDraft(planFor("El Tributo del Refugio"));
    await service.createDraft(planFor("El Sello de la Señal"));
    await service.createDraft(planFor("El Ojo Que Ve Atrás"));

    let snapshot = await service.snapshot();
    expect(snapshot.unreadNotifications).toBe(3);

    const first = snapshot.notifications[0];
    await service.markNotificationRead(first.id);
    snapshot = await service.snapshot();
    expect(snapshot.unreadNotifications).toBe(2);
    expect(snapshot.notifications.find((n) => n.id === first.id)?.read).toBe(true);
  });

  it("archivar saca del Centro sin borrar historia", async () => {
    await service.createDraft(planFor("El Tributo del Refugio"));
    const snapshot = await service.snapshot();
    const notif = snapshot.notifications[0];
    await service.archiveNotification(notif.id);
    const after = await service.snapshot();
    expect(after.notifications.find((n) => n.id === notif.id)).toBeUndefined();
    // Sigue en el registro persistente, sólo archivada.
    expect(after.realm.notifications.find((n) => n.id === notif.id)?.archivedAt).toBeTruthy();
  });

  it("N-003 + backfill: una Quest existente sin notificación recibe una al leer el reino", async () => {
    // Se simula un reino escrito ANTES del Centro de Notificaciones.
    const draft = await service.createDraft(planFor("El Tributo del Refugio"));
    const raw = JSON.parse(await readFile(statePath, "utf8")) as RealmState;
    raw.notifications = [];
    delete (raw as { notificationsBackfilledAt?: string }).notificationsBackfilledAt;
    await writeFile(statePath, JSON.stringify(raw, null, 2), "utf8");

    const migrated = await new QuestService(new JsonRealmStore(statePath), undefined, directory, "torreon-notif-test").snapshot();
    const notif = migrated.notifications.find((n) => n.entityId === draft.id);
    expect(notif).toBeTruthy();
    expect(notif!.type).toBe("quest_created");
    // El dominio no se recreó: sigue habiendo una sola Quest.
    expect(migrated.realm.quests).toHaveLength(1);
  });

  it("el id de una notificación por backfill es estable entre lecturas y se puede reenviar", async () => {
    // Reino escrito antes del Centro: la notificación nace del backfill.
    const draft = await service.createDraft(planFor("El Tributo del Refugio"));
    const raw = JSON.parse(await readFile(statePath, "utf8")) as RealmState;
    raw.notifications = [];
    await writeFile(statePath, JSON.stringify(raw, null, 2), "utf8");
    const fresh = new QuestService(new JsonRealmStore(statePath), undefined, directory, "torreon-notif-test");

    const first = (await fresh.getNotifications({})).notifications.find((n) => n.entityId === draft.id)!;
    const second = (await fresh.getNotifications({})).notifications.find((n) => n.entityId === draft.id)!;
    expect(second.id).toBe(first.id);

    const resent = await fresh.resendNotification(first.id);
    expect(resent.id).toBe(first.id);
    expect(resent.push.attempts).toBeGreaterThanOrEqual(1);
    // Y sigue habiendo una sola Quest y un solo registro.
    const snapshot = await fresh.snapshot();
    expect(snapshot.realm.quests).toHaveLength(1);
    expect(snapshot.realm.notifications.filter((n) => n.entityId === draft.id)).toHaveLength(1);
  });

  it("un frente en espera externa y un replan disponible producen avisos de alta prioridad", async () => {
    const draft = await service.createDraft(planFor("El Tributo del Refugio"));
    await service.accept(draft.id, true);
    const active = await service.start(draft.id);
    const proposal = await service.proposeAmendment(active.id, {
      reason: "La contraparte todavía no publicó el anexo que este frente necesita.",
      proposedBy: "codice",
      changes: active.steps.map((step) => ({
        type: "MARK_EXTERNAL_BLOCKER" as const,
        stepId: step.id,
        blockedBy: "Contraparte",
        blockedReason: "Debe publicar el anexo antes de poder continuar.",
        playerActionAvailable: false,
      })),
    });
    await service.acceptAmendment(active.id, proposal.id, true);

    const snapshot = await service.snapshot();
    const waiting = snapshot.notifications.find((n) => n.type === "quest_waiting_external" && n.entityId === draft.id);
    expect(waiting?.priority).toBe("high");
  });

  it("filtra por no leídas y por tipo de entidad", async () => {
    await service.createDraft(planFor("El Tributo del Refugio"));
    const { campaign } = await service.createCampaignDraft({ title: "La Forja de Solve & Coagula" });
    void campaign;

    const onlyQuests = await service.getNotifications({ entityType: "quest" });
    expect(onlyQuests.notifications.every((n) => n.entityType === "quest")).toBe(true);
    const onlyCampaigns = await service.getNotifications({ entityType: "campaign" });
    expect(onlyCampaigns.notifications.every((n) => n.entityType === "campaign")).toBe(true);
    expect(onlyCampaigns.notifications.length).toBeGreaterThan(0);

    const notif = onlyQuests.notifications[0];
    await service.markNotificationRead(notif.id);
    const unread = await service.getNotifications({ unreadOnly: true });
    expect(unread.notifications.every((n) => !n.read)).toBe(true);
    expect(unread.notifications.find((n) => n.id === notif.id)).toBeUndefined();
  });
});
