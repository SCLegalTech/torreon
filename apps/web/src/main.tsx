import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { createRoot } from "react-dom/client";
import { Sprite } from "./Sprite";
import type { ActView, BattleClock, BattleStatus, CampaignView, CharacterStats, EntityType, PartyMemberId, PartyState, Quest, RealmSnapshot } from "./types";
import "./styles.css";

type Screen = "loading" | "realm" | "thinking" | "campaign" | "act" | "quest" | "battle" | "stats";

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

/**
 * AVISO DIRIGIDO.
 *
 * Un aviso lleva SIEMPRE la entidad exacta que cambió. Nunca «el último
 * borrador» ni «la quest actual»: si Códice traza dos pactos seguidos, tocar
 * el primero tiene que abrir el primero.
 */
type RealmNotice = {
  eventId: string;
  entityType: EntityType;
  entityId: string;
  kind: "draft" | "started" | "completed" | "amended" | "blocked" | "danger" | "campaign";
  title: string;
  message: string;
  cta: string;
};

function noticeFor(event: RealmSnapshot["realm"]["events"][number]): RealmNotice | null {
  const entityType = event.entityType ?? "quest";
  const entityId = event.entityId ?? event.questId ?? "";
  if (!entityId) return null;
  const base = { eventId: event.id, entityType, entityId, message: event.message };

  if (event.type === "campaign_created") return { ...base, kind: "campaign", title: "🏰 NUEVA CAMPAÑA TRAZADA", cta: "REVISAR" };
  if (event.type === "campaign_accepted") return { ...base, kind: "campaign", title: "⚔️ CAMPAÑA ACTIVA", cta: "VER CAMPAÑA" };
  if (event.type === "campaign_completed") return { ...base, kind: "completed", title: "🏆 CAMPAÑA CONQUISTADA", cta: "VER CAMPAÑA" };
  if (event.type === "quest_created") return { ...base, kind: "draft", title: "📜 UN NUEVO PACTO AGUARDA TU SELLO", cta: "REVISAR" };
  if (event.type === "quest_started") return { ...base, kind: "started", title: "⚔️ NUEVA ORDEN DEL CÓDICE", cta: "VER BATALLA" };
  if (event.type === "quest_completed") return { ...base, kind: "completed", title: "🏆 VICTORIA", cta: "VER BATALLA" };
  if (event.type === "quest_amendment_proposed") return { ...base, kind: "amended", title: "⚔️ EL CAMPO DE BATALLA PUEDE CAMBIAR", cta: "VER BATALLA" };
  if (event.type === "quest_amended") return { ...base, kind: "amended", title: "🗺️ PLAN ACTUALIZADO", cta: "VER BATALLA" };
  if (event.type === "quest_waiting_external") return { ...base, kind: "blocked", title: "🔒 FRENTE BLOQUEADO POR UN TERCERO", cta: "VER QUEST" };
  if (event.type === "quest_unblocked") return { ...base, kind: "started", title: "🔓 EL FRENTE VUELVE A ABRIRSE", cta: "VER BATALLA" };
  if (event.type === "horde_attack") return { ...base, kind: "danger", title: "💥 LA HORDA CONTRAATACA", cta: "VER BATALLA" };
  return null;
}

function RealmNoticeToast({ notice, onOpen, onDismiss }: { notice: RealmNotice; onOpen: () => void; onDismiss: () => void }) {
  return (
    <aside className={`realm-notice ${notice.kind}`} role="status">
      <button className="notice-dismiss" type="button" onClick={onDismiss} aria-label="Cerrar aviso">×</button>
      <strong>{notice.title}</strong>
      <p>{notice.message}</p>
      <button className="notice-open" type="button" onClick={onOpen}>{notice.cta}</button>
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
  onCodex,
  onBattle,
  onStats,
  onReset,
}: {
  snapshot: RealmSnapshot;
  onCampaign: () => void;
  onCodex: () => void;
  onBattle: () => void;
  onStats: () => void;
  onReset: () => void;
}) {
  const quest = snapshot.currentQuest;
  const stats = statsOf(snapshot);
  const [confirmingReset, setConfirmingReset] = useState(false);
  return (
    <main className="scene realm-scene">
      <img className="realm-mockup" src="/assets/art/realm-menu-mockup.png" alt="" aria-hidden="true" />
      <button className="realm-hotspot character-hotspot" onClick={onStats}>
        <strong>{stats.displayName.toUpperCase()}</strong>
        <span>{stats.hp} HP · {stats.xp} XP · {stats.aura} Aura</span>
      </button>
      <button className="realm-hotspot campaign-hotspot" onClick={onCampaign}>
        <strong>{quest ? "CAMPAÑA ACTIVA" : "CAMPAÑAS"}</strong>
        <span>{quest ? quest.title : "Crear quest"}</span>
      </button>
      <button className="realm-hotspot codex-hotspot" onClick={onCodex}>
        <strong>CÓDICE</strong>
        <span>Dungeon Master</span>
      </button>
      {quest ? (
        <button className="realm-hotspot battle-hotspot" onClick={onBattle}>
          <strong>FRENTE DE BATALLA</strong>
          <span>{snapshot.battle?.progress ?? 0}% avance</span>
        </button>
      ) : null}
      <button className="realm-icon-button settings-hotspot" onClick={() => setConfirmingReset(true)} aria-label="Reiniciar reino">↻</button>
      {/* Reiniciar borra gameplay real: nunca puede dispararse de un solo toque. */}
      {confirmingReset ? (
        <div className="reset-confirm" role="dialog" aria-modal="true" aria-label="Confirmar reinicio del reino">
          <article>
            <strong>¿Reiniciar el reino?</strong>
            <p>Esto eliminará las quests activas y el progreso actual. Esta acción no se puede deshacer.</p>
            <div className="reset-actions">
              <button className="back-button" type="button" onClick={() => setConfirmingReset(false)}>CANCELAR</button>
              <button
                className="destructive-button"
                type="button"
                onClick={() => {
                  setConfirmingReset(false);
                  onReset();
                }}
              >
                REINICIAR REINO
              </button>
            </div>
          </article>
        </div>
      ) : null}
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
  onClose,
  onSubmit,
}: {
  busy: boolean;
  onClose: () => void;
  onSubmit: (intent: string) => void;
}) {
  const [intent, setIntent] = useState("");
  return (
    <main className="scene codex-scene" role="dialog" aria-modal="true" aria-label="Declarar quest">
      <img className="codex-book-bg" src="/assets/art/codex-book-mockup.png" alt="" aria-hidden="true" />
      <button className="back-button composer-back" type="button" onClick={onClose}>← VOLVER</button>
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
  const names = { draft: "BORRADOR", accepted: "ACEPTADA", active: "EN BATALLA", waiting_external: "ESPERA EXTERNA", completed: "VICTORIA", abandoned: "RETIRADA" };
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

function formatTreasure(amount: number, currency: string): string {
  return `${new Intl.NumberFormat("es-CO").format(amount)} ${currency}`;
}

/**
 * Una APK nueva puede hablar con un servidor viejo que todavía no envía la hoja
 * de personaje. En ese caso se arma con lo que el reino sí sabe, para que el
 * teléfono nunca se quede en blanco por un campo que falta.
 */
function statsOf(snapshot: RealmSnapshot): CharacterStats {
  return (
    snapshot.stats ?? {
      displayName: snapshot.realm.player.displayName,
      title: snapshot.realm.player.title,
      hp: snapshot.battle?.playerHealth ?? 100,
      maxHp: 100,
      xp: 0,
      aura: 0,
      mastery: [],
      treasure: { currency: snapshot.realm.financial.currency, amount: snapshot.realm.financial.availableBalance },
    }
  );
}

/**
 * HOJA DE PERSONAJE.
 *
 * Cuatro cifras que el reino ya sabe defender:
 *   HP      — estado del frente abierto, no salud médica.
 *   Aura    — calidad de vida ganada por resultados, no por actividad.
 *   XP      — progresión concedida solo por evidencia validada.
 *   Tesoro  — dinero real del reino; ninguna quest fabrica monedas.
 *
 * Queda como referencia, sin construir: nivel, gemas, energía y equipo.
 */
function CharacterSheet({ snapshot, onBack }: { snapshot: RealmSnapshot; onBack: () => void }) {
  const stats = statsOf(snapshot);
  return (
    <main className="scene stats-scene">
      <header className="stats-top">
        <button className="back-button" type="button" onClick={onBack}>← VOLVER</button>
        <div className="player-card">
          <span className="player-crest">Φ</span>
          <div>
            <strong>{stats.displayName}</strong>
            <small>{stats.title}</small>
          </div>
        </div>
      </header>

      <section className="stats-portrait" aria-label="El Marqués">
        <Sprite actor="marquis" motion="idle" label="MARQUÉS" />
      </section>

      <section className="stats-grid" aria-label="Estadísticas del personaje">
        <article className="config-card">
          <p className="eyebrow">HP</p>
          <strong>{stats.hp} / {stats.maxHp}</strong>
          <small>Estado de combate del frente abierto</small>
        </article>
        <article className="config-card">
          <p className="eyebrow">AURA</p>
          <strong>{stats.aura}</strong>
          <small>Calidad de vida ganada en el mundo real</small>
        </article>
        <article className="config-card">
          <p className="eyebrow">XP</p>
          <strong>{stats.xp}</strong>
          <small>Solo la evidencia validada la concede</small>
        </article>
        <article className="config-card">
          <p className="eyebrow">TESORO</p>
          <strong>{formatTreasure(stats.treasure.amount, stats.treasure.currency)}</strong>
          <small>Dinero real del reino, no moneda de juego</small>
        </article>
      </section>

      <section className="stats-mastery">
        <p className="eyebrow">MAESTRÍA</p>
        {stats.mastery.length > 0 ? (
          <ul>
            {stats.mastery.map((entry) => (
              <li key={entry.domain}><span>{entry.domain}</span><b>{entry.points}</b></li>
            ))}
          </ul>
        ) : (
          <p className="stats-empty">Todavía no hay dominio entrenado: la maestría llega con quests completadas.</p>
        )}
      </section>
    </main>
  );
}

/** mm:ss. El servidor manda el tiempo; esto sólo lo dibuja. */
function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function formatMinutes(minutes: number): string {
  if (minutes <= 0) return "sin estimar";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** Repinta cada segundo para que el reloj no parezca congelado entre lecturas. */
function useHeartbeat(active: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const id = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(id);
  }, [active]);
}

/**
 * EL RELOJ ES PARTE DEL ENEMIGO.
 *
 * React NUNCA es la autoridad del tiempo: `remainingMs` lo calculó el Core.
 * Aquí sólo se descuenta lo que pasó desde que llegó esa lectura, para que la
 * cuenta atrás se vea viva entre una consulta y la siguiente.
 */
function BattleTimer({ clock, status, receivedAt }: { clock: BattleClock; status: BattleStatus; receivedAt: number }) {
  const running = status === "active" && !clock.suspended;
  useHeartbeat(running);
  const remaining = Math.max(0, clock.remainingMs - (running ? Date.now() - receivedAt : 0));
  const totalMs = clock.durationMinutes * 60_000;
  const spent = totalMs > 0 ? Math.min(100, ((totalMs - remaining) / totalMs) * 100) : 100;
  const danger = running && remaining <= 5 * 60_000;
  return (
    <section className={`battle-timer glass-panel ${danger ? "danger" : ""} ${clock.suspended ? "suspended" : ""}`} aria-live="off">
      <div>
        <span>{clock.suspended ? "PRESIÓN SUSPENDIDA" : status === "lost" ? (clock.expired ? "PLAZO VENCIDO" : "BATALLA PERDIDA") : status === "won" ? "MARGEN RESTANTE" : "TIEMPO RESTANTE"}</span>
        <strong>{formatClock(remaining)}</strong>
      </div>
      <div className="timer-track"><span style={{ width: `${spent}%` }} /></div>
      <small>
        {clock.suspended
          ? "Un bloqueo externo real detuvo el reloj. No hay acción del Marqués."
          : `La Horda golpea al 25%, 50%, 75% y 100% de los ${clock.durationMinutes} min pactados.`}
      </small>
    </section>
  );
}

/** Destello momentáneo de un miembro del grupo: cura, escudo o crítico recibido. */
export type PartyFlash = Partial<Record<PartyMemberId, "heal" | "shield" | "critical">>;

const PARTY_SLOTS: PartyMemberId[] = ["roko", "marques", "cordera"];

/**
 * EL GRUPO.
 *
 * ROKO PROTEGE. MARQUÉS ATACA. CORDERA SOSTIENE.
 *
 * Las cifras las deriva el Core de los GameEvents; React sólo las dibuja y
 * enciende un destello cuando algo acaba de pasar. Ninguna barra de aquí puede
 * moverse sin un evento detrás.
 */
function PartyHud({ party, flash }: { party: PartyState; flash: PartyFlash }) {
  return (
    <section className="party-hud" aria-label="El grupo del Marqués">
      {PARTY_SLOTS.map((id) => {
        const member = party[id];
        const pulse = flash[id];
        const badge = member.status === "ko" ? "KO" : pulse ? pulse.toUpperCase() : "ACTIVE";
        return (
          <article key={id} className={`party-member ${member.status} ${pulse ?? ""}`}>
            <header>
              <strong>{member.name.toUpperCase()}</strong>
              <em>{badge}</em>
            </header>
            <div className="party-bar health"><span style={{ width: `${(member.health / member.maxHealth) * 100}%` }} /></div>
            <b>HP {member.health}/{member.maxHealth}</b>
            {member.maxShield ? (
              <>
                <div className="party-bar shield"><span style={{ width: `${((member.shield ?? 0) / member.maxShield) * 100}%` }} /></div>
                <b className="shield-value">SH {member.shield ?? 0}/{member.maxShield}</b>
              </>
            ) : null}
          </article>
        );
      })}
    </section>
  );
}

function ProgressTrack({ percent, label }: { percent: number; label: string }) {
  return (
    <div className="rune-track" role="img" aria-label={label}>
      <span style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
    </div>
  );
}

/**
 * Barra superior común a Campaña, Acto y Orden.
 *
 * Cubre la franja de recursos del mockup con las cifras que el reino sí puede
 * defender: XP, Aura y Tesoro real. Ni monedas ni gemas inventadas.
 */
function RealmTopBar({ snapshot, onOpenStats }: { snapshot: RealmSnapshot; onOpenStats: () => void }) {
  const stats = statsOf(snapshot);
  return (
    <>
      <button className="map-player" type="button" onClick={onOpenStats}>
        <strong>{stats.displayName.toUpperCase()}</strong>
        <span>{stats.hp}/{stats.maxHp} HP</span>
      </button>
      <section className="map-resources" aria-label="Recursos del reino">
        <span><b>{stats.xp}</b>XP</span>
        <span><b>{stats.aura}</b>AURA</span>
        <span><b>{stats.mastery.length}</b>MAESTRÍAS</span>
        <span className="treasure"><b>{formatTreasure(stats.treasure.amount, stats.treasure.currency)}</b>TESORO REAL</span>
      </section>
    </>
  );
}

/**
 * MAPA DE CAMPAÑA.
 *
 * La campaña es el objetivo significativo; sus nodos son los Actos. El mockup
 * queda debajo como escenario y encima sólo se calca lo que este slice sostiene
 * de verdad: progreso derivado, actos reales y la vuelta al reino. Tesorería y
 * Cuartel todavía no existen, así que tampoco se dibujan botones que mientan.
 */
function CampaignMap({
  snapshot,
  campaign,
  busy,
  onBack,
  onOpenAct,
  onOpenStats,
  onFocusCampaign,
  onAcceptCampaign,
}: {
  snapshot: RealmSnapshot;
  campaign: CampaignView;
  busy: boolean;
  onBack: () => void;
  onOpenAct: (actId: string) => void;
  onOpenStats: () => void;
  onFocusCampaign: (campaignId: string) => void;
  onAcceptCampaign: (campaignId: string) => void;
}) {
  const quest = snapshot.currentQuest;
  const activeAct = campaign.acts.find((act) => act.id === snapshot.hierarchy.currentActId) ?? campaign.acts.find((act) => !act.locked);
  return (
    <main className="scene map-scene">
      <img className="map-art" src="/assets/art/campaign-map.png" alt="" aria-hidden="true" />
      <RealmTopBar snapshot={snapshot} onOpenStats={onOpenStats} />

      <header className="map-title">
        {/* EN FOCO, no «la única activa»: las demás siguen vivas y no atacan. */}
        <p className="eyebrow">CAMPAÑA EN FOCO</p>
        <h1>{campaign.title}</h1>
        {campaign.summary ? <p>{campaign.summary}</p> : null}
      </header>

      <section className="map-progress">
        <p className="eyebrow">PROGRESO DE CAMPAÑA</p>
        <ProgressTrack percent={campaign.percent} label={`${campaign.completedQuests} de ${campaign.totalQuests} quests completadas`} />
        <strong>{campaign.completedQuests} / {campaign.totalQuests} completadas</strong>
      </section>

      <aside className="map-boss">
        <p className="eyebrow">JEFE FINAL</p>
        <h2>{campaign.bossTitle ?? "Sin jefe declarado"}</h2>
        <p>{campaign.bossDescription ?? "El jefe es la última Battle de la campaña; el Códice todavía no le puso nombre."}</p>
      </aside>

      <nav className="map-nodes" aria-label="Actos de la campaña">
        {campaign.acts.map((act) => (
          <button
            key={act.id}
            className={`map-node ${act.status} ${act.locked ? "locked" : ""} ${act.id === activeAct?.id ? "current" : ""}`}
            type="button"
            disabled={act.locked}
            onClick={() => onOpenAct(act.id)}
          >
            <strong>{act.position}. {act.title}</strong>
            <small>{act.subtitle ?? `${act.totalQuests} ${act.totalQuests === 1 ? "battle" : "battles"} · ${formatMinutes(act.estimatedActiveMinutes)}`}</small>
            <em>{act.locked ? "🔒 BLOQUEADO" : act.status === "completed" ? "✓ COMPLETADO" : `${act.completedQuests}/${act.totalQuests} · ACTIVO`}</em>
          </button>
        ))}
        {campaign.acts.length === 0 ? <p className="map-empty">Esta campaña todavía no tiene actos. Pídeselos al Códice.</p> : null}
      </nav>

      {campaign.status === "draft" ? (
        <aside className="campaign-pact" role="dialog" aria-label="Pacto de campaña propuesto">
          <p className="eyebrow">PACTO PROPUESTO</p>
          <h2>{campaign.title}</h2>
          {campaign.objective ? <p><b>Objetivo final:</b> {campaign.objective}</p> : null}
          {campaign.rationale ? <p>{campaign.rationale}</p> : null}
          <p className="pact-meta">
            {campaign.totalActs} acto(s) · {formatMinutes(campaign.estimatedActiveMinutes)} de trabajo activo
            {campaign.estimatedCalendarDays ? ` · horizonte de ${campaign.estimatedCalendarDays} días` : ""}
          </p>
          <div className="pact-actions">
            <button className="back-button" type="button" onClick={onBack}>MÁS TARDE</button>
            <button className="expedition-button" type="button" disabled={busy} onClick={() => onAcceptCampaign(campaign.id)}>
              ✍ SELLAR EL PACTO
            </button>
          </div>
          <small>Sellarla no inicia ninguna batalla ni cierra ningún otro frente.</small>
        </aside>
      ) : null}

      <section className="map-details">
        <p className="eyebrow">DETALLES DE CAMPAÑA</p>
        <ul>
          <li><i>✦</i><span>Objetivo final:</span> <b>{campaign.objective ?? "Sin objetivo declarado"}</b></li>
          <li><i>✦</i><span>Actos:</span> <b>{campaign.completedActs} / {campaign.totalActs}</b></li>
          <li><i>✦</i><span>Trabajo activo estimado:</span> <b>{formatMinutes(campaign.estimatedActiveMinutes)}</b></li>
          <li><i>✦</i><span>Recompensa:</span> <b>XP, Aura y maestría por cada quest validada</b></li>
        </ul>
      </section>

      <section className="map-summary">
        <p className="eyebrow">RESUMEN ACTUAL</p>
        <ul>
          <li><i>✦</i><span>Acto activo:</span> <b>{activeAct ? `${activeAct.position}. ${activeAct.title}` : "Ninguno"}</b></li>
          <li><i>✦</i><span>Quest activa:</span> <b>{quest ? quest.title : "Ninguna"}</b></li>
          <li><i>✦</i><span>Impacto validado:</span> <b>{snapshot.battle?.progress ?? 0} / 100</b></li>
        </ul>
      </section>

      <nav className="map-nav" aria-label="Navegación de campaña">
        <button className="map-nav-button" type="button" onClick={onBack}>VOLVER AL REINO</button>
        <button className="map-nav-button active" type="button" disabled>MAPA DE CAMPAÑA</button>
        {/*
          MANY CAMPAIGNS: cambiar de frente sólo mueve la mirada. Ninguna de las
          otras se cierra, se reinicia ni empieza a atacar por dejar el foco.
        */}
        <div className="campaign-switch" aria-label="Campañas activas">
          <span>FRENTES ABIERTOS</span>
          <div>
            {snapshot.hierarchy.campaigns
              .filter((candidate) => candidate.status !== "abandoned" && candidate.status !== "completed")
              .map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                className={`${candidate.id === campaign.id ? "current" : ""} ${candidate.status}`}
                disabled={busy || candidate.id === campaign.id}
                onClick={() => onFocusCampaign(candidate.id)}
              >
                {candidate.title}
                <small>{candidate.status === "draft" ? "SIN SELLAR" : `${candidate.completedQuests}/${candidate.totalQuests}`}</small>
              </button>
              ))}
          </div>
        </div>
      </nav>
    </main>
  );
}

/**
 * ACTO.
 *
 * Fase jugable de una jornada: de 2 a 8 Battles. Aquí el jugador elige la
 * siguiente Quest y prepara la expedición; el reloj todavía NO corre.
 */
function ActBook({
  snapshot,
  campaign,
  act,
  onBack,
  onOpenQuest,
  onOpenStats,
}: {
  snapshot: RealmSnapshot;
  campaign: CampaignView | null;
  act: ActView;
  onBack: () => void;
  onOpenQuest: (questId: string) => void;
  onOpenStats: () => void;
}) {
  const next = act.quests.find((node) => !["completed", "abandoned"].includes(node.status) && !node.locked) ?? act.quests[0] ?? null;
  return (
    <main className="scene act-scene">
      <img className="map-art" src="/assets/art/act-book.png" alt="" aria-hidden="true" />
      <RealmTopBar snapshot={snapshot} onOpenStats={onOpenStats} />

      <header className="map-title">
        <p className="eyebrow">CAMPAÑA EN FOCO</p>
        <h1>{campaign?.title ?? "Sin campaña"}</h1>
      </header>

      <aside className="act-side">
        <p className="eyebrow">PROGRESO DE CAMPAÑA</p>
        <strong className="act-count">{campaign ? campaign.completedQuests : act.completedQuests} / {campaign ? campaign.totalQuests : act.totalQuests}</strong>
        <span className="act-count-label">completadas</span>
        <ProgressTrack percent={campaign?.percent ?? act.percent} label="Progreso de campaña" />
        <dl>
          <div><dt>Trabajo activo del acto</dt><dd>{formatMinutes(act.estimatedActiveMinutes)}</dd></div>
          <div><dt>Battles del acto</dt><dd>{act.completedQuests} / {act.totalQuests}</dd></div>
          <div><dt>Escenario</dt><dd>{act.scenario ?? "El del reino"}</dd></div>
        </dl>
        {snapshot.rewardPreview ? (
          <div className="act-reward">
            <p className="eyebrow">RECOMPENSA DE LA QUEST ACTUAL</p>
            <span>+{snapshot.rewardPreview.xp} XP · +{snapshot.rewardPreview.aura} Aura{snapshot.rewardPreview.masteryDomain ? ` · ${snapshot.rewardPreview.masteryDomain}` : ""}</span>
          </div>
        ) : null}
      </aside>

      <header className="act-title">
        <h1>{act.subtitle ? `${act.title}: ${act.subtitle}` : act.title}</h1>
      </header>

      <nav className="act-nodes" aria-label="Quests del acto">
        {act.quests.map((node) => (
          <button
            key={node.id}
            className={`act-node ${node.status} ${node.locked ? "locked" : ""} ${node.isBoss ? "boss" : ""}`}
            type="button"
            disabled={node.locked}
            onClick={() => onOpenQuest(node.id)}
          >
            <b>{node.status === "completed" ? "✓" : node.locked ? "🔒" : node.position}</b>
            <strong>{node.title}</strong>
            <small>{node.percent}/100 · {node.durationMinutes} min</small>
          </button>
        ))}
        {act.quests.length === 0 ? <p className="map-empty">Este acto todavía no tiene quests. Pídeselas al Códice.</p> : null}
      </nav>

      <aside className="act-quest">
        <p className="eyebrow">QUEST ACTUAL</p>
        {next ? (
          <>
            <h2>{next.position}. {next.title}</h2>
            <p>{next.outcome}</p>
            <dl>
              <div><dt>Progreso</dt><dd>{next.percent} / 100</dd></div>
              <div><dt>Duración pactada</dt><dd>{next.durationMinutes} min</dd></div>
              <div><dt>Estado</dt><dd>{next.battleStatus === "lost" ? "Battle perdida" : next.status}</dd></div>
            </dl>
          </>
        ) : (
          <p>Este acto no tiene ninguna quest pendiente.</p>
        )}
      </aside>

      <section className="act-codex">
        <p className="eyebrow">CÓDICE</p>
        <p>{snapshot.currentQuest?.rationale ?? "El Códice abrirá la siguiente orden cuando el acto lo pida."}</p>
      </section>

      <div className="act-actions">
        <button className="back-button" type="button" onClick={onBack}>← VOLVER</button>
        <button className="expedition-button" type="button" disabled={!next} onClick={() => next && onOpenQuest(next.id)}>
          ⚔ PREPARAR EXPEDICIÓN
        </button>
        <p className="map-nav-note">La expedición no arranca el reloj: eso ocurre al iniciar la Battle.</p>
      </div>
    </main>
  );
}

/** Lo que la orden de misión necesita, venga del snapshot o del detalle HTTP. */
interface QuestOrderView {
  id: string;
  title: string;
  campaignTitle: string;
  outcome: string;
  rationale: string;
  status: Quest["status"];
  durationMinutes: number;
  wellbeingConstraints: string[];
  steps: Array<{ id: string; title: string; evidence: string; evidenceKind?: string; weight: number; impactAwarded: number; status: string }>;
}

function attackTier(weight: number): string {
  if (weight < 10) return "MENOR";
  if (weight < 20) return "NORMAL";
  if (weight < 35) return "MAYOR";
  return "CRÍTICO";
}

/**
 * ORDEN DE MISIÓN.
 *
 * Todo lo que el jugador necesita ANTES de que el reloj empiece a correr: qué
 * cuenta como victoria, qué prueba hay que entregar, cuánto tiempo se pacta y
 * qué se arriesga. Las recompensas son las que el Core concede de verdad —XP,
 * Aura y maestría—; aquí no hay monedas ni gemas inventadas.
 */
function QuestOrder({
  snapshot,
  questId,
  busy,
  receivedAt,
  onBack,
  onAccept,
  onStart,
  onEnterBattle,
  onOpenStats,
}: {
  snapshot: RealmSnapshot;
  questId: string | null;
  busy: boolean;
  receivedAt: number;
  onBack: () => void;
  onAccept: (questId: string) => void;
  onStart: (questId: string) => void;
  onEnterBattle: () => void;
  onOpenStats: () => void;
}) {
  const current = snapshot.currentQuest;
  const isCurrent = Boolean(questId) && current?.id === questId;
  const [fetched, setFetched] = useState<QuestOrderView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!questId || isCurrent) {
      setFetched(null);
      return undefined;
    }
    let cancelled = false;
    api<{ quest: QuestOrderView }>(`/api/quests/${questId}`)
      .then((body) => {
        if (!cancelled) setFetched(body.quest);
      })
      .catch((error: unknown) => {
        if (!cancelled) setFailure(error instanceof Error ? error.message : "No fue posible leer la orden.");
      });
    return () => {
      cancelled = true;
    };
  }, [questId, isCurrent]);

  const quest: QuestOrderView | null = isCurrent && current ? current : fetched;
  const battle = isCurrent ? snapshot.battle : null;

  if (!quest) {
    return (
      <main className="scene order-scene">
        <img className="map-art" src="/assets/art/quest-order.png" alt="" aria-hidden="true" />
        <RealmTopBar snapshot={snapshot} onOpenStats={onOpenStats} />
        <article className="order-sheet">
          <p className="eyebrow">ORDEN DE MISIÓN</p>
          <h1>Sin orden abierta</h1>
          <p className="order-lead">{failure ?? "El Códice todavía no ha redactado esta misión."}</p>
        </article>
        <div className="order-actions">
          <button className="back-button" type="button" onClick={onBack}>← ATRÁS</button>
        </div>
      </main>
    );
  }

  const totalAttack = quest.steps.reduce((sum, step) => sum + step.weight, 0);
  const validated = quest.steps.reduce((sum, step) => sum + step.impactAwarded, 0);
  const evidences = Array.from(new Set(quest.steps.map((step) => step.evidence))).slice(0, 6);
  const reward = isCurrent ? snapshot.rewardPreview : null;
  const engagedQuestId = snapshot.hierarchy?.engagedQuestId ?? null;
  const engagedElsewhere = Boolean(engagedQuestId) && engagedQuestId !== quest.id;
  const campaign = snapshot.hierarchy?.campaigns.find((candidate) => candidate.id === snapshot.hierarchy.currentCampaignId) ?? null;

  return (
    <main className="scene order-scene">
      <img className="map-art" src="/assets/art/quest-order.png" alt="" aria-hidden="true" />
      <RealmTopBar snapshot={snapshot} onOpenStats={onOpenStats} />

      <header className="map-title">
        <p className="eyebrow">CAMPAÑA EN FOCO</p>
        <h1>{campaign?.title ?? quest.campaignTitle}</h1>
      </header>

      <aside className="order-side">
        <p className="eyebrow">PROGRESO DE CAMPAÑA</p>
        <strong className="act-count">{campaign ? `${campaign.completedQuests} / ${campaign.totalQuests}` : `${validated} / 100`}</strong>
        <span className="act-count-label">{campaign ? "completadas" : "impacto validado"}</span>
        <ProgressTrack percent={campaign ? campaign.percent : validated} label="Progreso" />
        <div className="order-care-block">
          <p className="eyebrow">CONSEJO DE CÓDICE</p>
          {quest.wellbeingConstraints.length > 0 ? (
            <ul className="order-care">
              {quest.wellbeingConstraints.map((care) => <li key={care}>✦ {care}</li>)}
            </ul>
          ) : (
            <p className="order-note">No intentes hacerlo perfecto. Prioriza lo que mueve la aguja.</p>
          )}
        </div>
      </aside>

      <article className="order-sheet">
        <p className="eyebrow">ORDEN DE MISIÓN</p>
        <h1>{quest.title}</h1>
        <p className="order-lead">{quest.outcome}</p>

        <div className="order-grid">
          <section>
            <p className="eyebrow">OBJETIVO REAL</p>
            <p>{quest.outcome}</p>
          </section>
          <section>
            <p className="eyebrow">CONDICIÓN DE VICTORIA</p>
            <p><b>100 puntos</b> de impacto validado en {quest.steps.length} {quest.steps.length === 1 ? "paso" : "pasos"}. Sólo la evidencia comprobada causa daño.</p>
          </section>
          <section>
            <p className="eyebrow">EVIDENCIA REQUERIDA</p>
            <ul className="order-evidence">
              {evidences.map((evidence) => <li key={evidence}>✦ {evidence}</li>)}
            </ul>
          </section>
          <section>
            <p className="eyebrow">DURACIÓN PACTADA</p>
            <p><b>{quest.durationMinutes} min</b> de trabajo activo.</p>
            <p className="order-risk">Si termina el tiempo con la Horda viva, pierdes la Battle.</p>
          </section>
        </div>

        <section className="order-attack">
          <p className="eyebrow">VALOR DEL ATAQUE · {totalAttack} PUNTOS</p>
          <ul>
            {quest.steps.map((step) => (
              <li key={step.id} className={step.status === "completed" ? "done" : ""}>
                <span>{step.title}</span>
                <b>{step.impactAwarded}/{step.weight}</b>
                <em>{attackTier(step.weight)}</em>
              </li>
            ))}
          </ul>
        </section>
      </article>

      <aside className="order-rewards">
        <p className="eyebrow">RECOMPENSAS ESTIMADAS</p>
        {reward ? (
          <ul>
            <li><b>+{reward.xp}</b><span>XP</span></li>
            <li><b>+{reward.aura}</b><span>AURA</span></li>
            {reward.masteryDomain ? <li><b>+1</b><span>{reward.masteryDomain.toUpperCase()}</span></li> : null}
          </ul>
        ) : (
          <p className="order-note">El Códice calculará la recompensa cuando esta orden sea la activa.</p>
        )}
        <small>El Tesoro no cambia por completar quests: sólo lo mueve un hecho financiero real.</small>
      </aside>

      <aside className="order-state">
        <p className="eyebrow">ESTADO DE LA BATALLA</p>
        {battle?.clock ? (
          <>
            <strong>{formatClock(Math.max(0, battle.clock.remainingMs - (battle.status === "active" && !battle.clock.suspended ? Date.now() - receivedAt : 0)))}</strong>
            <p>Intento {battle.attempt} · {battle.status === "lost" ? "Battle perdida" : battle.status === "won" ? "Battle ganada" : battle.clock.suspended ? "Presión suspendida" : "Reloj corriendo"}</p>
          </>
        ) : (
          <>
            <strong>{quest.durationMinutes}:00</strong>
            <p>El reloj no ha empezado. Arranca al iniciar la expedición, no al aceptar el contrato.</p>
          </>
        )}
      </aside>

      <aside className="order-codex">
        <p className="eyebrow">CÓDICE DICE</p>
        <p>{quest.rationale}</p>
      </aside>

      <div className="order-actions">
        <button className="back-button" type="button" onClick={onBack}>← ATRÁS</button>
        {engagedElsewhere ? (
          // ONE ENGAGED BATTLE: esta orden se consulta, pero no abre un reloj.
          <button className="expedition-button" type="button" onClick={onEnterBattle}>⚔ VOLVER A BATALLA ACTIVA</button>
        ) : !isCurrent ? (
          <button className="expedition-button" type="button" disabled>ESTA QUEST ESPERA SU TURNO</button>
        ) : quest.status === "draft" ? (
          <button className="expedition-button" type="button" disabled={busy} onClick={() => onAccept(quest.id)}>✍ ACEPTAR CONTRATO</button>
        ) : quest.status === "accepted" ? (
          <button className="expedition-button" type="button" disabled={busy} onClick={() => onStart(quest.id)}>⚔ INICIAR EXPEDICIÓN · {quest.durationMinutes} MIN</button>
        ) : quest.status === "completed" ? (
          <button className="expedition-button" type="button" onClick={onEnterBattle}>🏆 VER RESULTADO</button>
        ) : (
          <button className="expedition-button" type="button" onClick={onEnterBattle}>⚔ VOLVER A LA BATALLA · {validated}/100</button>
        )}
      </div>
    </main>
  );
}

function Battle({
  snapshot,
  busy,
  impact,
  incomingDamage,
  receivedAt,
  partyFlash,
  onBack,
  onOpenStats,
  onOpenOrder,
  onAccept,
  onAcceptAmendment,
  onStart,
  onRetry,
  onDeliverEvidence,
}: {
  snapshot: RealmSnapshot;
  busy: boolean;
  impact: number | null;
  incomingDamage: number | null;
  /** Momento local de la última lectura: ancla la cuenta atrás sin inventar tiempo. */
  receivedAt: number;
  partyFlash: PartyFlash;
  onBack: () => void;
  onOpenStats: () => void;
  onOpenOrder: () => void;
  onAccept: () => void;
  onAcceptAmendment: (amendmentId: string) => void;
  onStart: () => void;
  onRetry: () => void;
  onDeliverEvidence: (stepId: string, note: string, link: string, files: PendingFile[]) => void;
}) {
  const quest = snapshot.currentQuest;
  const [openStepId, setOpenStepId] = useState<string | null>(quest?.steps[0]?.id ?? null);
  const [evidenceNote, setEvidenceNote] = useState("");
  const [evidenceLink, setEvidenceLink] = useState("");
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [ordersOpen, setOrdersOpen] = useState(quest?.status !== "active");
  const proposedAmendmentId = quest?.amendments?.find((amendment) => amendment.status === "proposed")?.id;
  useEffect(() => {
    if (proposedAmendmentId) setOrdersOpen(true);
  }, [proposedAmendmentId]);
  // La pantalla no se desmonta al aceptar: al entrar en batalla, las órdenes se
  // repliegan solas para devolver el campo al jugador.
  const questStatus = quest?.status;
  useEffect(() => {
    if (questStatus === "active") setOrdersOpen(false);
  }, [questStatus]);
  // Ninguna vista sin salida: sin frente abierto la batalla explica y devuelve.
  if (!quest) {
    return (
      <main className="scene battle-scene">
        <img className="battle-art" src="/assets/art/battle-realm.png" alt="El reino sin frente abierto" />
        <aside className="quest-contract parchment draft">
          <p className="eyebrow">SIN FRENTE ABIERTO</p>
          <h2>No hay ninguna quest en el reino</h2>
          <p>Háblale a Códice para pactar un contrato antes de entrar en batalla.</p>
          <div className="contract-actions">
            <button className="gold-button" type="button" onClick={onBack}>VOLVER AL REINO</button>
          </div>
        </aside>
      </main>
    );
  }
  const battle = snapshot.battle;
  const health = battle?.enemyHealth ?? 100;
  const playerHealth = battle?.playerHealth ?? 100;
  const pendingAmendment = quest.amendments?.find((amendment) => amendment.status === "proposed");
  const totalAttack = quest.steps.reduce((sum, step) => sum + step.weight, 0);
  // El paso accionable se deriva igual que en el Core: el primero que aún no cobró.
  const currentStep = quest.steps.find((step) => ["pending", "in_progress"].includes(step.status) && step.impactAwarded < step.weight);
  const rewardMessage = snapshot.realm.events.find((event) => event.type === "reward_granted" && event.questId === quest.id)?.message;
  const focusCurrentStep = () => {
    if (!currentStep) return;
    setOpenStepId(currentStep.id);
    setOrdersOpen(true);
  };
  return (
    <main className={`scene battle-scene ${impact ? "impact" : ""} ${incomingDamage ? "player-hit" : ""}`}>
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

      {battle?.clock ? <BattleTimer clock={battle.clock} status={battle.status} receivedAt={receivedAt} /> : null}

      {/*
        Tira de estado calcada sobre el HUD pintado del arte de batalla: donde
        el escenario dibuja un reloj y un «modo enfoque» que no existen, el
        renderer pone el estado real del frente.
      */}
      {battle ? <PartyHud party={battle.party} flash={partyFlash} /> : null}

      {battle ? (
        <section className="battle-hud glass-panel" aria-label="Estado del frente">
          <div>
            <span>ESTADO</span>
            <strong>{battle.status === "lost" ? "PERDIDA" : battle.status === "won" ? "GANADA" : battle.clock?.suspended ? "SUSPENDIDA" : battle.clock ? "EN CURSO" : "SIN INICIAR"}</strong>
          </div>
          <div><span>INTENTO</span><strong>{battle.attempt}</strong></div>
          <div className="hud-step"><span>PASO ACTUAL</span><strong>{currentStep?.title ?? "—"}</strong></div>
        </section>
      ) : null}

      <button className="player-health glass-panel" type="button" onClick={onOpenStats} aria-label="Abrir hoja de personaje">
        <div><span>MARQUÉS</span><strong>{playerHealth} / 100 HP</strong></div>
        <div className="player-health-track"><span style={{ width: `${playerHealth}%` }} /></div>
        <small className="stats-hint">VER PERSONAJE ›</small>
      </button>

      <section className="battlefield" aria-label="Campo de batalla">
        <span className="battle-pulse ally" aria-hidden="true" />
        <span className="battle-pulse enemy" aria-hidden="true" />
        <div className="combat-event-zone" aria-live="polite">
          {impact ? <div className="damage-number enemy-damage">−{impact}</div> : null}
          {incomingDamage ? <div className="damage-number player-damage">−{incomingDamage} HP</div> : null}
        </div>
        {battle?.isKo ? <div className="ko">KO</div> : null}
      </section>

      {/*
        DERROTA: el plazo terminó con la Horda viva. No se borró nada —evidencia,
        impacto, XP, Aura, Tesoro e historial siguen en pie—; sólo esta Battle
        se perdió, y el jugador decide si vuelve al frente o al reino.
      */}
      {battle?.status === "lost" ? (
        <div className="battle-defeat" role="alertdialog" aria-label="Battle perdida">
          <article>
            <p className="eyebrow">DERROTA</p>
            {/* El plazo vencido y el KO son derrotas distintas: se nombran distinto. */}
            <h2>{battle.clock?.expired ? "El tiempo pactado terminó" : "El Marqués cayó en el frente"}</h2>
            <p>
              Progreso validado: <b>{battle.progress}/100</b>.{" "}
              {battle.clock?.expired
                ? "La evidencia entregada sigue contando; lo que se agotó fue el plazo."
                : "La evidencia entregada sigue contando; lo que se agotó fue el HP del Marqués."}
            </p>
            <div className="defeat-actions">
              <button className="gold-button" type="button" disabled={busy} onClick={onRetry}>REPLANIFICAR</button>
              <button className="back-button" type="button" onClick={onBack}>VOLVER AL REINO</button>
            </div>
          </article>
        </div>
      ) : null}

      {/*
        LA BATALLA ES LA QUEST: aceptar, iniciar, entregar evidencia y ver la
        victoria ocurren en este mismo panel. Aceptar un contrato transforma la
        pantalla; nunca saca al jugador del campo para configurarlo aparte.
      */}
      <aside className={`quest-contract parchment ${quest.status}`}>
        <p className="eyebrow">
          {quest.status === "completed" ? "🏆 VICTORIA" : quest.status === "draft" ? "CONTRATO PROPUESTO" : `CONTRATO DE MISIÓN · ${quest.durationMinutes} MIN`}
        </p>
        <h2>{quest.outcome}</h2>
        <p>{quest.rationale}</p>

        {["draft", "accepted"].includes(quest.status) ? (
          <>
            <div className="contract-stats">
              <span><b>{quest.durationMinutes} min</b><small>DURACIÓN PACTADA</small></span>
              <span><b>{quest.steps.length} pasos</b><small>OBJETIVO</small></span>
              <span><b>{totalAttack}</b><small>ATAQUE TOTAL</small></span>
            </div>
            {/* El reloj todavía no corre: arranca al iniciar, no al aceptar. */}
            <p className="contract-risk">RIESGO · Si terminan los {quest.durationMinutes} min con la Horda viva, pierdes la Battle.</p>
          </>
        ) : null}

        {quest.status === "completed" && rewardMessage ? <p className="contract-reward">{rewardMessage}</p> : null}
        {quest.status === "completed" && battle?.clock ? (
          <p className="contract-reward">Tiempo restante: {formatClock(battle.clock.remainingMs)} · HP restante: {playerHealth}/100</p>
        ) : null}

        {quest.status === "active" ? (
          <button className="orders-button" type="button" onClick={() => setOrdersOpen((open) => !open)}>
            {ordersOpen ? "CERRAR ÓRDENES" : `ABRIR ÓRDENES · ${battle?.completedSteps ?? 0}/${quest.steps.length}`}
          </button>
        ) : null}

        {/* Un solo CTA principal, y dice exactamente qué toca ahora. */}
        <div className="contract-actions">
          {quest.status === "draft" ? <button className="gold-button" disabled={busy} onClick={onAccept}>ACEPTAR CONTRATO</button> : null}
          {quest.status === "accepted" ? <button className="gold-button" disabled={busy} onClick={onStart}>INICIAR BATALLA</button> : null}
          {quest.status === "active" && currentStep && battle?.status !== "lost" ? (
            <button className="gold-button" type="button" onClick={focusCurrentStep}>
              {currentStep.evidenceKind === "photo" ? "📷 TOMAR EVIDENCIA" : "⚔️ ENTREGAR EVIDENCIA"}
            </button>
          ) : null}
          {quest.status === "waiting_external" ? <button className="gold-button" type="button" disabled>SIN ACCIÓN REQUERIDA</button> : null}
          {quest.status === "completed" ? <button className="gold-button" onClick={onBack}>VOLVER AL REINO</button> : null}
        </div>
        {quest.status === "active" && currentStep ? <small className="contract-step">PASO ACTUAL · {currentStep.title}</small> : null}
        <button className="orders-button" type="button" onClick={onOpenOrder}>VER ORDEN DE MISIÓN</button>
      </aside>

      <section className={`steps-panel glass-panel ${ordersOpen ? "open" : "closed"}`}>
        <div className="steps-heading">
          <span>ÓRDENES DEL CÓDICE</span>
          <strong>{battle?.completedSteps ?? 0}/{quest.steps.length}</strong>
          <button type="button" onClick={() => setOrdersOpen(false)} aria-label="Cerrar órdenes">×</button>
        </div>
        {pendingAmendment ? (
          <article className="amendment-proposal">
            <strong>⚔️ CÓDICE PROPONE PLAN v{pendingAmendment.newVersion}</strong>
            <p>{pendingAmendment.reason}</p>
            <button className="gold-button" type="button" disabled={busy} onClick={() => onAcceptAmendment(pendingAmendment.id)}>ACEPTAR CAMBIO</button>
          </article>
        ) : null}
        <div className="steps-list">
          {quest.steps.map((step, index) => {
            const isOpen = openStepId === step.id;
            const parts = stepParts(step.description);
            const stepArtifacts = snapshot.realm.artifacts?.filter((artifact) => artifact.stepIds.includes(step.id)) ?? [];
            const stepVerdicts = snapshot.realm.evidence.filter((record) => record.stepId === step.id);
            return (
              <article className={`step ${step.status} ${isOpen ? "open" : ""}`} key={step.id}>
                <button className="step-summary" type="button" onClick={() => setOpenStepId(isOpen ? null : step.id)}>
                  <span className="step-number">{step.status === "completed" ? "✓" : index + 1}</span>
                  <span><strong>{step.title}</strong><small>{step.status === "blocked" ? "BLOQUEO EXTERNO" : step.status === "superseded" ? "ORDEN SUSTITUIDA" : `${step.actor.toUpperCase()} · ${step.evidence}`}</small></span>
                  <b>{step.impactAwarded}/{step.weight}</b>
                </button>
                {isOpen ? (
                  <div className="step-detail">
                    <p>{parts.epic || "Códice no dejó descripción para este paso."}</p>
                    <dl>
                      <div><dt>Qué hacer</dt><dd>{parts.real || step.title}</dd></div>
                      <div><dt>Qué entregar</dt><dd>{step.evidence}</dd></div>
                    </dl>
                    {step.status === "blocked" ? (
                      <div className="external-blocker">
                        <strong>🔒 {step.blockedBy ?? "Dependencia externa"}</strong>
                        <p>{step.blockedReason ?? "Este frente espera una condición fuera del control del Marqués."}</p>
                        {step.playerActionAvailable === false ? <small>NO HAY ACCIÓN REQUERIDA DEL MARQUÉS AHORA.</small> : null}
                      </div>
                    ) : null}
                    {step.status === "superseded" ? <div className="superseded-note">Esta orden ya no representa la realidad: {step.supersededReason}</div> : null}
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
                    {quest.status === "active" && battle?.status !== "lost" && !["completed", "blocked", "superseded"].includes(step.status) ? (
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
  const initialScreen: Screen =
    requestedScreen === "battle"
      ? "battle"
      : requestedScreen === "campaign" || requestedScreen === "act" || requestedScreen === "quest"
        ? (requestedScreen as Screen)
        : requestedScreen === "bastion" || requestedScreen === "realm"
          ? "realm"
          : "loading";
  const [screen, setScreen] = useState<Screen>(initialScreen);
  const [openActId, setOpenActId] = useState<string | null>(null);
  const [openQuestId, setOpenQuestId] = useState<string | null>(null);
  // Deep link: la entidad exacta que el jugador pidió abrir, no «la actual».
  const [openCampaignId, setOpenCampaignId] = useState<string | null>(
    new URLSearchParams(window.location.search).get("entity"),
  );
  const [snapshot, setSnapshot] = useState<RealmSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [impact, setImpact] = useState<number | null>(null);
  const [incomingDamage, setIncomingDamage] = useState<number | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [pendingIntent, setPendingIntent] = useState("");
  const [verdict, setVerdict] = useState<string | null>(null);
  const [notice, setNotice] = useState<RealmNotice | null>(null);
  // Ancla local de la última lectura: el reloj se interpola, nunca se inventa.
  const [receivedAt, setReceivedAt] = useState(() => Date.now());
  const [partyFlash, setPartyFlash] = useState<PartyFlash>({});
  const seenGameEventIds = useRef(new Set<string>());
  const gameEventsHydrated = useRef(false);
  const lastProgress = useRef(0);
  const lastPlayerHealth = useRef<number | null>(null);
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
      if (next.battle && lastPlayerHealth.current !== null && next.battle.playerHealth < lastPlayerHealth.current) {
        const damage = lastPlayerHealth.current - next.battle.playerHealth;
        setIncomingDamage(damage);
        window.setTimeout(() => setIncomingDamage(null), 1_300);
      }
      // Destellos del grupo: sólo los enciende un GameEvent nuevo del Core.
      const gameEvents = next.realm.gameEvents ?? [];
      if (!gameEventsHydrated.current) {
        gameEvents.forEach((event) => seenGameEventIds.current.add(event.id));
        gameEventsHydrated.current = true;
      } else {
        const fresh = gameEvents.filter((event) => !seenGameEventIds.current.has(event.id));
        fresh.forEach((event) => seenGameEventIds.current.add(event.id));
        const flash: PartyFlash = {};
        for (const event of fresh.slice().reverse()) {
          if (!event.target) continue;
          if (event.type === "party_heal") flash[event.target] = "heal";
          else if (event.type === "shield_gained") flash[event.target] = "shield";
          else if (event.type === "horde_attack" && event.critical) flash[event.target] = "critical";
        }
        if (Object.keys(flash).length > 0) {
          setPartyFlash(flash);
          window.setTimeout(() => setPartyFlash({}), 1_600);
        }
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
      lastPlayerHealth.current = next.battle?.playerHealth ?? null;
      setSnapshot(next);
      setReceivedAt(Date.now());
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
        {notice ? <RealmNoticeToast notice={notice} onOpen={() => setScreen("realm")} onDismiss={() => setNotice(null)} /> : null}
        {error ? <div className="error-toast" role="alert">{error}</div> : null}
      </>
    );
  }
  if (screen === "thinking") return <ThinkingScreen intent={pendingIntent} />;
  if (!snapshot) return <main className="loading"><Codex speaking /><p>El Códice despierta…</p>{error ? <strong>{error}</strong> : null}</main>;

  const quest = snapshot.currentQuest;
  const hierarchy = snapshot.hierarchy;
  const campaigns = hierarchy?.campaigns ?? [];
  const currentCampaign =
    campaigns.find((candidate) => candidate.id === openCampaignId) ??
    campaigns.find((candidate) => candidate.id === hierarchy?.focusedCampaignId) ??
    campaigns.find((candidate) => candidate.id === hierarchy?.currentCampaignId) ??
    campaigns.find((candidate) => candidate.status === "draft") ??
    campaigns.find((candidate) => candidate.status === "active") ??
    null;
  const allActs = campaigns.flatMap((candidate) => candidate.acts);
  const openAct = allActs.find((candidate) => candidate.id === openActId) ?? null;
  const campaignOfOpenAct = campaigns.find((candidate) => candidate.acts.some((candidate2) => candidate2.id === openAct?.id)) ?? currentCampaign;

  const openOrder = (questId: string) => {
    setOpenQuestId(questId);
    setScreen("quest");
  };

  /**
   * Abre exactamente la entidad del aviso.
   *
   * Nada de heurísticas: el hecho trae `entityType` y `entityId`, y eso es lo
   * que se abre. Dos borradores seguidos ya no se pisan.
   */
  const openNotice = (notice: RealmNotice) => {
    setNotice(null);
    if (notice.entityType === "campaign") {
      setOpenCampaignId(notice.entityId);
      setOpenActId(null);
      setScreen("campaign");
      return;
    }
    if (notice.entityType === "act") {
      setOpenActId(notice.entityId);
      setScreen("act");
      return;
    }
    if (notice.entityId === quest?.id && ["active", "waiting_external", "completed"].includes(quest.status)) {
      setScreen("battle");
      return;
    }
    openOrder(notice.entityId);
  };
  // Una microquest no pasa por Campaña ni Acto: no se le fabrica ceremonia.
  const openCampaignOrOrder = () => {
    if (currentCampaign) {
      setScreen("campaign");
      return;
    }
    if (quest) {
      openOrder(quest.id);
      return;
    }
    setComposerOpen(true);
  };

  return (
    <>
      {screen === "realm" ? (
        <>
        <RealmMenu
          snapshot={snapshot}
          onCampaign={openCampaignOrOrder}
          onCodex={() => setComposerOpen(true)}
          onBattle={() => setScreen("battle")}
          onStats={() => setScreen("stats")}
          onReset={() => void act(() => api("/api/reset", { method: "POST" }))}
        />
        {composerOpen ? (
          <QuestComposer
            busy={busy}
            onClose={() => setComposerOpen(false)}
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
      ) : screen === "stats" ? (
        <CharacterSheet snapshot={snapshot} onBack={() => setScreen(quest ? "battle" : "realm")} />
      ) : screen === "campaign" && currentCampaign ? (
        <CampaignMap
          snapshot={snapshot}
          campaign={currentCampaign}
          busy={busy}
          onBack={() => setScreen("realm")}
          onOpenAct={(actId) => {
            setOpenActId(actId);
            setScreen("act");
          }}
          onOpenStats={() => setScreen("stats")}
          onFocusCampaign={(campaignId) => {
            setOpenActId(null);
            setOpenCampaignId(campaignId);
            // Un borrador todavía no puede enfocarse: primero se sella.
            const target = campaigns.find((candidate) => candidate.id === campaignId);
            if (target && target.status !== "draft") {
              void act(() => api(`/api/campaigns/${campaignId}/focus`, { method: "POST" }));
            }
          }}
          onAcceptCampaign={(campaignId) =>
            void act(() => api(`/api/campaigns/${campaignId}/accept`, { method: "POST", body: JSON.stringify({ userAccepted: true }) }))
          }
        />
      ) : screen === "act" && openAct ? (
        <ActBook
          snapshot={snapshot}
          campaign={campaignOfOpenAct}
          act={openAct}
          onBack={() => setScreen(currentCampaign ? "campaign" : "realm")}
          onOpenQuest={openOrder}
          onOpenStats={() => setScreen("stats")}
        />
      ) : screen === "quest" ? (
        <QuestOrder
          snapshot={snapshot}
          questId={openQuestId ?? quest?.id ?? null}
          busy={busy}
          receivedAt={receivedAt}
          onBack={() => setScreen(openAct ? "act" : currentCampaign ? "campaign" : "realm")}
          onAccept={(questId) => void act(() => api(`/api/quests/${questId}/accept`, { method: "POST", body: JSON.stringify({ userAccepted: true }) }))}
          onStart={(questId) =>
            void act(() => api(`/api/quests/${questId}/start`, { method: "POST" })).then(() => {
              setNotice(null);
              setScreen("battle");
            })
          }
          onEnterBattle={() => setScreen("battle")}
          onOpenStats={() => setScreen("stats")}
        />
      ) : (
        // Aceptar el contrato NO cambia de pantalla: la batalla es el centro
        // operativo de la quest y cambia de estado sin mover al jugador.
        <Battle
          snapshot={snapshot}
          busy={busy}
          impact={impact}
          incomingDamage={incomingDamage}
          receivedAt={receivedAt}
          partyFlash={partyFlash}
          onBack={() => setScreen(currentCampaign ? "campaign" : "realm")}
          onOpenStats={() => setScreen("stats")}
          onOpenOrder={() => quest && openOrder(quest.id)}
          onAccept={() => quest && void act(() => api(`/api/quests/${quest.id}/accept`, { method: "POST", body: JSON.stringify({ userAccepted: true }) }))}
          onAcceptAmendment={(amendmentId) => quest && void act(() => api(`/api/quests/${quest.id}/amendments/${amendmentId}/accept`, { method: "POST", body: JSON.stringify({ userAccepted: true }) }))}
          onStart={() => quest && void act(() => api(`/api/quests/${quest.id}/start`, { method: "POST" })).then(() => setNotice(null))}
          onRetry={() => quest && void act(() => api(`/api/quests/${quest.id}/battle/retry`, { method: "POST" }))}
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
      {notice ? <RealmNoticeToast notice={notice} onOpen={() => openNotice(notice)} onDismiss={() => setNotice(null)} /> : null}
      {error ? <div className="error-toast" role="alert">{error}</div> : null}
    </>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
