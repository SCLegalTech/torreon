import type { Quest, RealmSnapshot } from "./types";

const storageKey = "torreon.realm.v1";

const makeId = () => crypto.randomUUID();

function freshSnapshot(): RealmSnapshot {
  return {
    realm: {
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
      lifeEvents: [],
      gameEvents: [],
    },
    currentQuest: null,
    battle: null,
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
    steps: steps.map(([title, description, actor, evidence, weight]) => ({
      id: makeId(), title, description, actor, evidence, weight, status: "pending", impactAwarded: 0, evidenceIds: [],
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
      enemyHealth: Math.max(0, 100 - progress),
      progress,
      completedSteps: completed.length,
      totalSteps: quest.steps.length,
      isKo: progress === 100,
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

  throw new Error(`Operación local no soportada: ${method} ${path}`);
}
