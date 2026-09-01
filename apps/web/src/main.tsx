import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Quest, QuestStep, RealmSnapshot } from "./types";
import "./styles.css";

type Screen = "menu" | "bastion" | "battle";

const currency = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "La operación no pudo completarse.");
  return body as T;
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

function Menu({ onStart }: { onStart: () => void }) {
  return (
    <main className="scene menu-scene">
      <div className="vignette" />
      <section className="menu-actions" aria-label="Menú principal">
        <button className="banner-button primary" onClick={onStart}>INICIAR</button>
        <button className="banner-button" disabled>OPCIONES</button>
        <button className="banner-button" disabled>SALIR</button>
      </section>
      <p className="build-mark">MVP · LA MARCA DESPIERTA</p>
    </main>
  );
}

function FinancialFront({ snapshot }: { snapshot: RealmSnapshot }) {
  const f = snapshot.realm.financial;
  const safety = Math.max(0, Math.min(100, 50 + snapshot.projectedMargin / Math.max(1, f.reserveTarget) * 50));
  return (
    <article className="parchment finance-card">
      <p className="eyebrow">LÍNEA DEL FRENTE</p>
      <h2>{snapshot.projectedMargin >= 0 ? "La marca resiste" : "La horda avanza"}</h2>
      <div className="frontline"><span style={{ width: `${safety}%` }} /></div>
      <dl>
        <div><dt>Disponible</dt><dd>{currency.format(f.availableBalance)}</dd></div>
        <div><dt>Ingresos esperados</dt><dd>{currency.format(f.expectedIncome)}</dd></div>
        <div><dt>Compromisos</dt><dd>{currency.format(f.committedExpenses)}</dd></div>
        <div className="margin"><dt>Margen proyectado</dt><dd>{currency.format(snapshot.projectedMargin)}</dd></div>
      </dl>
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
      <div className="vignette" />
      <header className="player-bar glass-panel">
        <div className="crest">Φ</div>
        <div><strong>{snapshot.realm.player.displayName}</strong><small>{snapshot.realm.player.title}</small></div>
        <span className="coin">{currency.format(snapshot.realm.financial.availableBalance)}</span>
      </header>
      <FinancialFront snapshot={snapshot} />
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
              <p>Conecta ChatGPT por MCP o invoca la misión demostrativa para probar la campaña.</p>
              <button className="gold-button" disabled={busy} onClick={onDemo}>
                {busy ? "INVOCANDO…" : "INVOCAR MISIÓN DE PRUEBA"}
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
  onComplete,
}: {
  snapshot: RealmSnapshot;
  busy: boolean;
  impact: number | null;
  onBack: () => void;
  onAccept: () => void;
  onStart: () => void;
  onComplete: (step: QuestStep) => void;
}) {
  const quest = snapshot.currentQuest;
  if (!quest) return null;
  const battle = snapshot.battle;
  const health = battle?.enemyHealth ?? 100;
  return (
    <main className={`scene battle-scene ${impact ? "impact" : ""}`}>
      <div className="vignette" />
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
        <div className="codex-position"><Codex speaking={quest.status === "active"} /><small>CÓDICE</small></div>
        <div className="marquis-token"><span>Φ</span><small>MARQUÉS</small></div>
        <div className="wolf-token"><span>◆</span><small>LOBO</small></div>
        <div className="horde-token"><span>☠</span><small>HORDA</small></div>
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
              <b>{step.weight}</b>
              <button
                disabled={busy || quest.status !== "active" || step.status === "completed"}
                onClick={() => onComplete(step)}
              >ATACAR</button>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

function App() {
  const requestedScreen = new URLSearchParams(window.location.search).get("screen");
  const initialScreen: Screen = requestedScreen === "bastion" || requestedScreen === "battle" ? requestedScreen : "menu";
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

  if (screen === "menu") return <Menu onStart={() => setScreen("bastion")} />;
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
          onComplete={(step) => {
            if (!quest) return;
            const evidenceNote = window.prompt(`Evidencia para «${step.title}»:`, step.evidence);
            if (evidenceNote) void act(() => api(`/api/quests/${quest.id}/steps/${step.id}/complete`, { method: "POST", body: JSON.stringify({ evidenceNote }) }));
          }}
        />
      )}
      {error ? <div className="error-toast" role="alert">{error}</div> : null}
    </>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
