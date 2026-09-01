import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { createRoot } from "react-dom/client";
import { mobileApi } from "./mobile-store";
import { Sprite } from "./Sprite";
import type { Quest, RealmSnapshot } from "./types";
import "./styles.css";

type Screen = "gate" | "bastion" | "battle";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const request = async (base = "") => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "La operación no pudo completarse.");
    return body as T;
  };
  if (!Capacitor.isNativePlatform()) return request();
  try {
    return await request("http://127.0.0.1:3000");
  } catch (error) {
    if (error instanceof TypeError) return mobileApi<T>(path, init);
    throw error;
  }
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

function ConnectionGate({
  snapshot,
  busy,
  onEnter,
  onDemo,
  onOpenQuest,
}: {
  snapshot: RealmSnapshot | null;
  busy: boolean;
  onEnter: () => void;
  onDemo: () => void;
  onOpenQuest: () => void;
}) {
  const quest = snapshot?.currentQuest ?? null;
  const progress = quest ? snapshot?.battle?.progress ?? 0 : 78;
  return (
    <main className="scene gate-scene">
      <img className="gate-mockup" src="/assets/art/connection-mockup.png" alt="" aria-hidden="true" />
      <div className="gate-vignette" />
      <section className="gate-title" aria-label="Torreon">
        <div className="gate-keep" aria-hidden="true"><i /></div>
        <h1>TORREON</h1>
        <p>LIFE IS THE CAMPAIGN</p>
      </section>
      <section className="gate-status left-status glass-panel">
        <Codex speaking />
        <div><strong>CÓDICE</strong><span>ONLINE</span></div>
      </section>
      <section className="gate-status right-status glass-panel">
        <div className="mcp-sigil">M</div>
        <div><strong>MCP</strong><span>SECURE LINK</span></div>
      </section>
      <section className="gate-link glass-panel">
        <p className="eyebrow">{quest ? "QUEST SINCRONIZADA" : "CONECTANDO A CÓDICE"}</p>
        <div className="gate-progress" aria-label={`Progreso ${progress}%`}><span style={{ width: `${progress}%` }} /></div>
        <p>{quest ? quest.title : "Estableciendo enlace real con el Dungeon Master."}</p>
        <div className="gate-actions">
          <button className="gold-button" onClick={quest ? onOpenQuest : onDemo} disabled={busy}>
            {quest ? "ABRIR QUEST" : busy ? "INVOCANDO..." : "CREAR QUEST DEMO"}
          </button>
          <button className="ghost-button" onClick={onEnter}>ENTRAR AL BASTIÓN</button>
        </div>
      </section>
    </main>
  );
}

function Menu({ onStart }: { onStart: () => void }) {
  return (
    <main className="scene menu-scene">
      <div className="moon" />
      <div className="distant-castle" aria-hidden="true"><i /><i /><i /></div>
      <div className="march-ground" />
      <section className="game-title">
        <span>LA MARCA DESPIERTA</span>
        <h1>TORREON</h1>
        <p>La vida es la campaña. Cada resultado real cambia el reino.</p>
      </section>
      <section className="menu-actions" aria-label="Menú principal">
        <button className="banner-button primary" onClick={onStart}>INICIAR</button>
        <button className="banner-button" disabled>OPCIONES</button>
        <button className="banner-button" disabled>SALIR</button>
      </section>
      <p className="build-mark">MVP · LA MARCA DESPIERTA</p>
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

function StatusBadge({ status }: { status: Quest["status"] }) {
  const names = { draft: "BORRADOR", accepted: "ACEPTADA", active: "EN BATALLA", completed: "VICTORIA", abandoned: "RETIRADA" };
  return <span className={`status ${status}`}>{names[status]}</span>;
}

function Battle({
  snapshot,
  busy,
  impact,
  onBack,
  onAccept,
  onStart,
}: {
  snapshot: RealmSnapshot;
  busy: boolean;
  impact: number | null;
  onBack: () => void;
  onAccept: () => void;
  onStart: () => void;
}) {
  const quest = snapshot.currentQuest;
  if (!quest) return null;
  const battle = snapshot.battle;
  const health = battle?.enemyHealth ?? 100;
  return (
    <main className={`scene battle-scene ${impact ? "impact" : ""}`}>
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
        <div className="battle-line" />
        <div className="codex-position"><Sprite actor="codex" motion={battle?.isKo ? "victory" : "idle"} label="CÓDICE" /></div>
        <div className="marquis-token"><Sprite actor="marquis" motion={battle?.isKo ? "victory" : impact ? "attack" : "idle"} label="MARQUÉS" /></div>
        <div className="wolf-token"><Sprite actor="wolf" motion={battle?.isKo ? "victory" : "idle"} label="LOBO" /></div>
        <div className="horde-token"><Sprite actor="horde" motion={impact ? "hurt" : "idle"} label="HORDA" /></div>
        {impact ? <div className="damage-number">−{impact}</div> : null}
        {battle?.isKo ? <div className="ko">KO</div> : null}
      </section>

      <aside className="quest-contract parchment">
        <p className="eyebrow">CONTRATO DE MISIÓN · {quest.durationMinutes} MIN</p>
        <h2>{quest.outcome}</h2>
        <p>{quest.rationale}</p>
        <div className="contract-actions">
          {quest.status === "draft" ? <button className="gold-button" disabled={busy} onClick={onAccept}>ACEPTAR CONTRATO</button> : null}
          {quest.status === "accepted" ? <button className="gold-button" disabled={busy} onClick={onStart}>INICIAR BATALLA</button> : null}
          {quest.status === "completed" ? <button className="gold-button" onClick={onBack}>VOLVER AL BASTIÓN</button> : null}
        </div>
      </aside>

      <section className="steps-panel glass-panel">
        <div className="steps-heading"><span>PASOS DE LA QUEST</span><strong>{battle?.completedSteps ?? 0}/{quest.steps.length}</strong></div>
        <div className="steps-list">
          {quest.steps.map((step, index) => (
            <article className={`step ${step.status}`} key={step.id}>
              <span className="step-number">{step.status === "completed" ? "✓" : index + 1}</span>
              <div><strong>{step.title}</strong><small>{step.actor.toUpperCase()} · {step.evidence}</small></div>
              <b>{step.impactAwarded}/{step.weight}</b>
              {quest.status === "active" && step.status !== "completed" ? <em>ENTREGA EVIDENCIA A CÓDICE</em> : null}
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

function App() {
  const requestedScreen = new URLSearchParams(window.location.search).get("screen");
  const initialScreen: Screen = requestedScreen === "bastion" || requestedScreen === "battle" ? requestedScreen : "gate";
  const [screen, setScreen] = useState<Screen>(initialScreen);
  const [snapshot, setSnapshot] = useState<RealmSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [impact, setImpact] = useState<number | null>(null);
  const lastProgress = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const next = await api<RealmSnapshot>("/api/state");
      if (next.battle && next.battle.progress > lastProgress.current) {
        const delta = next.battle.progress - lastProgress.current;
        setImpact(delta);
        window.setTimeout(() => setImpact(null), 900);
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

  if (screen === "gate") {
    return (
      <>
        <ConnectionGate
          snapshot={snapshot}
          busy={busy}
          onEnter={() => setScreen("bastion")}
          onDemo={() => void act(() => api("/api/demo/quest", { method: "POST" })).then(() => setScreen("battle"))}
          onOpenQuest={() => setScreen("battle")}
        />
        {error ? <div className="error-toast" role="alert">{error}</div> : null}
      </>
    );
  }
  if (!snapshot) return <main className="loading"><Codex speaking /><p>El Códice despierta…</p>{error ? <strong>{error}</strong> : null}</main>;

  const quest = snapshot.currentQuest;
  return (
    <>
      {screen === "bastion" ? (
        <Bastion
          snapshot={snapshot}
          busy={busy}
          onDemo={() => void act(() => api("/api/demo/quest", { method: "POST" }))}
          onEnterQuest={() => setScreen("battle")}
          onReset={() => void act(() => api("/api/reset", { method: "POST" }))}
        />
      ) : (
        <Battle
          snapshot={snapshot}
          busy={busy}
          impact={impact}
          onBack={() => setScreen("bastion")}
          onAccept={() => quest && void act(() => api(`/api/quests/${quest.id}/accept`, { method: "POST", body: JSON.stringify({ userAccepted: true }) }))}
          onStart={() => quest && void act(() => api(`/api/quests/${quest.id}/start`, { method: "POST" }))}
        />
      )}
      {error ? <div className="error-toast" role="alert">{error}</div> : null}
    </>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
