import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { createRoot } from "react-dom/client";
import { Sprite } from "./Sprite";
import type { Quest, RealmSnapshot } from "./types";
import "./styles.css";

type Screen = "loading" | "realm" | "thinking" | "battle";

const API_BASE = Capacitor.isNativePlatform() ? "https://torreon.fly.dev" : "";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "La operación no pudo completarse.");
  return body as T;
}

type RealmNotice = { eventId: string; questId: string; kind: "draft" | "started" | "completed"; title: string; message: string };

function noticeFor(event: RealmSnapshot["realm"]["events"][number]): RealmNotice | null {
  if (event.type === "quest_created") return { eventId: event.id, questId: event.questId, kind: "draft", title: "📜 UN NUEVO PACTO AGUARDA TU SELLO", message: event.message };
  if (event.type === "quest_started") return { eventId: event.id, questId: event.questId, kind: "started", title: "⚔️ NUEVA ORDEN DEL CÓDICE", message: event.message };
  if (event.type === "quest_completed") return { eventId: event.id, questId: event.questId, kind: "completed", title: "🏆 VICTORIA", message: event.message };
  return null;
}

function RealmNoticeToast({ notice, onOpen, onDismiss }: { notice: RealmNotice; onOpen: () => void; onDismiss: () => void }) {
  return (
    <aside className={`realm-notice ${notice.kind}`} role="status">
      <button className="notice-dismiss" type="button" onClick={onDismiss} aria-label="Cerrar aviso">×</button>
      <strong>{notice.title}</strong>
      <p>{notice.message}</p>
      <button className="notice-open" type="button" onClick={onOpen}>VER QUEST</button>
    </aside>
  );
}

function Codex({ speaking = false }: { speaking?: boolean }) {
  return (
    <div className={`codex ${speaking ? "speaking" : ""}`} aria-label="El Códice de la Marca">
      <span className="codex-wing left" />
      <span className="codex-book"><i>Φ</i></span>
      <span className="codex-wing right" />
      <span className="codex-flame" />
    </div>
  );
}

function LoadingGate({ onStart }: { onStart: () => void }) {
  const [powered, setPowered] = useState(false);
  const start = () => {
    if (powered) return;
    setPowered(true);
    window.setTimeout(onStart, 760);
  };
  return (
    <main className={`scene gate-scene ${powered ? "powered" : ""}`}>
      <img className="gate-mockup" src="/assets/art/loading-bg.png" alt="" aria-hidden="true" />
      <div className="gate-vignette" />
      <button className="power-logo" type="button" onClick={start} aria-label="Encender Torreon">
        <img className="logo-off" src="/assets/art/torreon-logo-off.png" alt="Torreon" />
        <img className="logo-on" src="/assets/art/torreon-on.png" alt="" aria-hidden="true" />
      </button>
    </main>
  );
}

function RealmMenu({
  snapshot,
  onCampaign,
  onBattle,
  onReset,
}: {
  snapshot: RealmSnapshot;
  onCampaign: () => void;
  onBattle: () => void;
  onReset: () => void;
}) {
  const quest = snapshot.currentQuest;
  return (
    <main className="scene realm-scene">
      <img className="realm-mockup" src="/assets/art/realm-menu-mockup.png" alt="" aria-hidden="true" />
      <button className="realm-hotspot campaign-hotspot" onClick={onCampaign}>
        <strong>{quest ? "CAMPAÑA ACTIVA" : "CAMPAÑAS"}</strong>
        <span>{quest ? quest.title : "Crear quest"}</span>
      </button>
      <button className="realm-hotspot codex-hotspot" onClick={onCampaign}>
        <strong>CÓDICE</strong>
        <span>Dungeon Master</span>
      </button>
      {quest ? (
        <button className="realm-hotspot battle-hotspot" onClick={onBattle}>
          <strong>FRENTE DE BATALLA</strong>
          <span>{snapshot.battle?.progress ?? 0}% avance</span>
        </button>
      ) : null}
      <button className="realm-icon-button settings-hotspot" onClick={onReset} aria-label="Reiniciar">↻</button>
    </main>
  );
}

function CoreLoop() {
  return (
    <article className="parchment core-loop">
      <p className="eyebrow">SLICE 1 · REAL GAMEPLAY</p>
      <h2>La realidad mueve la batalla</h2>
      <ol>
        <li><b>1</b><span>PROPÓSITO</span></li>
        <li><b>2</b><span>QUEST</span></li>
        <li><b>3</b><span>EVIDENCIA</span></li>
        <li><b>4</b><span>IMPACTO</span></li>
      </ol>
    </article>
  );
}

function Bastion({
  snapshot,
  busy,
  onDemo,
  onEnterQuest,
  onReset,
}: {
  snapshot: RealmSnapshot;
  busy: boolean;
  onDemo: () => void;
  onEnterQuest: () => void;
  onReset: () => void;
}) {
  const quest = snapshot.currentQuest;
  return (
    <main className="scene bastion-scene">
      <header className="player-bar glass-panel">
        <div className="crest">Φ</div>
        <div><strong>{snapshot.realm.player.displayName}</strong><small>{snapshot.realm.player.title}</small></div>
        <span className="bridge-live"><i /> CÓDICE · MCP LOCAL</span>
      </header>
      <section className="bastion-world" aria-label="La Marca">
        <div className="keep" aria-hidden="true"><i /><i /><i /><span>TORREON</span></div>
        <div className="road" />
        <div className="nest" aria-hidden="true"><i /><i /><i /><span>NIDO</span></div>
      </section>
      <CoreLoop />
      <section className="quest-callout glass-panel">
        <Codex speaking />
        <div>
          <p className="eyebrow">EL CÓDICE DE LA MARCA</p>
          {quest ? (
            <>
              <h2>{quest.title}</h2>
              <p>{quest.outcome}</p>
              <button className="gold-button" onClick={onEnterQuest}>ABRIR QUEST</button>
            </>
          ) : (
            <>
              <h2>La mesa está vacía</h2>
              <p>Háblale a Códice desde Codex: dile cualquier tarea real. Él negociará el resultado y la convertirá en quest.</p>
              <button className="gold-button" disabled={busy} onClick={onDemo}>
                {busy ? "INVOCANDO…" : "CARGAR QUEST DEMOSTRATIVA"}
              </button>
            </>
          )}
        </div>
      </section>
      <nav className="bottom-nav glass-panel">
        <button className="active">BASTIÓN</button>
        <button onClick={quest ? onEnterQuest : onDemo}>CAMPAÑA</button>
        <button onClick={onReset}>REINICIAR</button>
      </nav>
    </main>
  );
}

function QuestComposer({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (intent: string) => void;
}) {
  const [intent, setIntent] = useState("");
  return (
    <main className="scene codex-scene" role="dialog" aria-modal="true" aria-label="Declarar quest">
      <img className="codex-book-bg" src="/assets/art/codex-book-mockup.png" alt="" aria-hidden="true" />
      <form
        className="quest-composer"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(intent);
        }}
      >
        <textarea
          value={intent}
          onChange={(event) => setIntent(event.currentTarget.value)}
          placeholder="Escribe tu intención real. Ej: necesito enviar cinco hojas de vida."
          autoFocus
        />
        <button className="codex-submit" type="submit" disabled={busy || intent.trim().length < 8}>
          {busy ? "CÓDICE PIENSA..." : "ABRIR CÓDICE"}
        </button>
      </form>
    </main>
  );
}

function ThinkingScreen({ intent }: { intent: string }) {
  return (
    <main className="scene thinking-scene">
      <img className="codex-book-bg" src="/assets/art/codex-book-mockup.png" alt="" aria-hidden="true" />
      <section className="thinking-panel glass-panel">
        <Codex speaking />
        <p className="eyebrow">CÓDICE INTERPRETA</p>
        <h1>Forjando campaña</h1>
        <p>{intent}</p>
        <div className="thinking-runes" aria-hidden="true"><i /><i /><i /></div>
      </section>
    </main>
  );
}

const verdictNames = { rejected: "RECHAZADA", partial: "PARCIAL", accepted: "ACEPTADA" } as const;

function StatusBadge({ status }: { status: Quest["status"] }) {
  const names = { draft: "BORRADOR", accepted: "ACEPTADA", active: "EN BATALLA", completed: "VICTORIA", abandoned: "RETIRADA" };
  return <span className={`status ${status}`}>{names[status]}</span>;
}

function stepParts(description?: string) {
  const value = description ?? "";
  const match = value.match(/^Épica:\s*(.*?)\s*Real:\s*(.*)$/);
  if (!match) return { epic: value, real: value };
  return { epic: match[1], real: match[2] };
}

export interface PendingFile {
  filename: string;
  mimeType: string;
  dataBase64: string;
  bytes: number;
}

const MAX_EVIDENCE_BYTES = 20 * 1024 * 1024;

/** Convierte lo que el jugador escoge o pega en bytes que el reino puede guardar. */
async function toPendingFile(file: File): Promise<PendingFile> {
  if (file.size > MAX_EVIDENCE_BYTES) {
    throw new Error(`${file.name || "El archivo"} pesa mas de 20 MB.`);
  }
  const buffer = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return {
    filename: file.name || `captura-${Date.now()}.png`,
    mimeType: file.type || "application/octet-stream",
    dataBase64: btoa(binary),
    bytes: file.size,
  };
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * PREPARAR EXPEDICIÓN — trazada sobre el mockup de Diego.
 *
 * De la calca solo se implementa lo que tiene contraparte real en el dominio
 * de hoy: quest seleccionada, victoria, duración pactada, ataque total,
 * recomendación de Códice y consejo de bienestar.
 *
 * Queda como referencia, sin construir (no hay dato real detrás todavía):
 *   - nivel, EXP, oro, gemas y energía del jugador  -> progresión, tajada futura
 *   - modo enfoque y comportamiento del reino       -> fuera del Slice 1
 *   - notificaciones                                -> fuera del Slice 1
 *   - estimado de recursos y aura                   -> Slices 2 y 4
 */
function Expedition({
  snapshot,
  busy,
  onBack,
  onStart,
}: {
  snapshot: RealmSnapshot;
  busy: boolean;
  onBack: () => void;
  onStart: () => void;
}) {
  const quest = snapshot.currentQuest;
  if (!quest) return null;
  const totalAttack = quest.steps.reduce((sum, step) => sum + step.weight, 0);

  return (
    <main className="scene expedition-scene">
      <header className="expedition-top">
        <div className="player-card">
          <span className="player-crest">Φ</span>
          <div>
            <strong>{snapshot.realm.player.displayName}</strong>
            <small>{snapshot.realm.player.title}</small>
          </div>
        </div>
        <div className="campaign-banner">
          <p className="eyebrow">CAMPAÑA ACTIVA</p>
          <h2>{quest.campaignTitle}</h2>
          <small>Quest: {quest.title}</small>
        </div>
      </header>

      <section className="expedition-hero">
        <h1>PREPARAR EXPEDICIÓN</h1>
        <p>Sal del castillo. Tu reino luchará mientras trabajas en el mundo real.</p>
      </section>

      <section className="expedition-field" aria-label="El reino antes de la expedición">
        <div className="field-line" />
        <div className="field-marquis"><Sprite actor="marquis" motion="idle" label="MARQUÉS" /></div>
        <div className="field-wolf"><Sprite actor="wolf" motion="idle" label="LOBO" /></div>
        <div className="field-codex"><Sprite actor="codex" motion="idle" label="CÓDICE" /></div>
        <div className="field-horde"><Sprite actor="horde" motion="idle" label="HORDA" /></div>
      </section>

      <section className="expedition-config">
        <p className="eyebrow">CONFIGURACIÓN DE EXPEDICIÓN</p>
        <div className="config-cards">
          <article className="config-card">
            <p className="eyebrow">DURACIÓN PACTADA</p>
            <strong>{quest.durationMinutes} min</strong>
            <small>Acordada en el contrato</small>
          </article>
          <article className="config-card">
            <p className="eyebrow">OBJETIVO</p>
            <strong>{quest.steps.length} pasos</strong>
            <small>{quest.intent}</small>
          </article>
          <article className="config-card">
            <p className="eyebrow">ATAQUE TOTAL</p>
            <strong>{totalAttack}</strong>
            <small>Solo la evidencia validada lo cobra</small>
          </article>
        </div>
      </section>

      <aside className="expedition-brief parchment">
        <p className="eyebrow">QUEST SELECCIONADA</p>
        <h2>{quest.title}</h2>

        <p className="eyebrow">VICTORIA</p>
        <p className="brief-text">{quest.outcome}</p>

        <p className="eyebrow">RECOMENDACIÓN DE CÓDICE</p>
        <p className="brief-text">{quest.rationale}</p>

        {quest.wellbeingConstraints.length > 0 ? (
          <>
            <p className="eyebrow">CONSEJO</p>
            <ul className="brief-advice">
              {quest.wellbeingConstraints.map((advice) => (
                <li key={advice}>{advice}</li>
              ))}
            </ul>
          </>
        ) : null}
      </aside>

      <nav className="expedition-actions">
        <button className="back-button" type="button" onClick={onBack}>← ATRÁS</button>
        <button className="gold-button start-expedition" type="button" disabled={busy} onClick={onStart}>
          <strong>INICIAR EXPEDICIÓN</strong>
          <small>El reino entrará en batalla mientras trabajas.</small>
        </button>
      </nav>
    </main>
  );
}

function Battle({
  snapshot,
  busy,
  impact,
  onBack,
  onAccept,
  onStart,
  onDeliverEvidence,
}: {
  snapshot: RealmSnapshot;
  busy: boolean;
  impact: number | null;
  onBack: () => void;
  onAccept: () => void;
  onStart: () => void;
  onDeliverEvidence: (stepId: string, note: string, link: string, files: PendingFile[]) => void;
}) {
  const quest = snapshot.currentQuest;
  const [openStepId, setOpenStepId] = useState<string | null>(quest?.steps[0]?.id ?? null);
  const [evidenceNote, setEvidenceNote] = useState("");
  const [evidenceLink, setEvidenceLink] = useState("");
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [ordersOpen, setOrdersOpen] = useState(quest?.status !== "active");
  if (!quest) return null;
  const battle = snapshot.battle;
  const health = battle?.enemyHealth ?? 100;
  return (
    <main className={`scene battle-scene ${impact ? "impact" : ""}`}>
      <img className="battle-art" src="/assets/art/battle-realm.png" alt="El ejército de la Marca combate a la Horda" />
      <header className="battle-header glass-panel">
        <button className="back" onClick={onBack}>‹</button>
        <div><p className="eyebrow">{quest.campaignTitle}</p><h1>{quest.title}</h1></div>
        <StatusBadge status={quest.status} />
      </header>

      <section className="enemy-health glass-panel">
        <div><span>HORDA SUBTERRÁNEA</span><strong>{health} / 100</strong></div>
        <div className="health-track"><span style={{ width: `${health}%` }} /></div>
      </section>

      <section className="battlefield" aria-label="Campo de batalla">
        <span className="battle-pulse ally" aria-hidden="true" />
        <span className="battle-pulse enemy" aria-hidden="true" />
        {impact ? <div className="damage-number">−{impact}</div> : null}
        {battle?.isKo ? <div className="ko">KO</div> : null}
      </section>

      <aside className={`quest-contract parchment ${quest.status}`}>
        <p className="eyebrow">CONTRATO DE MISIÓN · {quest.durationMinutes} MIN</p>
        <h2>{quest.outcome}</h2>
        <p>{quest.rationale}</p>
        {quest.status === "active" ? (
          <button className="orders-button" type="button" onClick={() => setOrdersOpen((open) => !open)}>
            {ordersOpen ? "CERRAR ÓRDENES" : `ABRIR ÓRDENES · ${battle?.completedSteps ?? 0}/${quest.steps.length}`}
          </button>
        ) : null}
        <div className="contract-actions">
          {quest.status === "draft" ? <button className="gold-button" disabled={busy} onClick={onAccept}>ACEPTAR CONTRATO</button> : null}
          {quest.status === "accepted" ? <button className="gold-button" disabled={busy} onClick={onStart}>INICIAR BATALLA</button> : null}
          {quest.status === "completed" ? <button className="gold-button" onClick={onBack}>VOLVER AL BASTIÓN</button> : null}
        </div>
      </aside>

      <section className={`steps-panel glass-panel ${ordersOpen ? "open" : "closed"}`}>
        <div className="steps-heading">
          <span>ÓRDENES DEL CÓDICE</span>
          <strong>{battle?.completedSteps ?? 0}/{quest.steps.length}</strong>
          <button type="button" onClick={() => setOrdersOpen(false)} aria-label="Cerrar órdenes">×</button>
        </div>
        <div className="steps-list">
          {quest.steps.map((step, index) => {
            const isOpen = openStepId === step.id;
            const parts = stepParts(step.description);
            const stepArtifacts = snapshot.realm.artifacts?.filter((artifact) => artifact.stepId === step.id) ?? [];
            const stepVerdicts = snapshot.realm.evidence.filter((record) => record.stepId === step.id);
            return (
              <article className={`step ${step.status} ${isOpen ? "open" : ""}`} key={step.id}>
                <button className="step-summary" type="button" onClick={() => setOpenStepId(isOpen ? null : step.id)}>
                  <span className="step-number">{step.status === "completed" ? "✓" : index + 1}</span>
                  <span><strong>{step.title}</strong><small>{step.actor.toUpperCase()} · {step.evidence}</small></span>
                  <b>{step.impactAwarded}/{step.weight}</b>
                </button>
                {isOpen ? (
                  <div className="step-detail">
                    <p>{parts.epic || "Códice no dejó descripción para este paso."}</p>
                    <dl>
                      <div><dt>Qué hacer</dt><dd>{parts.real || step.title}</dd></div>
                      <div><dt>Qué entregar</dt><dd>{step.evidence}</dd></div>
                    </dl>
                    {stepArtifacts.length > 0 ? (
                      <ul className="artifact-list">
                        {stepArtifacts.map((artifact) => (
                          <li key={artifact.id} className={artifact.verification.verified ? "verified" : "unverified"}>
                            <strong>{artifact.verification.verified ? "✓" : "○"} {artifact.label}</strong>
                            <small>{artifact.verification.detail}</small>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {stepVerdicts.length > 0 ? (
                      <ul className="verdict-list">
                        {stepVerdicts.map((record) => (
                          <li key={record.id} className={record.verdict}>
                            <strong>{verdictNames[record.verdict]} · {record.impactAwarded}</strong>
                            <small>{record.reasoning}</small>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {quest.status === "active" && step.status !== "completed" ? (
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          onDeliverEvidence(step.id, evidenceNote, evidenceLink, pendingFiles);
                          setEvidenceNote("");
                          setEvidenceLink("");
                          setPendingFiles([]);
                        }}
                      >
                        <textarea
                          value={evidenceNote}
                          onChange={(event) => setEvidenceNote(event.currentTarget.value)}
                          onPaste={(event) => {
                            const items = Array.from(event.clipboardData?.files ?? []);
                            if (items.length === 0) return;
                            event.preventDefault();
                            void Promise.all(items.map(toPendingFile))
                              .then((ready) => setPendingFiles((current) => [...current, ...ready]))
                              .catch(() => undefined);
                          }}
                          placeholder="Describe qué ocurrió y pega aquí tu captura (Ctrl+V). Códice juzga la prueba, no el esfuerzo."
                        />
                        {pendingFiles.length > 0 ? (
                          <ul className="pending-files">
                            {pendingFiles.map((file, index) => (
                              <li key={`${file.filename}-${index}`}>
                                <span>{file.filename}</span>
                                <small>{formatBytes(file.bytes)}</small>
                                <button
                                  type="button"
                                  onClick={() => setPendingFiles((current) => current.filter((_, at) => at !== index))}
                                  aria-label={`Quitar ${file.filename}`}
                                >
                                  ×
                                </button>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                        {step.evidenceKind === "photo" ? (
                          <label className="evidence-file evidence-camera">
                            <input
                              type="file"
                              accept="image/*"
                              capture="environment"
                              onChange={(event) => {
                                const photo = event.currentTarget.files?.[0];
                                event.currentTarget.value = "";
                                if (!photo) return;
                                void toPendingFile(photo)
                                  .then((ready) => setPendingFiles((current) => [...current, ready]))
                                  .catch(() => undefined);
                              }}
                            />
                            <span>📷 TOMAR EVIDENCIA</span>
                          </label>
                        ) : null}
                        <label className="evidence-file">
                          <input
                            type="file"
                            multiple
                            accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.md"
                            onChange={(event) => {
                              const chosen = Array.from(event.currentTarget.files ?? []);
                              event.currentTarget.value = "";
                              if (chosen.length === 0) return;
                              void Promise.all(chosen.map(toPendingFile))
                                .then((ready) => setPendingFiles((current) => [...current, ...ready]))
                                .catch(() => undefined);
                            }}
                          />
                          <span>{step.evidenceKind === "photo" ? "ELEGIR FOTO EXISTENTE" : "ADJUNTAR PRUEBA"}</span>
                        </label>
                        <input
                          className="evidence-link"
                          value={evidenceLink}
                          onChange={(event) => setEvidenceLink(event.currentTarget.value)}
                          placeholder="Enlace de la prueba (opcional)"
                        />
                        <button
                          className="gold-button"
                          type="submit"
                          disabled={busy || (evidenceNote.trim().length < 4 && evidenceLink.trim().length < 8 && pendingFiles.length === 0)}
                        >
                          {busy ? "CÓDICE EXAMINA..." : "ENTREGAR AL CÓDICE"}
                        </button>
                      </form>
                    ) : null}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      </section>
    </main>
  );
}

function App() {
  const requestedScreen = new URLSearchParams(window.location.search).get("screen");
  const initialScreen: Screen = requestedScreen === "battle" ? "battle" : requestedScreen === "bastion" || requestedScreen === "realm" ? "realm" : "loading";
  const [screen, setScreen] = useState<Screen>(initialScreen);
  const [snapshot, setSnapshot] = useState<RealmSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [impact, setImpact] = useState<number | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [pendingIntent, setPendingIntent] = useState("");
  const [verdict, setVerdict] = useState<string | null>(null);
  const [notice, setNotice] = useState<RealmNotice | null>(null);
  const lastProgress = useRef(0);
  const seenEventIds = useRef(new Set<string>());
  const eventsHydrated = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const next = await api<RealmSnapshot>("/api/state");
      if (next.battle && next.battle.progress > lastProgress.current) {
        const delta = next.battle.progress - lastProgress.current;
        setImpact(delta);
        window.setTimeout(() => setImpact(null), 900);
      }
      if (!eventsHydrated.current) {
        next.realm.events.forEach((event) => seenEventIds.current.add(event.id));
        eventsHydrated.current = true;
      } else {
        const unseen = next.realm.events.filter((event) => !seenEventIds.current.has(event.id));
        unseen.forEach((event) => seenEventIds.current.add(event.id));
        const narrative = unseen.map(noticeFor).find((candidate): candidate is RealmNotice => candidate !== null);
        if (narrative) setNotice(narrative);
      }
      lastProgress.current = next.battle?.progress ?? 0;
      setSnapshot(next);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No fue posible alcanzar el servidor.");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const act = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "La acción falló.");
    } finally {
      setBusy(false);
    }
  };

  if (screen === "loading") {
    return (
      <>
        <LoadingGate onStart={() => setScreen("realm")} />
        {notice ? <RealmNoticeToast notice={notice} onOpen={() => { setScreen("battle"); setNotice(null); }} onDismiss={() => setNotice(null)} /> : null}
        {error ? <div className="error-toast" role="alert">{error}</div> : null}
      </>
    );
  }
  if (screen === "thinking") return <ThinkingScreen intent={pendingIntent} />;
  if (!snapshot) return <main className="loading"><Codex speaking /><p>El Códice despierta…</p>{error ? <strong>{error}</strong> : null}</main>;

  const quest = snapshot.currentQuest;
  return (
    <>
      {screen === "realm" ? (
        <>
        <RealmMenu
          snapshot={snapshot}
          onCampaign={() => setComposerOpen(true)}
          onBattle={() => setScreen("battle")}
          onReset={() => void act(() => api("/api/reset", { method: "POST" }))}
        />
        {composerOpen ? (
          <QuestComposer
            busy={busy}
            onSubmit={(intent) => {
              setPendingIntent(intent);
              setScreen("thinking");
              void act(() => api("/api/quests/from-intent", { method: "POST", body: JSON.stringify({ intent }) })).then(() => {
                setComposerOpen(false);
                setNotice(null);
                window.setTimeout(() => setScreen("battle"), 520);
              });
            }}
          />
        ) : null}
        </>
      ) : quest && quest.status === "accepted" ? (
        <Expedition
          snapshot={snapshot}
          busy={busy}
          onBack={() => setScreen("realm")}
          onStart={() => void act(() => api(`/api/quests/${quest.id}/start`, { method: "POST" })).then(() => setNotice(null))}
        />
      ) : (
        <Battle
          snapshot={snapshot}
          busy={busy}
          impact={impact}
          onBack={() => setScreen("realm")}
          onAccept={() => quest && void act(() => api(`/api/quests/${quest.id}/accept`, { method: "POST", body: JSON.stringify({ userAccepted: true }) }))}
          onStart={() => quest && void act(() => api(`/api/quests/${quest.id}/start`, { method: "POST" })).then(() => setNotice(null))}
          onDeliverEvidence={(stepId, note, link, files) => {
            if (!quest) return;
            void act(async () => {
              for (const file of files) {
                await api(`/api/quests/${quest.id}/steps/${stepId}/artifacts`, {
                  method: "POST",
                  body: JSON.stringify({
                    kind: "file",
                    dataBase64: file.dataBase64,
                    filename: file.filename,
                    mimeType: file.mimeType,
                  }),
                });
              }
              if (link.trim().length >= 8) {
                await api(`/api/quests/${quest.id}/steps/${stepId}/artifacts`, {
                  method: "POST",
                  body: JSON.stringify({ kind: "link", url: link.trim() }),
                });
              }
              // El veredicto lo emite Códice en el servidor; la APK nunca se
              // concede daño a sí misma.
              const result = await api<{ judgement: { verdict: string; reasoning: string } }>(
                `/api/quests/${quest.id}/steps/${stepId}/verify`,
                { method: "POST", body: JSON.stringify({ note }) },
              );
              setVerdict(result.judgement.reasoning);
              window.setTimeout(() => setVerdict(null), 6000);
              return result;
            });
          }}
        />
      )}
      {verdict ? <div className="verdict-toast" role="status">{verdict}</div> : null}
      {snapshot ? <small className="realm-debug">{snapshot.consistency.instance} · {snapshot.consistency.realmId.slice(0, 8)}</small> : null}
      {notice ? <RealmNoticeToast notice={notice} onOpen={() => { setScreen("battle"); setNotice(null); }} onDismiss={() => setNotice(null)} /> : null}
      {error ? <div className="error-toast" role="alert">{error}</div> : null}
    </>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
