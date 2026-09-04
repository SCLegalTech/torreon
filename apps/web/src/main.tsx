import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { createRoot } from "react-dom/client";
import { Sprite } from "./Sprite";
import {
  ALLY_CELLS,
  ALLY_QUAD,
  BATTLE_HERO_HEIGHT,
  BattleGrid,
  cellCenter,
  HORDE_QUAD,
  PartySprite,
  REALM_GROUND,
  REALM_HERO_HEIGHT,
  REALM_SPOTS,
} from "./PartySprite";
import type { ActView, AfterActionReport, AgentSlot, BarracksView, BattleClock, BattleStatus, CampaignView, CharacterStats, EnemyCombatant, EntityType, HeroProfileView, InventoryItemId, InventoryState, NotificationView, ObligationView, OpenFrontView, PartyMemberId, PartyState, Quest, QuestNode, RealmSnapshot, RecoveryOffer, TreasuryView, WorldSystemView } from "./types";
import "./styles.css";

type Screen = "loading" | "realm" | "thinking" | "campaign" | "act" | "quest" | "battle" | "stats" | "notifications" | "treasury" | "barracks" | "battles";

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
  kind: "draft" | "started" | "completed" | "amended" | "blocked" | "danger" | "campaign" | "levelup";
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
  // El nivel es gameplay: se celebra, pero no abre ninguna puerta nueva.
  if (event.type === "hero_level_up") return { ...base, kind: "levelup", title: "✨ UN HÉROE HA SUBIDO DE NIVEL", cta: "VER BARRACAS" };
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

/**
 * POSITION IS PRESENTATION, NOT PERMISSION.
 *
 * El nodo trae `locked` del Core, y el Core sólo lo pone `true` cuando existe
 * una dependencia declarada todavía abierta. La pantalla NUNCA vuelve a
 * deducir un bloqueo por posición, por `currentQuestId` legado, por el último
 * borrador ni por la última notificación.
 */
function questNodeOf(snapshot: RealmSnapshot, questId: string): QuestNode | null {
  const hierarchy = snapshot.hierarchy;
  if (!hierarchy) return null;
  const fromCampaigns = (hierarchy.campaigns ?? []).flatMap((campaign) => [
    ...(campaign.directQuests ?? []),
    ...campaign.acts.flatMap((act) => act.quests),
  ]);
  return [...(hierarchy.standaloneQuests ?? []), ...fromCampaigns].find((node) => node.id === questId) ?? null;
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

/**
 * EL REINO.
 *
 * CALCA SOBRE EL MOCKUP, NO SOBRE LA PANTALLA.
 *
 * Los sistemas del mundo que el arte YA dibuja viven encima de su dibujo: el
 * Torreón Principal es las Barracas —ahí viven el grupo y los agentes—, la casa
 * de la Tesorería es la Tesorería, y el valle de en medio es el frente. Cada
 * hotspot va en % del ARTE, dentro de la misma caja que los sprites, así que se
 * queda clavado sobre su edificio aunque el teléfono no sea 16:9.
 *
 * Arriba sólo dos cosas: la campaña en foco y los avisos. Abajo sólo lo que no
 * tiene edificio propio. No hay botón de reinicio: borrar la partida entera no
 * puede vivir a un toque de distancia del juego.
 */
function RealmMenu({
  snapshot,
  onCampaign,
  onCodex,
  onStats,
  onNotifications,
  onTreasury,
  onBarracks,
  onBattles,
  onOpenBattle,
}: {
  snapshot: RealmSnapshot;
  onCampaign: () => void;
  onCodex: () => void;
  onStats: () => void;
  onNotifications: () => void;
  onTreasury: () => void;
  onBarracks: () => void;
  onBattles: () => void;
  onOpenBattle: (questId: string) => void;
}) {
  const hierarchy = snapshot.hierarchy;
  const quickBattles: QuestNode[] = (hierarchy.standaloneQuests ?? []).filter(
    (node) => !["completed", "abandoned"].includes(node.status),
  );
  const openFronts = snapshot.openFronts ?? fallbackOpenFronts(snapshot);
  const front = openFronts[0] ?? null;
  const unread = snapshot.unreadNotifications ?? 0;
  // La campaña que el jugador mira. Las demás siguen vivas y no atacan.
  const campaign =
    hierarchy.campaigns.find((candidate) => candidate.id === hierarchy.focusedCampaignId) ??
    hierarchy.campaigns.find((candidate) => candidate.status === "active") ??
    hierarchy.campaigns.find((candidate) => candidate.status === "draft") ??
    null;

  /*
    LA LISTA LA DECLARA EL CORE; EL SITIO LO DECIDE LA PANTALLA.

    `worldSystems` sigue siendo autoritativo —Tesorería no cuelga de Batallas
    Libres—, pero dónde se pinta cada uno es asunto del escenario: los que el
    arte dibuja van sobre su edificio y sólo el resto baja a la barra.
    Notificaciones estaba arriba Y abajo; ahora sólo arriba.
  */
  const PLACED = new Set(["barracks", "treasury", "notifications", "battle"]);
  const docked: WorldSystemView[] = (snapshot.worldSystems ?? []).filter((system) => !PLACED.has(system.id));
  const openSystem = (system: WorldSystemView) => {
    if (system.id === "campaigns") return onCampaign();
    return onBattles();
  };

  return (
    <main className="scene realm-scene">
      <div className="realm-stage">
        <img className="realm-mockup" src="/assets/art/realm-menu-mockup.png" alt="" aria-hidden="true" />
        <div className="stage-party" aria-label="El grupo del Marqués">
          {REALM_SPOTS.map((spot) => (
            <PartySprite
              key={spot.id}
              id={spot.id}
              decorative
              heroHeight={`calc(var(--stage-h) * ${REALM_HERO_HEIGHT / 100})`}
              className="stage-piece"
              style={{ left: `${spot.centerX}%`, top: `${REALM_GROUND}%`, zIndex: spot.depth }}
            />
          ))}
        </div>
      </div>

      {/*
        Los hotspots viven en una caja gemela del escenario —misma geometría,
        delante— para que reciban el toque sin depender del orden de pintado de
        una capa con z-index negativo.
      */}
      <div className="realm-stage realm-hotspots" aria-label="Sistemas del reino sobre el mapa">
        <button className="stage-hotspot spot-codex" type="button" onClick={onCodex}>
          <strong>CÓDICE</strong>
          <small>Dungeon Master</small>
        </button>
        {/* El Castillo es «tu patrimonio»: la hoja del propio Marqués. */}
        <button className="stage-hotspot spot-castle" type="button" onClick={onStats}>
          <strong>CASTILLO</strong>
          <small>Hoja del Marqués</small>
        </button>
        <button className="stage-hotspot spot-keep" type="button" onClick={onBarracks}>
          <strong>TORREÓN PRINCIPAL</strong>
          <small>El grupo y los agentes</small>
        </button>
        <button className="stage-hotspot spot-treasury" type="button" onClick={onTreasury}>
          <strong>TESORERÍA</strong>
          <small>Recursos y finanzas</small>
        </button>
        {front ? (
          <button className="stage-hotspot spot-front" type="button" onClick={() => onOpenBattle(front.questId)}>
            <strong>FRENTE DE BATALLA</strong>
            <small>
              {front.title} · {front.percent}/100
              {front.marquisDown ? " · MARQUÉS EN EL SUELO" : ""}
            </small>
          </button>
        ) : null}
      </div>

      <header className="realm-bar top">
        <button className="realm-chip campaign" type="button" onClick={onCampaign}>
          <span>CAMPAÑA ACTIVA</span>
          <strong>{campaign ? campaign.title : "SIN CAMPAÑA"}</strong>
          <small>{campaign ? `Quests ${campaign.completedQuests} / ${campaign.totalQuests}` : "Pídele una a Códice"}</small>
        </button>
        <button
          className="realm-icon-button"
          type="button"
          onClick={onNotifications}
          aria-label={`Notificaciones${unread ? `, ${unread} sin leer` : ""}`}
        >
          <span aria-hidden="true">AVISOS</span>
          {unread > 0 ? <span className="realm-bell-badge">{unread > 99 ? "99+" : unread}</span> : null}
        </button>
      </header>

      <nav className="world-systems" aria-label="Sistemas sin edificio propio">
        {docked.map((system) => (
          <button key={system.id} type="button" className={`world-system ${system.id}`} onClick={() => openSystem(system)}>
            <strong>{system.label}</strong>
            <small>{system.detail}</small>
            {system.badge ? <em className="world-badge">{system.badge > 99 ? "99+" : system.badge}</em> : null}
          </button>
        ))}
        {docked.length === 0 ? (
          <button type="button" className="world-system quick_battles" onClick={onBattles}>
            <strong>BATALLAS</strong>
            <small>{quickBattles.length} libre(s)</small>
          </button>
        ) : null}
      </nav>
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

/** Hace «Hace 4 min» sin traer una librería de fechas. */
function relativeTime(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  if (delta < 60_000) return "ahora";
  if (delta < 3_600_000) return `hace ${Math.floor(delta / 60_000)} min`;
  if (delta < 86_400_000) return `hace ${Math.floor(delta / 3_600_000)} h`;
  return `hace ${Math.floor(delta / 86_400_000)} d`;
}

const NOTICE_ICON: Record<string, string> = {
  quest_created: "⚔️",
  campaign_created: "🏰",
  quest_amendment_proposed: "🗺️",
  battle_recontract_proposed: "⏳",
  quest_waiting_external: "🔒",
  quest_unblocked: "🔓",
  battle_lost: "💥",
  recurring_obligation_due: "💰",
  companion_result: "🤝",
};

const BUCKET_LABEL: Record<NotificationView["bucket"], string> = { hoy: "HOY", ayer: "AYER", anteriores: "ANTERIORES" };

const FRONT_STATE_LABEL: Record<BattleStatus, string> = {
  pending: "SIN EMPEZAR",
  active: "RELOJ CORRIENDO",
  suspended_external: "ESPERA EXTERNA",
  awaiting_replan: "PLAZO VENCIDO",
  awaiting_recovery: "EL MARQUÉS CAYÓ",
  won: "GANADA",
};

const QUEST_STATE_LABEL: Record<Quest["status"], string> = {
  draft: "SIN SELLAR",
  accepted: "SELLADA · SIN EMPEZAR",
  active: "EN CURSO",
  waiting_external: "ESPERA EXTERNA",
  completed: "VICTORIA",
  abandoned: "RETIRADA",
};

/**
 * ⚡ BATALLAS.
 *
 * BATALLAS LIBRES ES UNA RUTA REAL, Y UNA BATTLE NO PUEDE VIVIR SÓLO DENTRO DE
 * SU NOTIFICACIÓN.
 *
 * Esta pantalla ABRE SIEMPRE. Tiene dos listas y ninguna se deduce de la
 * posición ni del `currentQuestId` legado:
 *
 *   FRENTES ABIERTOS — toda Battle viva del reino, venga de una Quick Battle o
 *   de la tercera Quest del segundo Acto de una Campaña. Es la ruta normal a un
 *   frente que antes sólo asomaba por la push que lo anunció: archivado el
 *   aviso, la Battle desaparecía del juego.
 *
 *   BATALLAS LIBRES — las Quick Battles sin Campaña ni Acto.
 *
 * Si las dos están vacías, la pantalla igual abre y lo dice. El botón del menú
 * jamás puede quedar muerto.
 */
function BattlesScreen({
  openFronts,
  quickBattles,
  busy,
  onBack,
  onOpenBattle,
  onOpenOrder,
  onDiscard,
}: {
  openFronts: OpenFrontView[];
  quickBattles: QuestNode[];
  busy: boolean;
  onBack: () => void;
  onOpenBattle: (questId: string) => void;
  onOpenOrder: (questId: string) => void;
  onDiscard: (questId: string) => void;
}) {
  /*
    JUGAR O ELIMINAR.

    No toda oportunidad que el reino detecta hay que jugarla. Eliminar pide una
    confirmación en la misma fila —sin modal— porque descarta gameplay real: el
    Core borra un borrador virgen y ABANDONA cualquier cosa con historia, pero
    en los dos casos deja de reclamar atención.
  */
  const [confirming, setConfirming] = useState<string | null>(null);
  const decision = (questId: string, play: () => void) =>
    confirming === questId ? (
      <div className="quest-decision confirming">
        <span>¿Eliminar?</span>
        <button className="flat-button" type="button" disabled={busy} onClick={() => setConfirming(null)}>NO</button>
        <button
          className="flat-button danger"
          type="button"
          disabled={busy}
          onClick={() => {
            setConfirming(null);
            onDiscard(questId);
          }}
        >
          SÍ, ELIMINAR
        </button>
      </div>
    ) : (
      <div className="quest-decision">
        <button className="flat-button primary" type="button" disabled={busy} onClick={play}>JUGAR</button>
        <button className="flat-button" type="button" disabled={busy} onClick={() => setConfirming(questId)}>ELIMINAR</button>
      </div>
    );

  return (
    <main className="scene list-scene battles-scene">
      <header className="list-top">
        <button className="back-button" type="button" onClick={onBack}>← VOLVER</button>
        <div>
          <p className="eyebrow">SISTEMA DEL MUNDO</p>
          <h1>⚡ Batallas</h1>
        </div>
      </header>

      <div className="list-body">
        <p className="list-bucket">FRENTES ABIERTOS</p>
        {openFronts.length === 0 ? (
          <p className="list-empty">
            Ninguna Battle está corriendo ahora mismo. Un frente aparece aquí en cuanto una Quest empieza, y no se va aunque
            archives su aviso.
          </p>
        ) : (
          <ul className="front-list">
            {openFronts.map((front) => (
              <li key={front.questId}>
                <button type="button" onClick={() => onOpenBattle(front.questId)}>
                  <span className={`front-tag ${front.battleStatus}`}>{FRONT_STATE_LABEL[front.battleStatus]}</span>
                  <strong>{front.title}</strong>
                  <small>
                    {front.campaignTitle
                      ? `${front.campaignTitle}${front.actTitle ? ` · ${front.actTitle}` : ""}`
                      : "Batalla libre · sin campaña"}
                  </small>
                  <em>
                    {front.percent}/100 · intento {front.attempt} · {front.durationMinutes} min
                    {front.marquisDown ? " · MARQUÉS EN EL SUELO" : ""}
                  </em>
                </button>
                {decision(front.questId, () => onOpenBattle(front.questId))}
              </li>
            ))}
          </ul>
        )}

        <p className="list-bucket">BATALLAS LIBRES</p>
        {quickBattles.length === 0 ? (
          <p className="list-empty">
            No hay Batallas libres disponibles. Pídele una a Códice para una tarea real de pocos minutos: una Quick Battle no
            necesita Campaña ni Acto.
          </p>
        ) : (
          <ul className="front-list">
            {quickBattles.map((node) => (
              <li key={node.id}>
                <button type="button" onClick={() => onOpenOrder(node.id)}>
                  <span className={`front-tag ${node.status}`}>{QUEST_STATE_LABEL[node.status]}</span>
                  <strong>
                    {node.financeKind === "expense" ? "💰 " : node.financeKind === "income" ? "💵 " : ""}
                    {node.title}
                  </strong>
                  <small>{node.outcome}</small>
                  <em>
                    {node.percent}/100 · {node.durationMinutes} min
                    {node.locked ? ` · 🔒 ${node.lockedBy ?? "depende de otra quest"}` : ""}
                  </em>
                </button>
                {decision(node.id, () => onOpenOrder(node.id))}
              </li>
            ))}
          </ul>
        )}

        <p className="list-note">
          Abrir una Battle sólo la mira: no acepta el contrato, no arranca el reloj y no cierra ningún otro frente.
        </p>
      </div>
    </main>
  );
}

/**
 * CENTRO DE NOTIFICACIONES.
 *
 * El registro persistente de los golpes en la puerta. Una push perdida no borra
 * su aviso; agrupación simple por Hoy / Ayer / Anteriores; cada uno abre EXACTO
 * su entidad por id y no acepta ni inicia nada.
 */
function NotificationCenter({
  notifications,
  busy,
  onBack,
  onOpen,
  onArchive,
  onResend,
}: {
  notifications: NotificationView[];
  busy: boolean;
  onBack: () => void;
  onOpen: (notice: NotificationView) => void;
  onArchive: (id: string) => void;
  onResend: (id: string) => void;
}) {
  const buckets: NotificationView["bucket"][] = ["hoy", "ayer", "anteriores"];
  const unread = notifications.filter((notice) => !notice.read).length;
  return (
    <main className="scene notif-scene">
      <header className="notif-top">
        <button className="back-button" type="button" onClick={onBack}>← VOLVER</button>
        <div>
          <p className="eyebrow">CENTRO DE NOTIFICACIONES</p>
          <h1>🔔 Avisos {unread > 0 ? <span className="notif-count">{unread}</span> : null}</h1>
        </div>
      </header>

      {/*
        SCROLL VERTICAL REAL.

        La cabecera queda fija y la LISTA es la que se desplaza. No se resuelve
        archivando avisos, ni subiendo una altura fija, ni renderizando menos:
        con veinte avisos hay que poder llegar al último y seguir tocando sus
        botones.
      */}
      <div className="notif-list">
      {notifications.length === 0 ? (
        <p className="notif-empty">No hay avisos. Un pacto nuevo aparecerá aquí y no se perderá aunque llegue otro después.</p>
      ) : (
        buckets.map((bucket) => {
          const group = notifications.filter((notice) => notice.bucket === bucket);
          if (group.length === 0) return null;
          return (
            <section key={bucket} className="notif-group">
              <p className="notif-bucket">{BUCKET_LABEL[bucket]}</p>
              {group.map((notice) => (
                <article key={notice.id} className={`notif-card ${notice.read ? "read" : "unread"} ${notice.priority}`}>
                  <span className="notif-icon" aria-hidden="true">{NOTICE_ICON[notice.type] ?? "•"}</span>
                  <div className="notif-body">
                    <strong>{notice.title}</strong>
                    <p>{notice.body}</p>
                    <small>{relativeTime(notice.createdAt)} · entrega {notice.push.lastStatus}</small>
                  </div>
                  <div className="notif-actions">
                    <button className="gold-button" type="button" disabled={busy} onClick={() => onOpen(notice)}>ABRIR</button>
                    <button className="ghost-button" type="button" disabled={busy} onClick={() => onResend(notice.id)}>REENVIAR</button>
                    <button className="ghost-button" type="button" disabled={busy} onClick={() => onArchive(notice.id)}>ARCHIVAR</button>
                  </div>
                </article>
              ))}
            </section>
          );
        })
      )}
      </div>
    </main>
  );
}

const FREQ_LABEL: Record<ObligationView["frequency"], string> = {
  weekly: "semanal",
  biweekly: "quincenal",
  monthly: "mensual",
  bimonthly: "bimestral",
  quarterly: "trimestral",
  yearly: "anual",
};

/**
 * TESORERÍA.
 *
 * Dinero real en COP. Nunca un recurso comprable del juego. El monto de una
 * obligación puede ser desconocido y no se inventa; el estado es del PERÍODO en
 * curso, no «pagado para siempre».
 */
function TreasuryScreen({
  treasury,
  currency,
  onBack,
}: {
  treasury: TreasuryView;
  currency: string;
  onBack: () => void;
}) {
  const statusLabel: Record<ObligationView["periodStatus"], string> = {
    paid: "PAGADO",
    pending: "PENDIENTE",
    upcoming: "PRÓXIMO",
  };
  return (
    <main className="scene treasury-scene">
      <header className="treasury-top">
        <button className="back-button" type="button" onClick={onBack}>← VOLVER</button>
        <div>
          <p className="eyebrow">TESORERÍA</p>
          <h1>💰 Dinero real del reino</h1>
        </div>
      </header>

      <div className="treasury-body">
      <section className="treasury-grid">
        <article className="config-card">
          <p className="eyebrow">BALANCE OBSERVADO</p>
          <strong>{formatTreasure(treasury.observedBalance, currency)}</strong>
        </article>
        <article className="config-card">
          <p className="eyebrow">INGRESOS ESPERADOS</p>
          <strong>{formatTreasure(treasury.expectedIncome, currency)}</strong>
        </article>
        <article className="config-card">
          <p className="eyebrow">GASTOS COMPROMETIDOS</p>
          <strong>{formatTreasure(treasury.committedExpenses, currency)}</strong>
        </article>
        <article className="config-card">
          <p className="eyebrow">MARGEN PROYECTADO</p>
          <strong className={treasury.projectedMargin < 0 ? "negative" : ""}>{formatTreasure(treasury.projectedMargin, currency)}</strong>
        </article>
      </section>

      <section className="treasury-list">
        <p className="eyebrow">PRÓXIMAS OBLIGACIONES</p>
        {treasury.upcomingObligations.length === 0 ? (
          <p className="treasury-empty">Nada pendiente este período.</p>
        ) : (
          treasury.upcomingObligations.map((obligation) => (
            <article key={obligation.id} className={`obligation-card ${obligation.periodStatus}`}>
              <div>
                <strong>{obligation.direction === "income" ? "↑" : "↓"} {obligation.name}</strong>
                <small>{obligation.provider ? `${obligation.provider} · ` : ""}{FREQ_LABEL[obligation.frequency]}</small>
              </div>
              <div className="obligation-right">
                <b>{obligation.expectedAmount != null ? formatTreasure(obligation.expectedAmount, obligation.currency) : "monto sin confirmar"}</b>
                <em>{statusLabel[obligation.periodStatus]}</em>
              </div>
            </article>
          ))
        )}
      </section>

      <section className="treasury-list">
        <p className="eyebrow">RECURRENTES</p>
        {treasury.recurring.length === 0 ? (
          <p className="treasury-empty">Aún no hay obligaciones recurrentes registradas. Pídeselas al Códice.</p>
        ) : (
          treasury.recurring.map((obligation) => (
            <article key={obligation.id} className="obligation-card recurring">
              <div>
                <strong>{obligation.direction === "income" ? "↑" : "↓"} {obligation.name}</strong>
                <small>{FREQ_LABEL[obligation.frequency]}{obligation.lastPaidPeriod ? ` · último: ${obligation.lastPaidPeriod}` : ""}</small>
              </div>
              <em>{statusLabel[obligation.periodStatus]}</em>
            </article>
          ))
        )}
      </section>

      <p className="treasury-note">
        Pagar una obligación concede XP y Aura, pero el dinero real SALE de aquí. Ninguna quest fabrica monedas por gastar dinero real.
      </p>
      </div>
    </main>
  );
}


const DEPLOYMENT_LABEL: Record<string, string> = {
  known: "CONOCIDO",
  available: "DISPONIBLE",
  deployed: "EN EL FRENTE",
  participated: "HA PARTICIPADO",
  contribution_validated: "CONTRIBUCIÓN VALIDADA",
  unavailable: "NO DISPONIBLE",
};

const DEED_LABEL: Record<string, string> = {
  participated: "ejecutó",
  verified: "verificado",
  victory: "victoria",
};

/**
 * 🛡️ BARRACAS.
 *
 * No es inventario, no es Campaña y no es historial de Battles: es donde vive
 * la representación persistente del jugador, sus compañeros y sus agentes.
 *
 * AN AGENT IS A HERO ONLY WHEN IT ACTUALLY PARTICIPATES: un aliado que nunca
 * ejecutó nada aparece aquí con todos sus contadores en cero, y eso es lo
 * honesto. LEVEL IS NOT PERMISSION: subir de nivel no abre ninguna puerta del
 * mundo real; enviar, firmar, pagar o desplegar siguen exigiendo autorización.
 */
function BarracksScreen({
  barracks,
  onBack,
}: {
  barracks: BarracksView;
  onBack: () => void;
}) {
  const [openHeroId, setOpenHeroId] = useState<string | null>(null);
  const party = barracks.heroes.filter((hero) => hero.kind === "party");
  const agents = barracks.heroes.filter((hero) => hero.kind === "agent");
  const openHero = barracks.heroes.find((hero) => hero.id === openHeroId) ?? null;

  const card = (hero: HeroProfileView) => {
    const ratio = hero.xpToNextLevel > 0 ? Math.min(100, Math.round((hero.xpIntoLevel / hero.xpToNextLevel) * 100)) : 100;
    const veteran = hero.stats.executions > 0 || hero.stats.battlesEntered > 0;
    return (
      <article key={hero.id} className={`hero-card ${hero.kind} ${veteran ? "veteran" : "fresh"}`}>
        <header>
          <strong>{hero.displayName.toUpperCase()}</strong>
          <em>{DEPLOYMENT_LABEL[hero.deployment] ?? hero.deployment}</em>
        </header>
        <small className="hero-class">{hero.className}</small>
        <p className="hero-level">NIVEL {hero.level}</p>
        <div className="hero-xp"><span style={{ width: `${ratio}%` }} /></div>
        <small className="hero-xp-label">
          {hero.xpToNextLevel > 0 ? `${hero.xpIntoLevel}/${hero.xpToNextLevel} XP` : "NIVEL MÁXIMO"}
        </small>
        <ul className="hero-stats">
          {hero.kind === "agent" ? (
            <>
              <li><span>Assists validados</span><b>{hero.stats.validatedAssists}</b></li>
              <li><span>Ejecuciones</span><b>{hero.stats.successfulExecutions}</b></li>
              <li><span>Battles asistidas</span><b>{hero.stats.questsAssisted}</b></li>
              <li><span>Impacto apoyado</span><b>{hero.stats.supportedImpact}</b></li>
            </>
          ) : (
            <>
              <li><span>Battles</span><b>{hero.stats.battlesEntered}</b></li>
              <li><span>Victorias</span><b>{hero.stats.battlesWon}</b></li>
              <li><span>Quests</span><b>{hero.stats.questsCompleted}</b></li>
              <li><span>Impacto validado</span><b>{hero.stats.validatedImpact}</b></li>
            </>
          )}
        </ul>
        {!veteran ? <p className="hero-empty">Todavía no ha peleado. Sus cifras se quedan en cero: aquí no se inventan hazañas.</p> : null}
        <button className="ghost-button" type="button" onClick={() => setOpenHeroId(hero.id)}>VER HÉROE</button>
      </article>
    );
  };

  return (
    <main className="scene barracks-scene">
      <header className="barracks-top">
        <button className="back-button" type="button" onClick={onBack}>← VOLVER</button>
        <div>
          <p className="eyebrow">SISTEMA DEL MUNDO</p>
          <h1>🛡️ Barracas</h1>
        </div>
      </header>

      <div className="barracks-body">
        {barracks.lastFormation ? (
          <section className="last-formation glass-panel">
            <p className="eyebrow">ÚLTIMA FORMACIÓN</p>
            <p className="formation-heroes">{barracks.lastFormation.heroes.map((hero) => hero.displayName).join(" · ")}</p>
            <p className="formation-quest">
              <strong>{barracks.lastFormation.questTitle}</strong>
              <em>
                {barracks.lastFormation.result === "victory"
                  ? "VICTORIA"
                  : barracks.lastFormation.result === "in_progress"
                    ? "EN CURSO"
                    : "FRENTE ABIERTO"}
              </em>
            </p>
          </section>
        ) : null}

        <p className="barracks-bucket">EL GRUPO</p>
        <section className="hero-grid">{party.map(card)}</section>

        <p className="barracks-bucket">AGENTES</p>
        <section className="hero-grid">{agents.map(card)}</section>

        <p className="barracks-note">
          Códice no ocupa slot: es el Dungeon Master. Y el nivel de un héroe es gameplay, nunca un permiso: enviar, firmar,
          pagar o desplegar siguen exigiendo autorización humana real.
        </p>
      </div>

      {openHero ? (
        <div className="hero-sheet" role="dialog" aria-modal="true" aria-label={`Hoja de ${openHero.displayName}`}>
          <article>
            <button className="notice-dismiss" type="button" onClick={() => setOpenHeroId(null)} aria-label="Cerrar">×</button>
            <p className="eyebrow">{openHero.className.toUpperCase()}</p>
            <h2>{openHero.displayName}</h2>
            <p className="hero-sheet-level">
              NIVEL {openHero.level} · {openHero.xp} XP · {DEPLOYMENT_LABEL[openHero.deployment] ?? openHero.deployment}
            </p>

            <p className="eyebrow">CAPACIDADES</p>
            <p className="hero-caps">{openHero.capabilities.join(" · ") || "Sin capacidades declaradas."}</p>

            <p className="eyebrow">HABILIDADES</p>
            <ul className="hero-abilities">
              {openHero.abilities.map((ability) => (
                <li key={ability.id}>
                  <strong>{ability.name}</strong>
                  <small>{ability.description} — se activa por {ability.triggeredBy}.</small>
                </li>
              ))}
            </ul>

            <p className="eyebrow">MAESTRÍAS</p>
            {openHero.masteries.length === 0 ? (
              <p className="hero-empty">Ninguna maestría todavía. Sólo un resultado validado la mueve.</p>
            ) : (
              <ul className="hero-masteries">
                {openHero.masteries.map((mastery) => (
                  <li key={mastery.domain}>
                    <strong>{mastery.domain} · {mastery.points}</strong>
                    {/* MASTERY MUST BE EXPLAINABLE: de dónde salió cada punto. */}
                    <small>{mastery.evidence.join(" · ") || "Sin desglose registrado."}</small>
                  </li>
                ))}
              </ul>
            )}

            <p className="eyebrow">HAZAÑAS RECIENTES</p>
            {openHero.recentDeeds.length === 0 ? (
              <p className="hero-empty">Sin hazañas. No se narra ninguna sin un hecho real detrás.</p>
            ) : (
              <ul className="hero-deeds">
                {openHero.recentDeeds.map((deed) => (
                  <li key={deed.id}>
                    <strong>{deed.questTitle}</strong>
                    <small>
                      {deed.summary}
                      {deed.sourceTool ? ` · ${deed.sourceTool}` : ""} · {DEED_LABEL[deed.outcome] ?? deed.outcome} · {relativeTime(deed.createdAt)}
                    </small>
                  </li>
                ))}
              </ul>
            )}
          </article>
        </div>
      ) : null}
    </main>
  );
}

/**
 * INFORME DE ACCIÓN.
 *
 * Determinista: sale de los hechos de la Battle, no de un relato. Aquí es donde
 * el jugador ve cuánto duró DE VERDAD lo que creía que tomaba veinte minutos.
 */
function AfterActionPanel({ report }: { report: AfterActionReport }) {
  const minutes = Math.round(report.actualActiveMs / 60_000);
  return (
    <section className="after-action glass-panel">
      <p className="eyebrow">INFORME DE ACCIÓN</p>
      <h3>{report.questTitle}</h3>
      <ul className="aar-facts">
        <li><span>Duración real</span><b>{minutes} min</b></li>
        <li><span>Pactada</span><b>{report.plannedDurationMinutes} min</b></li>
        <li><span>Replanes</span><b>{report.replans}</b></li>
        <li><span>Imprevistos</span><b>{report.unexpectedRequirements}</b></li>
      </ul>
      <p className="aar-party">{report.party.join(" · ")}</p>
      {report.companionsUsed.length > 0 ? (
        <p className="aar-agent">
          Agentes: {report.companionsUsed.join(", ")} · {report.agentContribution.assistedSteps} paso(s) asistidos · +{report.agentContribution.comboDamage} combo
        </p>
      ) : null}
      {report.lessons.length > 0 ? (
        <ul className="aar-lessons">
          {report.lessons.map((lesson) => <li key={lesson}>✦ {lesson}</li>)}
        </ul>
      ) : null}
    </section>
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
 * UNA APK NUEVA CONTRA UN REINO VIEJO.
 *
 * `openFronts` lo proyecta el Core, pero la APK llega al teléfono antes que el
 * despliegue del servidor. Sin este respaldo, Batallas abriría diciendo «no hay
 * ninguna Battle» mientras el jugador tiene una a medias: un vacío FALSO, que
 * es peor que un botón muerto porque además miente.
 *
 * Se deriva de la jerarquía, que sí llega: toda Quest cuyo `battleStatus` diga
 * que su Battle existe y no terminó. Sin heurísticas de «la última»: cada
 * entrada lleva su id exacto, igual que la proyección buena.
 */
function fallbackOpenFronts(snapshot: RealmSnapshot): OpenFrontView[] {
  const hierarchy = snapshot.hierarchy;
  const live: OpenFrontView[] = [];
  const push = (node: QuestNode, campaignTitle: string | null, actTitle: string | null) => {
    if (node.battleStatus === "pending" || node.battleStatus === "won") return;
    live.push({
      questId: node.id,
      title: node.title,
      campaignTitle,
      actTitle,
      status: node.status,
      battleStatus: node.battleStatus,
      percent: node.percent,
      durationMinutes: node.durationMinutes,
      attempt: snapshot.battleQuestId === node.id ? snapshot.battle?.attempt ?? 1 : 1,
      engaged: hierarchy.engagedQuestId === node.id,
      // Sólo se puede afirmar del frente que el Core está proyectando ahora.
      marquisDown: snapshot.battleQuestId === node.id && snapshot.battle?.party.marques.health === 0,
    });
  };
  for (const node of hierarchy.standaloneQuests ?? []) push(node, null, null);
  for (const campaign of hierarchy.campaigns ?? []) {
    for (const node of campaign.directQuests ?? []) push(node, campaign.title, null);
    for (const act of campaign.acts) for (const node of act.quests) push(node, campaign.title, act.title);
  }
  return live.sort((a, b) => Number(b.engaged) - Number(a.engaged));
}

/**
 * Un servidor viejo todavía no manda la vista de Tesorería. Se arma con lo que
 * el reino sí sabe —el estado financiero— para que la pantalla nunca quede rota.
 */
function fallbackTreasury(snapshot: RealmSnapshot): TreasuryView {
  const financial = snapshot.realm.financial;
  return {
    currency: financial.currency,
    observedBalance: financial.availableBalance,
    expectedIncome: financial.expectedIncome,
    committedExpenses: financial.committedExpenses,
    reserveTarget: financial.reserveTarget,
    projectedMargin: snapshot.projectedMargin,
    upcomingObligations: [],
    recurring: [],
  };
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
  /*
    EL RELOJ, MINIMALISTA.

    Ocupaba un panel con título, cifra grande, barra y un párrafo explicando la
    mecánica de la presión. Esa explicación es de manual, no de HUD: aquí sólo
    va lo que cambia segundo a segundo —la cifra— y una línea de progreso.
  */
  return (
    <section className={`battle-timer ${danger ? "danger" : ""} ${clock.suspended ? "suspended" : ""}`} aria-live="off">
      <strong>{formatClock(remaining)}</strong>
      <span>
        {clock.suspended
          ? "EN PAUSA"
          : status === "awaiting_replan"
            ? "VENCIDO"
            : status === "awaiting_recovery"
              ? "CAÍDO"
              : status === "won"
                ? "MARGEN"
                : `${clock.durationMinutes} MIN`}
      </span>
      <div className="timer-track"><span style={{ width: `${spent}%` }} /></div>
    </section>
  );
}

/** Destello momentáneo de un miembro del grupo: cura, escudo o crítico recibido. */
export type PartyFlash = Partial<Record<PartyMemberId, "heal" | "shield" | "critical">>;

const PARTY_SLOTS: PartyMemberId[] = ["roko", "marques", "cordera"];

const ITEM_NAMES: Record<InventoryItemId, string> = {
  revive_tonic: "Tónico de Retorno",
  health_potion: "Poción Carmesí",
};

const ROLE_LABELS: Record<string, string> = {
  tank: "Guardia",
  ranged: "Arquero",
  assassin: "Asesino",
  breaker: "Rompedor",
  support: "Apoyo",
  drain: "Drenaje",
  mage: "Agobio",
  disruptor: "Sabotaje",
  berserker: "Frenesí",
  captain: "Capitán",
};

/**
 * LA FORMACIÓN ENEMIGA.
 *
 * Cuatro enemigos con rostro, no una barra. Cada tarjeta dice quién es, qué
 * papel juega y cuánto aguanta, para que el jugador entienda por qué le están
 * pegando por la retaguardia.
 */
function EnemyRow({ enemies }: { enemies: EnemyCombatant[] }) {
  if (enemies.length === 0) return null;
  return (
    <section className="enemy-row" aria-label="La Horda">
      {enemies.map((enemy) => (
        <article key={enemy.id} className={`enemy-card is-${enemy.status} ${enemy.position}`} title={enemy.abilityName ?? enemy.name}>
          <header>
            <strong>{enemy.name}</strong>
            <em>{enemy.status === "ko" ? "KO" : ROLE_LABELS[enemy.role] ?? enemy.role}</em>
          </header>
          <div className="enemy-bar"><span style={{ width: `${(enemy.health / enemy.maxHealth) * 100}%` }} /></div>
          <b>{enemy.health}/{enemy.maxHealth}</b>
        </article>
      ))}
    </section>
  );
}

/**
 * EL GRUPO, EN CUATRO SLOTS.
 *
 * ROKO PROTEGE. MARQUÉS DISPARA. CORDERA SOSTIENE. EL AGENTE EJECUTA.
 *
 * El cuarto slot aparece vacío hasta que un compañero real ejecuta algo: no se
 * dibuja a Opus por existir. Las cifras las deriva el Core; React sólo pinta.
 */
function PartyHud({
  party,
  agent,
  flash,
  heroes,
  onUseItem,
}: {
  party: PartyState;
  agent: AgentSlot;
  flash: PartyFlash;
  heroes: HeroProfileView[];
  onUseItem?: (target: PartyMemberId) => void;
}) {
  /*
    INFORMACIÓN COMPACTA, NO UN MODAL GIGANTE.

    Tocar un aliado durante la Battle abre una línea con su carrera; tocar al
    agente muestra su estado de asistencia. Nada de esto ataca ni concede nada:
    no existe un botón de ATACAR para los agentes, y no va a existir.
  */
  const [peek, setPeek] = useState<string | null>(null);
  const heroById = (id: string) => heroes.find((hero) => hero.id === id) ?? null;
  return (
    <section className="party-hud" aria-label="El grupo del Marqués">
      {PARTY_SLOTS.map((id) => {
        const member = party[id];
        const pulse = flash[id];
        const badge = member.status === "ko" ? "KO" : pulse ? pulse.toUpperCase() : "ACTIVE";
        const hero = heroById(id);
        return (
          <article
            key={id}
            className={`party-member is-${member.status} ${pulse ?? ""} ${peek === id ? "peeking" : ""}`}
            onClick={() => setPeek((open) => (open === id ? null : id))}
          >
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
            {peek === id && hero ? (
              <p className="party-peek">
                NV {hero.level} · {hero.stats.battlesWon}/{hero.stats.battlesEntered} Battles · {hero.stats.questsCompleted} Quests
              </p>
            ) : null}
            {member.status === "ko" && onUseItem ? (
              <button
                className="revive-button"
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onUseItem(id);
                }}
              >
                REVIVIR
              </button>
            ) : null}
          </article>
        );
      })}
      <article
        className={`party-member agent ${agent.deployed ? agent.status : "undeployed"} ${peek === "agent" ? "peeking" : ""}`}
        onClick={() => setPeek((open) => (open === "agent" ? null : "agent"))}
      >
        <header>
          <strong>{agent.deployed ? (agent.name ?? "AGENTE").toUpperCase() : "AGENTE"}</strong>
          <em>{agent.status === "assist_validated" ? "COMBO" : agent.deployed ? "PENDIENTE" : "—"}</em>
        </header>
        {agent.deployed ? (
          <>
            <small className="agent-role">{agent.role}</small>
            <b>{agent.comboDamage > 0 ? `+${agent.comboDamage} COMBO` : "ASSIST SIN VALIDAR"}</b>
            {agent.secondaryAssists.length > 0 ? <small className="agent-extra">+{agent.secondaryAssists.join(", ")}</small> : null}
            {peek === "agent" && agent.companion ? (
              <p className="party-peek">
                {(() => {
                  const hero = heroById(agent.companion);
                  if (!hero) return "Sin carrera registrada todavía.";
                  return `NV ${hero.level} · ${hero.stats.validatedAssists} assist validados · ${hero.stats.successfulExecutions} ejecuciones`;
                })()}
              </p>
            ) : null}
          </>
        ) : (
          <>
            <small className="agent-role">Sin desplegar</small>
            <b>NINGÚN ALIADO HA PELEADO</b>
            {peek === "agent" ? (
              <p className="party-peek">Estar disponible no es haber peleado: el slot se llena con una ejecución real.</p>
            ) : null}
          </>
        )}
      </article>
    </section>
  );
}

/**
 * EL ZURRÓN.
 *
 * Los objetos se gastan y el Core es el único que los descuenta.
 *
 * USAR OBJETO NO PUEDE SER UN NO-OP. Este panel siempre termina en una de
 * cuatro cosas: un selector con objetivos válidos, «no tienes objetos», «hay
 * objetos pero ninguno es legal aquí y este es el motivo», o el error que el
 * Core devuelva. Nunca en silencio.
 *
 * CANON, y no se toca para «arreglar» el flujo:
 *   Poción Carmesí  — cura a quien sigue EN PIE. No revive.
 *   Tónico de Retorno — levanta a un CAÍDO. Es la única resurrección que existe.
 */
function InventoryDrawer({
  inventory,
  party,
  busy,
  onClose,
  onUse,
}: {
  inventory: InventoryState;
  party: PartyState;
  busy: boolean;
  onClose: () => void;
  onUse: (itemId: InventoryItemId, target: PartyMemberId) => void;
}) {
  const available = inventory.items.filter((entry) => entry.quantity > 0);
  /*
    LA SELECCIÓN NO PUEDE APUNTAR A LO QUE NO EXISTE.

    Antes arrancaba fija en `health_potion`: con sólo un Tónico en el zurrón, el
    panel abría preguntando a quién curar, no había nadie vivo herido que lo
    aceptara, y el jugador concluía que «Usar objeto» no hacía nada. Ahora la
    selección arranca en el primer objeto que de verdad queda.
  */
  const [chosen, setChosen] = useState<InventoryItemId | null>(null);
  const itemId: InventoryItemId | null =
    chosen && available.some((entry) => entry.itemId === chosen) ? chosen : available[0]?.itemId ?? null;
  const needsKo = itemId === "revive_tonic";
  const targets = itemId ? PARTY_SLOTS.filter((id) => (needsKo ? party[id].health === 0 : party[id].health > 0)) : [];
  // Cuando no hay objetivo, el panel dice POR QUÉ. Un selector vacío no explica.
  const noTargetReason = needsKo
    ? "Nadie está en el suelo. El Tónico de Retorno levanta a un caído; no cura a quien sigue en pie."
    : "Todos los que siguen en pie están intactos, o el único que falta está KO. La Poción Carmesí cierra heridas, no resucita.";
  return (
    <aside className="inventory-drawer" role="dialog" aria-label="Zurrón">
      <header>
        <strong>🎒 INVENTARIO</strong>
        <button type="button" onClick={onClose} aria-label="Cerrar inventario">×</button>
      </header>
      {available.length === 0 ? (
        <>
          <p className="inventory-empty">No tienes objetos disponibles. El zurrón está vacío.</p>
          <p className="inventory-hint">
            Un objeto gastado no vuelve por perder la Battle. Si el Marqués está en el suelo y no queda Tónico, la salida es
            retirar al grupo a las Barracas.
          </p>
        </>
      ) : (
        <>
          <ul className="inventory-list">
            {available.map((entry) => (
              <li key={entry.itemId}>
                <button type="button" className={entry.itemId === itemId ? "current" : ""} onClick={() => setChosen(entry.itemId)}>
                  {ITEM_NAMES[entry.itemId]} <b>×{entry.quantity}</b>
                </button>
              </li>
            ))}
          </ul>
          <p className="inventory-hint">
            {needsKo ? "Levanta a un caído con parte de su vida." : "Cierra heridas de quien sigue en pie. No resucita."}
          </p>
          <div className="inventory-targets">
            {targets.length === 0 ? (
              <small>{noTargetReason}</small>
            ) : (
              targets.map((id) => (
                <button key={id} type="button" disabled={busy} onClick={() => onUse(itemId!, id)}>
                  {party[id].name} <b>{party[id].health}/{party[id].maxHealth}</b>
                </button>
              ))
            )}
          </div>
        </>
      )}
    </aside>
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

      <div className="scene-body">
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

      </div>

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


      {/*
        UN CUERPO QUE SE DESPLAZA, NO NUEVE PANELES EN PORCENTAJES.

        Estas pantallas se calcaban sobre el mockup: cada panel clavado en un %
        del arte, con alturas fijas y tipografías que bajaban hasta cuatro
        píxeles para caber. En un teléfono apaisado —donde la altura útil son
        cuatrocientos y pico píxeles— eso deja de ser una calca y pasa a ser un
        montón: los paneles se solapan, el texto no se lee y la mitad de los
        controles quedan debajo de otro. La cabecera y la barra de acción se
        quedan quietas; TODO lo demás vive aquí y se desplaza.
      */}
      <div className="scene-body">
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
              <div><dt>Estado</dt><dd>{next.battleStatus === "awaiting_replan" ? "Plazo vencido" : next.battleStatus === "awaiting_recovery" ? "El Marqués cayó" : next.status}</dd></div>
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

      </div>

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
  onDiscard,
}: {
  snapshot: RealmSnapshot;
  questId: string | null;
  busy: boolean;
  receivedAt: number;
  onBack: () => void;
  onAccept: (questId: string) => void;
  onStart: (questId: string) => void;
  onEnterBattle: (questId: string) => void;
  onOpenStats: () => void;
  onDiscard: (questId: string) => void;
}) {
  const current = snapshot.currentQuest;
  // ELIMINAR también desde el detalle: es donde el jugador termina de decidir.
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
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
        <div className="scene-body">
          <article className="order-sheet">
            <p className="eyebrow">ORDEN DE MISIÓN</p>
            <h1>Sin orden abierta</h1>
            <p className="order-lead">{failure ?? "El Códice todavía no ha redactado esta misión."}</p>
          </article>
        </div>
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
  // El frente se nombra. Si el servidor todavía no proyecta `openFronts`, el
  // nombre sale de la jerarquía: un botón que dice «otro frente» no informa.
  const engagedTitle =
    snapshot.openFronts?.find((front) => front.questId === engagedQuestId)?.title ??
    (engagedQuestId ? questNodeOf(snapshot, engagedQuestId)?.title : null) ??
    "otro frente";
  /*
    ESTA QUEST YA NO «ESPERA SU TURNO» POR NO SER LA ACTUAL.

    Antes el botón se apagaba con `!isCurrent`, es decir con la proyección
    legada `currentQuest`: una Quest con locked=false y el Core permitiendo
    accept_quest y start_quest aparecía bloqueada en la pantalla. Ahora el
    bloqueo sólo puede venir del Core, y sólo si hay una dependencia declarada.
  */
  const report = (snapshot.battleMemory?.reports ?? []).find((candidate) => candidate.questId === quest.id) ?? null;
  const node = questNodeOf(snapshot, quest.id);
  const lockedByDependency = node?.locked ?? false;
  /*
    UNA BATTLE SE PUEDE ABRIR SI EXISTE, NO SI ES «LA ACTUAL».

    Antes esto comparaba contra la proyección legada `currentQuest`: una Quest
    con su frente abierto —plazo vencido, Marqués caído— quedaba con el botón
    apagado en «FRENTE ABIERTO» sólo porque el legado apuntaba a otra. Ahora
    basta con que el Core diga que esta Quest tiene Battle.
  */
  const battleViewable = node ? node.battleStatus !== "pending" : Boolean(battle);
  const campaign = snapshot.hierarchy?.campaigns.find((candidate) => candidate.id === snapshot.hierarchy.currentCampaignId) ?? null;

  return (
    <main className="scene order-scene">
      <img className="map-art" src="/assets/art/quest-order.png" alt="" aria-hidden="true" />
      <RealmTopBar snapshot={snapshot} onOpenStats={onOpenStats} />


      {/*
        UN CUERPO QUE SE DESPLAZA, NO NUEVE PANELES EN PORCENTAJES.

        Estas pantallas se calcaban sobre el mockup: cada panel clavado en un %
        del arte, con alturas fijas y tipografías que bajaban hasta cuatro
        píxeles para caber. En un teléfono apaisado —donde la altura útil son
        cuatrocientos y pico píxeles— eso deja de ser una calca y pasa a ser un
        montón: los paneles se solapan, el texto no se lee y la mitad de los
        controles quedan debajo de otro. La cabecera y la barra de acción se
        quedan quietas; TODO lo demás vive aquí y se desplaza.
      */}
      <div className="scene-body">
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

        {/*
          AFTER ACTION REPORT.

          Determinista y sacado de los hechos de la Battle. Es lo que impide que
          la próxima vez se vuelva a estimar mal: aquí se ve cuánto duró de
          verdad lo que se pactó en otra cifra.
        */}
        {report ? <AfterActionPanel report={report} /> : null}

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
            <p>Intento {battle.attempt} · {battle.status === "awaiting_replan" ? "Plazo vencido" : battle.status === "awaiting_recovery" ? "El Marqués cayó" : battle.status === "won" ? "Battle ganada" : battle.clock.suspended ? "Presión suspendida" : "Reloj corriendo"}</p>
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

      </div>

      <div className="order-actions">
        <button className="back-button" type="button" onClick={onBack}>← ATRÁS</button>
        {/*
          La misión que no se quiere jugar no tiene por qué quedarse abierta.
          El Core decide si eso es borrar un borrador virgen o abandonar algo
          con historia; aquí sólo se ofrece la decisión, con confirmación.
        */}
        {quest.status !== "completed" ? (
          confirmingDiscard ? (
            <span className="quest-decision confirming">
              <span>¿Eliminar esta misión?</span>
              <button className="flat-button" type="button" onClick={() => setConfirmingDiscard(false)}>NO</button>
              <button
                className="flat-button danger"
                type="button"
                disabled={busy}
                onClick={() => {
                  setConfirmingDiscard(false);
                  onDiscard(quest.id);
                }}
              >
                SÍ, ELIMINAR
              </button>
            </span>
          ) : (
            <button className="flat-button" type="button" disabled={busy} onClick={() => setConfirmingDiscard(true)}>
              ELIMINAR
            </button>
          )
        ) : null}
        {lockedByDependency ? (
          // El ÚNICO bloqueo legítimo, y dice exactamente quién lo causa.
          <button className="expedition-button" type="button" disabled title={node?.lockedBy}>
            🔒 {node?.lockedBy ?? "ESTA QUEST DEPENDE DE OTRA TODAVÍA ABIERTA"}
          </button>
        ) : quest.status === "draft" ? (
          // Sellar un pacto NUNCA depende de que otra Battle esté corriendo.
          <button className="expedition-button" type="button" disabled={busy} onClick={() => onAccept(quest.id)}>✍ ACEPTAR CONTRATO</button>
        ) : engagedElsewhere ? (
          /*
            ONE ENGAGED BATTLE — Y EL BOTÓN LLEVA A DONDE SÍ SE PUEDE IR.

            El Core sólo proyecta la Battle del frente comprometido, así que
            «VOLVER A LA BATALLA» sobre esta Quest no podía abrir nada: mandaba
            de vuelta a esta misma pantalla y parecía un botón roto. Ahora dice
            de quién es el reloj y abre ESE frente, que es la acción que existe.
          */
          <button className="expedition-button" type="button" onClick={() => onEnterBattle(engagedQuestId!)}>
            ⚔ EL RELOJ LO TIENE «{engagedTitle.toUpperCase()}» · IR ALLÍ
          </button>
        ) : quest.status === "accepted" ? (
          <button className="expedition-button" type="button" disabled={busy} onClick={() => onStart(quest.id)}>⚔ INICIAR EXPEDICIÓN · {quest.durationMinutes} MIN</button>
        ) : quest.status === "completed" ? (
          battleViewable ? (
            <button className="expedition-button" type="button" onClick={() => onEnterBattle(quest.id)}>🏆 VER RESULTADO</button>
          ) : (
            <button className="expedition-button" type="button" disabled>🏆 VICTORIA · {validated}/100</button>
          )
        ) : battleViewable ? (
          <button className="expedition-button" type="button" onClick={() => onEnterBattle(quest.id)}>⚔ VOLVER A LA BATALLA · {validated}/100</button>
        ) : (
          <button className="expedition-button" type="button" disabled>⚔ FRENTE ABIERTO · {validated}/100</button>
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
  recovery,
  onUseItem,
  onAcceptRecontract,
  onBack,
  onOpenStats,
  onOpenOrder,
  onAccept,
  onAcceptAmendment,
  onStart,
  onRetry,
  onRecover,
  onDeliverEvidence,
}: {
  snapshot: RealmSnapshot;
  busy: boolean;
  impact: number | null;
  incomingDamage: number | null;
  /** Momento local de la última lectura: ancla la cuenta atrás sin inventar tiempo. */
  receivedAt: number;
  partyFlash: PartyFlash;
  /** Lo que el Core concede fuera de Battle. La pantalla pregunta, no calcula. */
  recovery: RecoveryOffer;
  onUseItem: (itemId: InventoryItemId, target: PartyMemberId) => void;
  onAcceptRecontract: () => void;
  onBack: () => void;
  onOpenStats: () => void;
  onOpenOrder: () => void;
  onAccept: () => void;
  onAcceptAmendment: (amendmentId: string) => void;
  onStart: () => void;
  onRetry: () => void;
  onRecover: () => void;
  onDeliverEvidence: (stepId: string, note: string, link: string, files: PendingFile[]) => void;
}) {
  /*
    LA BATTLE QUE SE PINTA ES LA QUE EL CORE DECLARA.

    Antes esta pantalla leía `currentQuest`, la proyección legada. Con un frente
    en pausa dentro de la campaña en foco, esa proyección lo volvía a elegir en
    cada poll y la pantalla mostraba una batalla que el jugador había dejado.
  */
  const quest = snapshot.battleQuest ?? snapshot.currentQuest;
  const [openStepId, setOpenStepId] = useState<string | null>(quest?.steps[0]?.id ?? null);
  const [evidenceNote, setEvidenceNote] = useState("");
  const [evidenceLink, setEvidenceLink] = useState("");
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [ordersOpen, setOrdersOpen] = useState(quest?.status !== "active");
  const [bagOpen, setBagOpen] = useState(false);
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
  // La vida agregada de la Horda ya no se dibuja: cada enemigo trae la suya.
  const playerHealth = battle?.playerHealth ?? 100;
  // El estado que decide qué rutas existen. Lo dice el Core, no la pantalla.
  const marquisDown = battle?.party.marques.health === 0;
  const reviveTonics = snapshot.inventory?.items.find((entry) => entry.itemId === "revive_tonic")?.quantity ?? 0;
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
  /*
    LA HORDA TAMBIÉN TIENE SU CUADRÍCULA.

    Cuatro enemigos, cuatro casillas: los de vanguardia en la columna que da
    hacia nosotros y los de retaguardia detrás. Una casilla se apaga cuando SU
    enemigo cae, así que el plano no es adorno: dice quién sigue en pie.
  */
  const HORDE_CELLS = [
    { col: 0, row: 0 },
    { col: 0, row: 1 },
    { col: 1, row: 0 },
    { col: 1, row: 1 },
  ];
  const hordeOrder = [...(battle?.enemies ?? [])].sort(
    (a, b) => (a.position === "front" ? 0 : 1) - (b.position === "front" ? 0 : 1),
  );
  const fallenHordeCells = hordeOrder
    .map((enemy, index) => (enemy.status === "ko" && HORDE_CELLS[index] ? `${HORDE_CELLS[index].col},${HORDE_CELLS[index].row}` : null))
    .filter((cell): cell is string => cell !== null);
  return (
    <main className={`scene battle-scene ${impact ? "impact" : ""} ${incomingDamage ? "player-hit" : ""}`}>
      {/*
        DOS CUADRÍCULAS INDEPENDIENTES DE 2×2, enfrentadas a través del valle:
        una del grupo y otra de la Horda. No es un tablero único: cada bando
        tiene la suya, y se inclinan en sentidos opuestos porque se miran.

        Los vértices están calcados del trazo del mockup, y las casillas se
        interpolan entre ellos, así que las piezas se plantan exactamente sobre
        el suelo que el arte tiene pintado.
      */}
      <div className="battle-stage">
        <img className="battle-art" src="/assets/art/battle-realm.png" alt="El ejército de la Marca combate a la Horda" />
        {battle ? (
          <>
            <BattleGrid quad={ALLY_QUAD} className="ally-grid" />
            <BattleGrid quad={HORDE_QUAD} className="horde-grid" fallen={fallenHordeCells} />
            {(["cordera", "marques", "roku"] as const).map((id) => {
              const member = battle.party[id === "roku" ? "roko" : id];
              const cell = ALLY_CELLS[id];
              const spot = cellCenter(ALLY_QUAD, cell.col, cell.row);
              return (
                <PartySprite
                  key={id}
                  id={id}
                  decorative
                  ko={member.status === "ko"}
                  heroHeight={`calc(var(--stage-h) * ${BATTLE_HERO_HEIGHT / 100})`}
                  className="stage-piece"
                  style={{ left: `${spot.left}%`, top: `${spot.top}%`, zIndex: Math.round(spot.top) }}
                />
              );
            })}
            {/* El cuarto slot sólo se ocupa si un compañero real ejecutó algo. */}
            {battle.agent.deployed ? (
              <span
                className="stage-agent"
                style={{
                  left: `${cellCenter(ALLY_QUAD, ALLY_CELLS.agent.col, ALLY_CELLS.agent.row).left}%`,
                  top: `${cellCenter(ALLY_QUAD, ALLY_CELLS.agent.col, ALLY_CELLS.agent.row).top}%`,
                  zIndex: Math.round(cellCenter(ALLY_QUAD, ALLY_CELLS.agent.col, ALLY_CELLS.agent.row).top),
                }}
              >
                <b>{(battle.agent.name ?? "AGENTE").toUpperCase()}</b>
              </span>
            ) : null}
          </>
        ) : null}
      </div>
      {/*
        LA CABECERA ES TODO EL ESTADO QUE HACE FALTA.

        Antes había además una barra de la Horda y otra del Marqués sobre el
        campo. Ya no significan nada: cada enemigo trae su propia vida en su
        cuadro y cada miembro del grupo la suya. Dos barras agregadas encima del
        escenario sólo tapaban la batalla para repetir lo que ya estaba dicho.
      */}
      <header className="battle-header">
        <button className="back" type="button" onClick={onBack} aria-label="Volver">‹</button>
        <div>
          <p className="eyebrow">{quest.campaignTitle}</p>
          <h1>{quest.title}</h1>
        </div>
        <span className="battle-state">
          {battle
            ? battle.status === "awaiting_recovery"
              ? "SIN MARQUÉS"
              : battle.status === "awaiting_replan"
                ? "PLAZO VENCIDO"
                : battle.status === "won"
                  ? "GANADA"
                  : battle.clock?.suspended
                    ? "SUSPENDIDA"
                    : "EN CURSO"
            : "SIN INICIAR"}
          {battle ? ` · ${battle.attempt}` : ""}
        </span>
        <button className="flat-button" type="button" onClick={onOpenStats}>PERSONAJE</button>
      </header>

      {battle?.clock ? <BattleTimer clock={battle.clock} status={battle.status} receivedAt={receivedAt} /> : null}

      {/*
        CUATRO CUADROS ABAJO A LA IZQUIERDA, CUATRO ABAJO A LA DERECHA.

        El grupo y la Horda enmarcan el campo por sus esquinas inferiores en vez
        de flotar sobre él: la ventana de la batalla queda libre, que es lo que
        el jugador está mirando.
      */}
      {battle ? (
        <PartyHud
          party={battle.party}
          agent={battle.agent}
          flash={partyFlash}
          heroes={snapshot.barracks?.heroes ?? []}
          onUseItem={(target) => {
            setBagOpen(true);
            void target;
          }}
        />
      ) : null}
      {battle ? <EnemyRow enemies={battle.enemies} /> : null}

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
      {/*
        EL FRENTE SIGUE ABIERTO.
        El plazo venció o el Marqués cayó, pero nada se borró: progreso, Horda,
        heridas, caídos e inventario siguen exactamente como quedaron. Lo único
        que hay que repactar es el tiempo —y levantar a quien esté en el suelo.
      */}
      {battle && ["awaiting_replan", "awaiting_recovery"].includes(battle.status) ? (
        <div className="battle-defeat" role="alertdialog" aria-label="El frente sigue abierto">
          <article>
            <p className="eyebrow">{battle.status === "awaiting_recovery" ? "EL MARQUÉS CAYÓ" : "EL FRENTE SIGUE ABIERTO"}</p>
            <h2>{battle.status === "awaiting_recovery" ? "Hay que levantarlo antes de volver" : "El tiempo pactado terminó"}</h2>
            <p>
              Progreso: <b>{battle.progress}/100</b> · Horda: <b>{battle.enemyHealth}/100</b> · Intento <b>{battle.attempt}</b>
            </p>
            <ul className="defeat-party">
              {(["roko", "marques", "cordera"] as const).map((id) => (
                <li key={id} className={`is-${battle.party[id].status}`}>
                  <span>{battle.party[id].name}</span>
                  <b>{battle.party[id].health === 0 ? "KO" : `${battle.party[id].health} HP`}</b>
                </li>
              ))}
            </ul>
            <p className="defeat-bag">
              {(snapshot.inventory?.items ?? []).filter((entry) => entry.quantity > 0).map((entry) => `${ITEM_NAMES[entry.itemId]} ×${entry.quantity}`).join(" · ") || "Zurrón vacío"}
            </p>
            {/*
              LAS RUTAS LEGALES, DICHAS EN VOZ ALTA.

              REPLANIFICAR ya no se apaga en silencio con el Marqués en el suelo:
              antes quedaba gris con una línea de letra pequeña debajo, y desde
              el teléfono eso se leía exactamente igual que un botón roto. Ahora
              cada estado nombra su salida, y las que no aplican no se dibujan.
            */}
            {marquisDown ? (
              <p className="defeat-block">
                🔒 REPLANIFICAR NO ES RESUCITAR. El Marqués está en el suelo: repactar el tiempo no lo levanta, así que primero
                hay que sacarlo de ahí.
              </p>
            ) : null}
            <div className="defeat-actions">
              <button className="ghost-button" type="button" onClick={() => setBagOpen(true)}>
                {reviveTonics > 0 && marquisDown ? `USAR TÓNICO · ${reviveTonics}` : "USAR OBJETO"}
              </button>
              {marquisDown ? (
                <button className="gold-button" type="button" disabled={busy || !recovery.available} onClick={onRecover}>
                  🛡️ RETIRARSE A BARRACAS · {recovery.minHealth} HP
                </button>
              ) : (
                <button className="gold-button" type="button" disabled={busy} onClick={onRetry}>
                  REPLANIFICAR
                </button>
              )}
              <button className="back-button" type="button" onClick={onBack}>VOLVER AL REINO</button>
            </div>
            {marquisDown ? (
              <small>
                {recovery.available
                  ? `La retirada cierra este intento y devuelve a los caídos con ${recovery.minHealth} HP. No devuelve objetos gastados, no cura a la Horda y no borra nada de lo ya validado.`
                  : recovery.reason ?? "La retirada táctica no está disponible ahora."}
              </small>
            ) : (
              <small>Replanificar repacta el tiempo. Las heridas, la Horda y el progreso siguen exactamente como están.</small>
            )}
          </article>
        </div>
      ) : null}

      {/*
        EL ZURRÓN SE DIBUJA AL FINAL, Y ENCIMA.

        Aquí vivía el bug de «Usar objeto no abre nada»: el cajón se pintaba
        ANTES del modal de derrota y con su mismo z-index, así que el modal —que
        cubre la pantalla entera con un velo opaco— se lo comía. El panel se
        abría de verdad; simplemente no había forma de verlo.
      */}
      {bagOpen && battle ? (
        <InventoryDrawer
          inventory={snapshot.inventory ?? { items: [] }}
          party={battle.party}
          busy={busy}
          onClose={() => setBagOpen(false)}
          onUse={(itemId, target) => {
            onUseItem(itemId, target);
            setBagOpen(false);
          }}
        />
      ) : null}

      {/* Un nuevo pacto temporal se acepta, no se impone. */}
      {battle?.pendingRecontract ? (
        <div className="battle-defeat" role="alertdialog" aria-label="Nuevo pacto temporal">
          <article>
            <p className="eyebrow">LA REALIDAD CAMBIÓ</p>
            <h2>Nuevo tiempo: {battle.pendingRecontract.newDurationMinutes} min</h2>
            <p>{battle.pendingRecontract.reason}</p>
            <div className="defeat-actions">
              <button className="gold-button" type="button" disabled={busy} onClick={onAcceptRecontract}>ACEPTAR PACTO</button>
              <button className="back-button" type="button" onClick={onBack}>MÁS TARDE</button>
            </div>
            <small>No es una derrota: el frente se conserva tal como está.</small>
          </article>
        </div>
      ) : null}

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
            {ordersOpen ? "CERRAR ÓRDENES" : `ÓRDENES ${battle?.completedSteps ?? 0}/${quest.steps.length}`}
          </button>
        ) : null}

        {/* Un solo CTA principal, y dice exactamente qué toca ahora. */}
        <div className="contract-actions">
          {quest.status === "draft" ? <button className="gold-button" disabled={busy} onClick={onAccept}>ACEPTAR</button> : null}
          {quest.status === "accepted" ? <button className="gold-button" disabled={busy} onClick={onStart}>INICIAR</button> : null}
          {quest.status === "active" && currentStep && battle?.status === "active" ? (
            <button className="gold-button" type="button" onClick={focusCurrentStep}>
              {currentStep.evidenceKind === "photo" ? "FOTO" : "EVIDENCIA"}
            </button>
          ) : null}
          {quest.status === "waiting_external" ? <button className="gold-button" type="button" disabled>SIN ACCIÓN</button> : null}
          {quest.status === "completed" ? <button className="gold-button" onClick={onBack}>AL REINO</button> : null}
          {/* El zurrón deja de flotar sobre el campo: es una acción más. */}
          {battle ? (
            <button className="flat-button bag-button" type="button" onClick={() => setBagOpen((open) => !open)}>
              ZURRÓN {snapshot.inventory?.items.reduce((sum, entry) => sum + entry.quantity, 0) ?? 0}
            </button>
          ) : null}
          <button className="flat-button" type="button" onClick={onOpenOrder}>VER ORDEN</button>
        </div>
        {quest.status === "active" && currentStep ? <small className="contract-step">PASO ACTUAL · {currentStep.title}</small> : null}
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
                    {quest.status === "active" && battle?.status === "active" && !["completed", "blocked", "superseded"].includes(step.status) ? (
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
  /*
    LAS ACCIONES DE BATTLE SE DIRIGEN AL FRENTE QUE SE ESTÁ PINTANDO.

    Aquí vivía el bug de «Replanificar no hace nada». La pantalla de Battle
    dibuja `snapshot.battleQuest` —la autoridad del Core—, pero TODOS los
    manejadores se ataban a `snapshot.currentQuest`, la proyección legada. Con
    las dos apuntando a Quests distintas, `quest && ...` o bien no ejecutaba
    nada, o bien mandaba la orden al frente equivocado. En ambos casos el
    jugador tocaba un botón y no ocurría absolutamente nada visible.
  */
  const battleQuest = snapshot.battleQuest ?? snapshot.currentQuest;
  const battleQuestId = snapshot.battleQuestId ?? battleQuest?.id ?? null;
  const recovery = snapshot.recovery ?? {
    questId: battleQuestId,
    available: false,
    minHealth: 25,
    reason: "Este servidor todavía no ofrece la retirada táctica.",
  };
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
   * ELIMINAR.
   *
   * La pantalla no decide si eso es borrar o abandonar: eso depende de si la
   * misión tiene historia, y sólo el Core lo sabe. Aquí sólo se pide, y si el
   * jugador estaba mirando esa Quest se le devuelve a la lista en vez de
   * dejarlo frente a una entidad que ya no existe.
   */
  const discardQuest = (questId: string) => {
    void act(() =>
      api(`/api/quests/${questId}/discard`, { method: "POST", body: JSON.stringify({ reason: "Descartada por el jugador." }) }),
    ).then(() => {
      setNotice(null);
      if (openQuestId === questId) {
        setOpenQuestId(null);
        setScreen("battles");
      }
    });
  };

  /**
   * ENTRAR A UNA BATTLE ES MIRARLA.
   *
   * `focus_quest` es navegación pura —no acepta, no inicia, no cambia nada del
   * contrato— y es lo que le dice al Core qué frente proyectar. Así la pantalla
   * y el servidor derivan de la MISMA autoridad, y no hay ningún instante en el
   * que el Realm diga una Quest y la pantalla pinte otra.
   */
  const openBattle = (questId: string) => {
    if (snapshot?.battleQuestId === questId) {
      setScreen("battle");
      return;
    }
    /*
      ONE ENGAGED BATTLE — Y SE DICE, NO SE DISIMULA.

      Con otro frente sosteniendo el reloj, el Core seguirá proyectando ESA
      Battle por mucho que enfoquemos ésta. Pintar la pantalla de Battle
      entonces mostraría una batalla distinta de la que el jugador pidió abrir,
      que es una forma silenciosa de mentir. Se abre su Orden de Misión, que
      dice con todas las letras de quién es el reloj.
    */
    const engagedId = snapshot?.hierarchy?.engagedQuestId ?? null;
    if (engagedId && engagedId !== questId) {
      openOrder(questId);
      return;
    }
    void act(() => api(`/api/quests/${questId}/focus`, { method: "POST" })).then(() => setScreen("battle"));
  };

  /**
   * DEEP LINK EXACTO.
   *
   * La notificación trae `deepLink.screen` + `entityId`. Se abre esa entidad por
   * id; nunca se resuelve por título. Abrir NO acepta y NO inicia nada.
   */
  const deepLinkTo = (link: NotificationView["deepLink"]) => {
    if (link.screen === "treasury") {
      setScreen("treasury");
      return;
    }
    if (link.screen === "campaign") {
      setOpenCampaignId(link.entityId);
      setOpenActId(null);
      setScreen("campaign");
      return;
    }
    if (link.screen === "act") {
      setOpenActId(link.entityId);
      setScreen("act");
      return;
    }
    // El aviso trae la entidad exacta: se enfoca esa Quest y se abre SU Battle.
    if (link.screen === "battle") {
      openBattle(link.entityId);
      return;
    }
    openOrder(link.entityId);
  };

  const openNotification = (notice: NotificationView) => {
    void act(() => api(`/api/notifications/${notice.id}/read`, { method: "POST" })).then(() => deepLinkTo(notice.deepLink));
  };

  /**
   * Abre exactamente la entidad del aviso.
   *
   * Nada de heurísticas: el hecho trae `entityType` y `entityId`, y eso es lo
   * que se abre. Dos borradores seguidos ya no se pisan.
   */
  const openNotice = (notice: RealmNotice) => {
    setNotice(null);
    if (notice.kind === "levelup") {
      setScreen("barracks");
      return;
    }
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
    // Un frente ya abierto se abre en su Battle; un borrador, en su Orden.
    const target = questNodeOf(snapshot, notice.entityId);
    if (target && ["active", "waiting_external", "completed"].includes(target.status)) {
      openBattle(target.id);
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
          onStats={() => setScreen("stats")}
          onNotifications={() => setScreen("notifications")}
          onTreasury={() => setScreen("treasury")}
          onBarracks={() => setScreen("barracks")}
          onBattles={() => setScreen("battles")}
          onOpenBattle={openBattle}
        />
        {composerOpen ? (
          <QuestComposer
            busy={busy}
            onClose={() => setComposerOpen(false)}
            onSubmit={(intent) => {
              setPendingIntent(intent);
              setScreen("thinking");
              // Un borrador recién trazado necesita SELLO, no un campo de
              // batalla: se abre su Orden de Misión, que es donde se acepta.
              void act(async () => {
                const created = await api<{ quest: { id: string } }>("/api/quests/from-intent", {
                  method: "POST",
                  body: JSON.stringify({ intent }),
                });
                setComposerOpen(false);
                setNotice(null);
                window.setTimeout(() => openOrder(created.quest.id), 420);
                return created;
              });
            }}
          />
        ) : null}
        </>
      ) : screen === "stats" ? (
        <CharacterSheet snapshot={snapshot} onBack={() => setScreen(quest ? "battle" : "realm")} />
      ) : screen === "notifications" ? (
        <NotificationCenter
          notifications={snapshot.notifications ?? []}
          busy={busy}
          onBack={() => setScreen("realm")}
          onOpen={openNotification}
          onArchive={(id) => void act(() => api(`/api/notifications/${id}/archive`, { method: "POST" }))}
          onResend={(id) => void act(() => api(`/api/notifications/${id}/resend`, { method: "POST" }))}
        />
      ) : screen === "battles" ? (
        <BattlesScreen
          openFronts={snapshot.openFronts ?? fallbackOpenFronts(snapshot)}
          quickBattles={(snapshot.hierarchy.standaloneQuests ?? []).filter(
            (node) => !["completed", "abandoned"].includes(node.status),
          )}
          busy={busy}
          onBack={() => setScreen("realm")}
          onOpenBattle={openBattle}
          onOpenOrder={openOrder}
          onDiscard={discardQuest}
        />
      ) : screen === "barracks" ? (
        <BarracksScreen
          barracks={snapshot.barracks ?? { heroes: [], lastFormation: null }}
          onBack={() => setScreen("realm")}
        />
      ) : screen === "treasury" ? (
        <TreasuryScreen
          treasury={snapshot.treasury ?? fallbackTreasury(snapshot)}
          currency={snapshot.realm.financial.currency}
          onBack={() => setScreen("realm")}
        />
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
          onEnterBattle={(questId) => openBattle(questId)}
          onOpenStats={() => setScreen("stats")}
          onDiscard={discardQuest}
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
          recovery={recovery}
          onUseItem={(itemId, target) =>
            // El frente se NOMBRA: con dos Battles esperando auxilio, dejar que
            // el servidor adivine gastaba el Tónico en la que no era.
            void act(() =>
              api("/api/inventory/use", { method: "POST", body: JSON.stringify({ itemId, target, questId: battleQuestId }) }),
            )
          }
          onAcceptRecontract={() =>
            battleQuestId &&
            void act(() => api(`/api/quests/${battleQuestId}/battle/recontract/accept`, { method: "POST", body: JSON.stringify({ userAccepted: true }) }))
          }
          onBack={() => setScreen(currentCampaign ? "campaign" : "realm")}
          onOpenStats={() => setScreen("stats")}
          onOpenOrder={() => battleQuestId && openOrder(battleQuestId)}
          onAccept={() => battleQuestId && void act(() => api(`/api/quests/${battleQuestId}/accept`, { method: "POST", body: JSON.stringify({ userAccepted: true }) }))}
          onAcceptAmendment={(amendmentId) => battleQuestId && void act(() => api(`/api/quests/${battleQuestId}/amendments/${amendmentId}/accept`, { method: "POST", body: JSON.stringify({ userAccepted: true }) }))}
          onStart={() => battleQuestId && void act(() => api(`/api/quests/${battleQuestId}/start`, { method: "POST" })).then(() => setNotice(null))}
          onRetry={() => battleQuestId && void act(() => api(`/api/quests/${battleQuestId}/battle/retry`, { method: "POST" }))}
          onRecover={() => battleQuestId && void act(() => api(`/api/quests/${battleQuestId}/battle/recover`, { method: "POST" }))}
          onDeliverEvidence={(stepId, note, link, files) => {
            if (!battleQuestId) return;
            void act(async () => {
              for (const file of files) {
                await api(`/api/quests/${battleQuestId}/steps/${stepId}/artifacts`, {
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
                await api(`/api/quests/${battleQuestId}/steps/${stepId}/artifacts`, {
                  method: "POST",
                  body: JSON.stringify({ kind: "link", url: link.trim() }),
                });
              }
              // El veredicto lo emite Códice en el servidor; la APK nunca se
              // concede daño a sí misma.
              const result = await api<{ judgement: { verdict: string; reasoning: string } }>(
                `/api/quests/${battleQuestId}/steps/${stepId}/verify`,
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
