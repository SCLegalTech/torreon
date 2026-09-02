import type { Quest, RealmSnapshot } from "./types";

const storageKey = "torreon.realm.v1";

const makeId = () => crypto.randomUUID();

function freshSnapshot(): RealmSnapshot {
  const realmId = makeId();
  return {
    realm: {
      realmId,
      player: { displayName: "Marqués Phi", title: "Guardián de la Marca" },
      financial: {
        currency: "COP",
        availableBalance: 400000,
        expectedIncome: 2400000,
        committedExpenses: 2100000,
        reserveTarget: 500000,
      },
      events: [],
      evidence: [],
      artifacts: [],
      lifeEvents: [],
      gameEvents: [],
    },
    currentQuest: null,
    battle: null,
    consistency: { status: "warning", instance: "torreon-offline", realmId, currentQuestId: null },
    projectedMargin: 200000,
  };
}

function read(): RealmSnapshot {
  const stored = localStorage.getItem(storageKey);
  if (!stored) return freshSnapshot();
  try {
    return JSON.parse(stored) as RealmSnapshot;
  } catch {
    return freshSnapshot();
  }
}

function write(snapshot: RealmSnapshot): RealmSnapshot {
  localStorage.setItem(storageKey, JSON.stringify(snapshot));
  return snapshot;
}

function demoQuest(): Quest {
  const steps = [
    ["Definir la guardia", "Confirmar salario, horario y modalidad aceptables.", "shared", "Criterios registrados", 10],
    ["Revelar las puertas", "Localizar cinco vacantes compatibles.", "codex", "Cinco enlaces vigentes", 15],
    ["Templar el acero", "Adaptar la hoja de vida a las vacantes.", "shared", "Versión final del CV", 20],
    ["Preparar estandartes", "Redactar mensajes y respuestas.", "shared", "Textos revisados", 15],
    ["Cruzar las puertas", "Enviar las cinco candidaturas.", "user", "Confirmaciones de envío", 40],
  ] as const;
  return {
    id: makeId(),
    campaignTitle: "SEGUNDO ESTANDARTE",
    title: "Cinco puertas",
    intent: "Avanzar hacia un segundo trabajo compatible con mi perfil y bienestar.",
    outcome: "Enviar cinco candidaturas verificables a vacantes de alta compatibilidad.",
    rationale: "Convierte una intención amplia en un resultado comprobable.",
    durationMinutes: 60,
    wellbeingConstraints: ["Preferencia remota o híbrida", "Horario compatible"],
    allowedApps: ["Gmail", "Drive", "LinkedIn", "Navegador"],
    status: "draft",
    version: 1,
    amendments: [],
    steps: steps.map(([title, description, actor, evidence, weight]) => ({
      id: makeId(), title, description, actor, evidence, weight, status: "pending", impactAwarded: 0, evidenceIds: [], artifactIds: [],
    })),
  };
}

function withBattle(snapshot: RealmSnapshot): RealmSnapshot {
  const quest = snapshot.currentQuest;
  if (!quest) return { ...snapshot, battle: null };
  const completed = quest.steps.filter((step) => step.status === "completed");
  const progress = quest.steps.reduce((sum, step) => sum + step.impactAwarded, 0);
  return {
    ...snapshot,
    battle: {
      questId: quest.id,
      player: { id: "marques-phi", health: 100, maxHealth: 100 },
      enemy: { id: "horda", health: Math.max(0, 100 - progress), maxHealth: 100 },
      playerHealth: 100,
      playerMaxHealth: 100,
      enemyMaxHealth: 100,
      enemyHealth: Math.max(0, 100 - progress),
      progress,
      completedSteps: completed.length,
      totalSteps: quest.steps.length,
      isKo: progress === 100,
      isPlayerKo: false,
    },
  };
}

function questFrom(snapshot: RealmSnapshot, questId: string): Quest {
  if (!snapshot.currentQuest || snapshot.currentQuest.id !== questId) throw new Error("Quest no encontrada.");
  return snapshot.currentQuest;
}

export async function mobileApi<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method ?? "GET";
  let snapshot = read();

  if (path === "/api/state" && method === "GET") return withBattle(snapshot) as T;
  if (path === "/api/reset" && method === "POST") return write(freshSnapshot()) as T;
  if (path === "/api/demo/quest" && method === "POST") {
    snapshot = withBattle({ ...snapshot, currentQuest: demoQuest() });
    return write(snapshot) as T;
  }

  const accept = path.match(/^\/api\/quests\/([^/]+)\/accept$/);
  if (accept && method === "POST") {
    const quest = questFrom(snapshot, accept[1]);
    snapshot = withBattle({ ...snapshot, currentQuest: { ...quest, status: "accepted" } });
    write(snapshot);
    return snapshot.currentQuest as T;
  }

  const start = path.match(/^\/api\/quests\/([^/]+)\/start$/);
  if (start && method === "POST") {
    const quest = questFrom(snapshot, start[1]);
    snapshot = withBattle({ ...snapshot, currentQuest: { ...quest, status: "active" } });
    write(snapshot);
    return snapshot.currentQuest as T;
  }

  const complete = path.match(/^\/api\/quests\/([^/]+)\/steps\/([^/]+)\/complete$/);
  if (complete && method === "POST") {
    const quest = questFrom(snapshot, complete[1]);
    const body = JSON.parse(String(init?.body ?? "{}")) as { evidenceNote?: string };
    if (!body.evidenceNote?.trim()) throw new Error("La evidencia es obligatoria.");
    const steps = quest.steps.map((step) => step.id === complete[2]
      ? { ...step, status: "completed" as const, evidenceNote: body.evidenceNote?.trim(), impactAwarded: step.weight }
      : step);
    const progress = steps.filter((step) => step.status === "completed").reduce((sum, step) => sum + step.weight, 0);
    snapshot = withBattle({ ...snapshot, currentQuest: { ...quest, steps, status: progress === 100 ? "completed" : "active" } });
    write(snapshot);
    return { quest: snapshot.currentQuest, battle: snapshot.battle } as T;
  }

  const artifacts = path.match(/^\/api\/quests\/([^/]+)\/steps\/([^/]+)\/artifacts$/);
  if (artifacts && method === "POST") {
    const quest = questFrom(snapshot, artifacts[1]);
    const body = JSON.parse(String(init?.body ?? "{}")) as { kind?: "file" | "link" | "text"; url?: string; text?: string; label?: string };
    const artifact = {
      id: makeId(),
      stepId: artifacts[2],
      stepIds: [artifacts[2]],
      kind: body.kind ?? "text",
      label: body.label ?? body.url ?? "Texto declarado",
      verification: {
        verified: false,
        detail: "Modo sin conexión: el teléfono registra el artefacto, pero solo el servidor puede comprobarlo.",
      },
    };
    const steps = quest.steps.map((step) =>
      step.id === artifacts[2] ? { ...step, artifactIds: [...step.artifactIds, artifact.id] } : step,
    );
    snapshot = withBattle({
      ...snapshot,
      realm: { ...snapshot.realm, artifacts: [artifact, ...snapshot.realm.artifacts] },
      currentQuest: { ...quest, steps },
    });
    write(snapshot);
    return { artifact } as T;
  }

  const verify = path.match(/^\/api\/quests\/([^/]+)\/steps\/([^/]+)\/verify$/);
  if (verify && method === "POST") {
    const quest = questFrom(snapshot, verify[1]);
    const body = JSON.parse(String(init?.body ?? "{}")) as { note?: string };
    const step = quest.steps.find((candidate) => candidate.id === verify[2]);
    if (!step) throw new Error("Paso no encontrado.");
    const remaining = step.weight - step.impactAwarded;
    const note = (body.note ?? "").trim();
    const half = Math.max(1, Math.floor(remaining / 2));
    // Sin servidor no hay comprobación posible: el teléfono nunca concede el
    // impacto completo por su cuenta.
    const grant = note.length >= 12 && half < remaining ? half : 0;
    const judgement = {
      verdict: grant > 0 ? ("partial" as const) : ("rejected" as const),
      impactAwarded: grant,
      reasoning:
        grant > 0
          ? "Modo sin conexión: Códice registra la declaración como avance parcial. Conecta el servidor para que la prueba pueda comprobarse."
          : "Modo sin conexión: hace falta una declaración más concreta o la conexión con el servidor para comprobar la prueba.",
    };
    const steps = quest.steps.map((candidate) =>
      candidate.id === step.id
        ? {
            ...candidate,
            impactAwarded: candidate.impactAwarded + grant,
            evidenceNote: note || candidate.evidenceNote,
            status: (candidate.impactAwarded + grant >= candidate.weight ? "completed" : grant > 0 ? "in_progress" : candidate.status) as Quest["steps"][number]["status"],
          }
        : candidate,
    );
    const progress = steps.reduce((sum, candidate) => sum + candidate.impactAwarded, 0);
    snapshot = withBattle({
      ...snapshot,
      realm: {
        ...snapshot.realm,
        evidence: [
          { id: makeId(), stepId: step.id, verdict: judgement.verdict, impactAwarded: grant, reasoning: judgement.reasoning, artifactIds: [] },
          ...snapshot.realm.evidence,
        ],
      },
      currentQuest: { ...quest, steps, status: progress === 100 ? "completed" : quest.status },
    });
    write(snapshot);
    return { quest: snapshot.currentQuest, battle: snapshot.battle, judgement, artifacts: [] } as T;
  }

  throw new Error(`Operación local no soportada: ${method} ${path}`);
}
