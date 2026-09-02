import type { EvidenceVerdict, Quest, QuestPlanInput, QuestStep, QuestStepInput } from "./domain.js";
import type { EvidenceArtifact } from "./domain.js";

/**
 * Códice es el Dungeon Master. No es una plantilla ni un prompt suelto:
 * es un contrato que cualquier runtime puede cumplir.
 *
 *   - CodicePlanner.plan  : intención libre  -> contrato de quest jugable
 *   - CodicePlanner.judge : evidencia real   -> veredicto e impacto
 *
 * Hay dos runtimes que cumplen el mismo contrato:
 *   - AnthropicCodice: el modelo razona dentro del servidor (el juego solo).
 *   - HeuristicCodice: sin modelo disponible; plantillas y reglas verificables.
 *
 * Cuando el jugador habla con Codex o Claude por MCP, el modelo del cliente
 * cumple el mismo contrato desde fuera llamando a las herramientas.
 */

export interface PlanRequest {
  intent: string;
  playerTitle?: string;
  activeCampaign?: string;
  minutesAvailable?: number;
}

export interface JudgeRequest {
  quest: Quest;
  step: QuestStep;
  remainingImpact: number;
  note: string;
  artifacts: EvidenceArtifact[];
}

export interface Judgement {
  verdict: EvidenceVerdict;
  impactAwarded: number;
  reasoning: string;
}

export interface CodicePlanner {
  readonly name: string;
  plan(request: PlanRequest): Promise<QuestPlanInput>;
  judge(request: JudgeRequest): Promise<Judgement>;
}

// ---------------------------------------------------------------------------
// Contrato compartido por todos los runtimes
// ---------------------------------------------------------------------------

export const CODICE_INSTRUCTIONS = [
  "Eres el Códice de la Marca: el Dungeon Master de Torreón. Tu trabajo es convertir CUALQUIER propósito real —de cualquier dominio— en un contrato jugable y verificable.",
  "",
  "Reglas del contrato:",
  "1. El resultado (outcome) describe el mundo real después de la misión, no la actividad. Debe poder comprobarse por alguien que no estuvo presente.",
  "2. Descompón en 3 a 8 pasos. Cada paso avanza el resultado; ninguno premia solamente ocupación, tiempo o clics.",
  "3. Cada paso declara quién lo ejecuta: user, codex (el agente puede hacerlo) o shared.",
  "4. Cada paso declara la evidencia concreta que lo demuestra y de qué tipo es (file, link, screenshot, photo, number, text, declaration). Usa photo cuando una foto tomada en el mundo físico sea la prueba natural. Prefiere artefactos verificables sobre declaraciones.",
  "5. verificationHint indica qué debe comprobar el Códice en esa evidencia (por ejemplo: «el archivo es un PDF y contiene el nombre del candidato», «la lista tiene 5 URLs distintas»).",
  "6. importance (1 a 10) marca el peso de batalla relativo. Reserva la mayor importancia para los pasos que PRODUCEN el resultado, no para la preparación.",
  "7. epic narra el paso como escena de fantasía medieval; real dice literalmente qué hacer en la vida real. Nunca uses la épica para esconder la instrucción real.",
  "8. No inventes hechos del jugador: ni vacantes, ni saldos, ni documentos, ni contactos. Si falta un dato, conviértelo en un paso que lo consiga.",
  "9. Respeta el bienestar: alcance pequeño, duración realista, sin culpabilizar.",
].join("\n");

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    campaignTitle: { type: "string", description: "Campaña real a la que pertenece la quest." },
    title: { type: "string", description: "Nombre épico y breve de la quest." },
    outcome: { type: "string", description: "Resultado verificable en el mundo real." },
    rationale: { type: "string", description: "Por qué esta descomposición produce el resultado." },
    durationMinutes: { type: "integer", minimum: 5, maximum: 240 },
    wellbeingConstraints: { type: "array", items: { type: "string" }, maxItems: 5 },
    allowedApps: { type: "array", items: { type: "string" }, maxItems: 8 },
    steps: {
      type: "array",
      minItems: 3,
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          epic: { type: "string" },
          real: { type: "string" },
          actor: { type: "string", enum: ["user", "codex", "shared"] },
          evidence: { type: "string" },
          evidenceKind: { type: "string", enum: ["file", "link", "screenshot", "photo", "number", "text", "declaration"] },
          verificationHint: { type: "string" },
          importance: { type: "integer", minimum: 1, maximum: 10 },
        },
        required: ["title", "epic", "real", "actor", "evidence", "evidenceKind", "verificationHint", "importance"],
        additionalProperties: false,
      },
    },
  },
  required: ["campaignTitle", "title", "outcome", "rationale", "durationMinutes", "wellbeingConstraints", "allowedApps", "steps"],
  additionalProperties: false,
} as const;

const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["rejected", "partial", "accepted"] },
    impactAwarded: { type: "integer", minimum: 0 },
    reasoning: { type: "string" },
  },
  required: ["verdict", "impactAwarded", "reasoning"],
  additionalProperties: false,
} as const;

interface RawStep {
  title: string;
  epic: string;
  real: string;
  actor: "user" | "codex" | "shared";
  evidence: string;
  evidenceKind: QuestStepInput["evidenceKind"];
  verificationHint: string;
  importance: number;
}

interface RawPlan {
  campaignTitle: string;
  title: string;
  outcome: string;
  rationale: string;
  durationMinutes: number;
  wellbeingConstraints: string[];
  allowedApps: string[];
  steps: RawStep[];
}

/**
 * Los modelos son malos sumando exactamente 100. Piden importancia relativa y
 * el servidor reparte los 100 puntos de daño con el método del mayor resto.
 */
export function distributeWeights(importances: number[]): number[] {
  const safe = importances.map((value) => (Number.isFinite(value) && value > 0 ? value : 1));
  const total = safe.reduce((sum, value) => sum + value, 0);
  const exact = safe.map((value) => (value / total) * 100);
  const floors = exact.map((value) => Math.max(1, Math.floor(value)));
  let remainder = 100 - floors.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);
  let cursor = 0;
  while (remainder > 0) {
    floors[order[cursor % order.length].index] += 1;
    remainder -= 1;
    cursor += 1;
  }
  while (remainder < 0) {
    const candidate = order[cursor % order.length].index;
    if (floors[candidate] > 1) {
      floors[candidate] -= 1;
      remainder += 1;
    }
    cursor += 1;
  }
  return floors;
}

export function planFromRaw(raw: RawPlan, intent: string): QuestPlanInput {
  const weights = distributeWeights(raw.steps.map((step) => step.importance));
  return {
    campaignTitle: raw.campaignTitle.trim(),
    title: raw.title.trim(),
    intent: intent.trim(),
    outcome: raw.outcome.trim(),
    rationale: raw.rationale.trim(),
    durationMinutes: Math.min(240, Math.max(5, Math.round(raw.durationMinutes))),
    wellbeingConstraints: (raw.wellbeingConstraints ?? []).slice(0, 5),
    allowedApps: (raw.allowedApps ?? []).slice(0, 8),
    steps: raw.steps.map((step, index) => ({
      title: step.title.trim().slice(0, 120),
      description: `Épica: ${step.epic.trim()} Real: ${step.real.trim()}`.slice(0, 500),
      actor: step.actor,
      evidence: step.evidence.trim().slice(0, 300),
      evidenceKind: step.evidenceKind,
      verificationHint: step.verificationHint.trim().slice(0, 300),
      weight: weights[index],
    })),
  };
}

export function validatePlan(plan: QuestPlanInput): void {
  if (plan.steps.length < 1 || plan.steps.length > 12) {
    throw new Error("Una quest debe tener entre 1 y 12 pasos.");
  }
  const totalWeight = plan.steps.reduce((sum, step) => sum + step.weight, 0);
  if (totalWeight !== 100) {
    throw new Error(`Los pesos de los pasos deben sumar 100; actualmente suman ${totalWeight}.`);
  }
  if (plan.durationMinutes < 5 || plan.durationMinutes > 240) {
    throw new Error("La duración debe estar entre 5 y 240 minutos.");
  }
}

// ---------------------------------------------------------------------------
// Runtime 1: Códice sin modelo. Plantillas y reglas verificables.
// ---------------------------------------------------------------------------

function sentenceCase(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized ? normalized[0].toUpperCase() + normalized.slice(1) : "Avanzar una tarea real";
}

const OPENERS = /^(necesito|quiero|tengo que|debo|me toca|hay que|voy a|deseo|requiero|me gustaria|me gustaría)\s+/i;
const FILLERS = /^(que|de|a|el|la|los|las|un|una|unos|unas|mi|mis|su|sus)\s+/i;

/**
 * Sin modelo no hay épica real, pero el título tampoco puede ser la frase del
 * jugador tal cual. Se le quita el verbo de intención y se nombra la gesta.
 */
function titleFromIntent(intent: string): string {
  let core = sentenceCase(intent).replace(/[.?!]+$/g, "").replace(OPENERS, "");
  while (FILLERS.test(core)) core = core.replace(FILLERS, "");
  core = core.replace(/^(subir|enviar|hacer|terminar|organizar|revisar|preparar|escribir|llamar|pagar|comprar|estudiar|limpiar|ordenar)\s+/i, "");
  const compact = core.trim() || sentenceCase(intent);
  const short = compact.length > 38 ? `${compact.slice(0, 35).trim()}...` : compact;
  return short.charAt(0).toUpperCase() + short.slice(1);
}

function numberFromIntent(intent: string): number {
  const lower = intent.toLowerCase();
  const digit = lower.match(/\b([1-9]|1[0-2])\b/);
  if (digit) return Number(digit[1]);
  const words: Record<string, number> = {
    una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6,
    siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12,
  };
  for (const [word, value] of Object.entries(words)) {
    if (new RegExp(`\\b${word}\\b`, "i").test(lower)) return value;
  }
  return 3;
}

function spanishCount(value: number): string {
  const names: Record<number, string> = {
    1: "Una", 2: "Dos", 3: "Tres", 4: "Cuatro", 5: "Cinco", 6: "Seis",
    7: "Siete", 8: "Ocho", 9: "Nueve", 10: "Diez", 11: "Once", 12: "Doce",
  };
  return names[value] ?? String(value);
}

function isResumeQuest(intent: string): boolean {
  return /\b(hojas?\s+de\s+vida|curr[ií]cul|cv|candidatur|vacantes?|empleo|trabajo)\b/i.test(intent);
}

function resumeQuest(intent: string): QuestPlanInput {
  const count = Math.min(12, Math.max(1, numberFromIntent(intent)));
  const countWord = spanishCount(count);
  const plural = count === 1 ? "carta" : "cartas";
  return {
    campaignTitle: "Campaña del Segundo Estandarte",
    title: `Las ${countWord} Cartas de la Marca`,
    intent: sentenceCase(intent),
    outcome: `Enviar ${count} candidatura${count === 1 ? "" : "s"} verificable${count === 1 ? "" : "s"} a oportunidades compatibles con el perfil del marqués.`,
    rationale:
      "Códice no acepta que una hoja de vida sea solo un trámite: cada candidatura es una carta sellada enviada a un puesto estratégico del reino. La misión separa preparación, selección, adaptación, envío y registro para que la batalla avance con evidencia real.",
    durationMinutes: count > 5 ? 90 : 60,
    wellbeingConstraints: ["Priorizar vacantes compatibles", "No enviar candidaturas genéricas", "Registrar evidencia de cada envío"],
    allowedApps: ["Gmail", "LinkedIn", "Google Drive", "Navegador", "Portal de empleo"],
    steps: [
      {
        title: "Leer el pergamino del perfil",
        description:
          "Épica: Códice abre el archivo del marqués y marca sus armas principales. Real: revisa tu CV/perfil y define 2 o 3 fortalezas que usarás para escoger vacantes.",
        actor: "shared",
        evidence: "Fortalezas objetivo y CV base identificados",
        evidenceKind: "file",
        verificationHint: "El archivo del CV existe y el jugador nombró al menos dos fortalezas.",
        weight: 10,
      },
      {
        title: `Revelar ${countWord.toLowerCase()} portales`,
        description:
          `Épica: el mapa muestra ${count} puertas por donde puede avanzar la campaña. Real: encuentra ${count} vacante${count === 1 ? "" : "s"} concreta${count === 1 ? "" : "s"} y compatible${count === 1 ? "" : "s"} con salario, horario, modalidad y perfil.`,
        actor: "shared",
        evidence: `Enlaces o nombres de ${count} vacante${count === 1 ? "" : "s"} seleccionada${count === 1 ? "" : "s"}`,
        evidenceKind: "link",
        verificationHint: `La evidencia contiene ${count} referencias distintas a vacantes concretas.`,
        weight: 15,
      },
      {
        title: "Forjar la carta maestra",
        description:
          "Épica: la carta recibe sello, tinta y filo. Real: ajusta el CV o mensaje base para que hable directamente a esas vacantes, sin reescribir todo desde cero.",
        actor: "user",
        evidence: "CV o mensaje base adaptado",
        evidenceKind: "file",
        verificationHint: "Existe un archivo de CV adaptado, distinto del original o con fecha posterior.",
        weight: 20,
      },
      {
        title: "Preparar los sellos",
        description:
          "Épica: cada carta recibe una marca distinta antes de salir del torreón. Real: prepara asunto, mensaje corto o respuestas requeridas por cada portal.",
        actor: "user",
        evidence: "Textos o respuestas listas para enviar",
        evidenceKind: "text",
        verificationHint: "Los textos existen y mencionan la vacante o la empresa destinataria.",
        weight: 10,
      },
      {
        title: `Enviar las ${countWord.toLowerCase()} ${plural}`,
        description:
          `Épica: el marqués despacha ${count} ${plural} bajo protección del lobo. Real: envía las ${count} candidatura${count === 1 ? "" : "s"} por correo, LinkedIn o portal de empleo.`,
        actor: "user",
        evidence: `Confirmación, captura o correo de envío de las ${count} candidatura${count === 1 ? "" : "s"}`,
        evidenceKind: "screenshot",
        verificationHint: `Hay ${count} confirmaciones de envío distintas, con destinatario y fecha.`,
        weight: 35,
      },
      {
        title: "Registrar el eco de los emisarios",
        description:
          "Épica: los exploradores dejan marcas en el mapa para el siguiente día. Real: anota dónde postulaste, fecha, enlace y próximo seguimiento.",
        actor: "shared",
        evidence: "Registro de postulaciones y siguiente seguimiento",
        evidenceKind: "text",
        verificationHint: "El registro lista cada postulación con fecha y próxima acción.",
        weight: 10,
      },
    ],
  };
}

function genericQuest(intent: string): QuestPlanInput {
  const cleanIntent = sentenceCase(intent);
  const title = titleFromIntent(cleanIntent);
  return {
    campaignTitle: "Campaña activa",
    title: `El Asedio de ${title}`,
    intent: cleanIntent,
    outcome: `Completar de forma verificable: ${cleanIntent}`,
    rationale:
      "Códice convirtió la intención en una misión de frontera: primero se define la victoria, luego se preparan recursos, se ejecuta el núcleo y solo la evidencia real mueve la batalla.",
    durationMinutes: 45,
    wellbeingConstraints: ["Mantener el alcance pequeño", "No aceptar progreso sin evidencia"],
    allowedApps: ["Codex", "Navegador", "Archivos", "Aplicación necesaria para la tarea"],
    steps: [
      {
        title: "Trazar la frontera",
        description: "Épica: el marqués dibuja el borde exacto de la campaña. Real: escribe cómo se verá la tarea terminada y qué queda por fuera.",
        actor: "user",
        evidence: "Resultado esperado redactado",
        evidenceKind: "text",
        verificationHint: "El texto describe un final observable, no una actividad.",
        weight: 15,
      },
      {
        title: "Reunir la compañía",
        description: "Épica: Códice convoca herramientas, rutas y aliados. Real: abre o prepara documentos, enlaces, aplicaciones o materiales necesarios.",
        actor: "shared",
        evidence: "Lista breve de recursos usados",
        evidenceKind: "text",
        verificationHint: "La lista nombra recursos concretos y accesibles.",
        weight: 15,
      },
      {
        title: "Romper la línea enemiga",
        description: "Épica: el golpe central de la misión cae sobre la horda. Real: realiza la acción principal de la quest.",
        actor: "user",
        evidence: "Captura, enlace, archivo, texto final o confirmación del avance principal",
        evidenceKind: "file",
        verificationHint: "El artefacto entregado demuestra que la acción principal ocurrió.",
        weight: 45,
      },
      {
        title: "Presentar el sello",
        description: "Épica: la prueba queda sobre la mesa de Códice. Real: resume lo hecho y adjunta o describe la evidencia verificable.",
        actor: "user",
        evidence: "Evidencia entregada a Códice",
        evidenceKind: "declaration",
        verificationHint: "El resumen coincide con los artefactos entregados.",
        weight: 15,
      },
      {
        title: "Cerrar el mapa",
        description: "Épica: el reino conserva memoria de la expedición. Real: anota el siguiente paso natural o la lección de la misión.",
        actor: "shared",
        evidence: "Nota de cierre o siguiente acción",
        evidenceKind: "text",
        verificationHint: "La nota define una acción siguiente concreta.",
        weight: 10,
      },
    ],
  };
}

export function questFromIntent(intent: string): QuestPlanInput {
  const cleanIntent = sentenceCase(intent);
  if (cleanIntent.length < 8) throw new Error("Describe una quest con un poco más de detalle.");
  return isResumeQuest(cleanIntent) ? resumeQuest(cleanIntent) : genericQuest(cleanIntent);
}

export class HeuristicCodice implements CodicePlanner {
  readonly name = "heuristico";

  async plan(request: PlanRequest): Promise<QuestPlanInput> {
    return questFromIntent(request.intent);
  }

  async judge({ step, remainingImpact, note, artifacts }: JudgeRequest): Promise<Judgement> {
    const verified = artifacts.filter((artifact) => artifact.verification.verified);
    const half = Math.max(1, Math.floor(remainingImpact / 2));
    if (verified.length > 0) {
      return {
        verdict: "accepted",
        impactAwarded: remainingImpact,
        reasoning: `Códice comprobó ${verified.length} artefacto(s) reales para «${step.evidence}»: ${verified
          .map((artifact) => artifact.label)
          .join(", ")}.`,
      };
    }
    if (artifacts.length > 0) {
      if (half >= remainingImpact) {
        return { verdict: "rejected", impactAwarded: 0, reasoning: "El artefacto llegó, pero Códice no pudo comprobarlo. Falta la parte verificable del paso." };
      }
      return {
        verdict: "partial",
        impactAwarded: half,
        reasoning: "El artefacto llegó pero no pudo comprobarse por completo; Códice concede solo una parte del impacto.",
      };
    }
    if (note.trim().length >= 12) {
      if (half >= remainingImpact) {
        return { verdict: "rejected", impactAwarded: 0, reasoning: "Una declaración sin artefacto no basta para cerrar el último punto de este paso." };
      }
      return {
        verdict: "partial",
        impactAwarded: half,
        reasoning: "Declaración registrada sin artefacto verificable: la actividad avanza, pero todavía no prueba el resultado pactado.",
      };
    }
    return { verdict: "rejected", impactAwarded: 0, reasoning: "No hay evidencia suficiente: describe qué ocurrió o entrega el artefacto pactado." };
  }
}

// ---------------------------------------------------------------------------
// Runtime 2: Códice con modelo. El Dungeon Master razona dentro del servidor,
// para que el jugador pueda declarar cualquier objetivo desde el propio juego
// sin tener abierto Codex ni Claude.
// ---------------------------------------------------------------------------

function firstJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("El Códice no devolvió un contrato JSON.");
  return JSON.parse(trimmed.slice(start, end + 1));
}

/** El mismo encargo, sin importar qué modelo lo reciba. */
export function planPrompt(request: PlanRequest): string {
  return [
    `Intención literal del jugador: «${request.intent.trim()}»`,
    request.playerTitle ? `Jugador: ${request.playerTitle}.` : null,
    request.activeCampaign ? `Campaña vigente: ${request.activeCampaign}.` : null,
    request.minutesAvailable ? `Tiempo disponible declarado: ${request.minutesAvailable} minutos.` : null,
    "",
    "Convierte esa intención en el contrato de quest.",
    "El título NO puede repetir la frase del jugador: nombra la campaña como una gesta del reino, corta y evocadora.",
    "Los pasos deben ser específicos de ESTA tarea, con los sustantivos, plataformas y documentos reales del dominio del jugador. Un paso que serviría igual para cualquier otra tarea es un paso mal formulado.",
    "Cada paso debe terminar en algo que el jugador pueda ENTREGAR: un archivo, un enlace, una captura, un número. Ese entregable es lo que después activa el ataque.",
    "Si la intención es ambigua, escoge la lectura más probable y hazla explícita en outcome; no pidas aclaraciones.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function judgePrompt({ quest, step, remainingImpact, note, artifacts }: JudgeRequest, attachedImages = 0): string {
  return [
    `Resultado de la campaña: ${quest.outcome}`,
    `Paso evaluado: ${step.title}`,
    `Condición pactada: ${step.evidence}`,
    step.verificationHint ? `Qué debe comprobarse: ${step.verificationHint}` : null,
    `Impacto restante de este paso: ${remainingImpact} (máximo que puedes conceder).`,
    "",
    "Declaración del jugador:",
    note.trim() || "(sin declaración)",
    "",
    "Artefactos entregados y comprobados por el servidor (hechos, no opiniones):",
    artifacts.length === 0
      ? "(ninguno)"
      : artifacts
          .map((artifact) =>
            [
              `- ${artifact.label} [${artifact.kind}]`,
              `  comprobado por el servidor: ${artifact.verification.verified ? "sí" : "no"} (${artifact.verification.detail})`,
              artifact.bytes ? `  tamaño: ${artifact.bytes} bytes` : null,
              artifact.sha256 ? `  sha256: ${artifact.sha256}` : null,
              artifact.url ? `  url: ${artifact.url}` : null,
              artifact.excerpt ? `  extracto: ${artifact.excerpt.slice(0, 800)}` : null,
            ]
              .filter(Boolean)
              .join("\n"),
          )
          .join("\n"),
    "",
    attachedImages > 0
      ? `Se adjuntaron ${attachedImages} imagen(es) a este mensaje. MIRALAS: describe lo que realmente muestran y contrasta ese contenido con la condicion pactada. Si la imagen no muestra lo pactado, el veredicto no puede ser accepted por mas que la declaracion lo afirme.`
      : null,
    "",
    "Decide el veredicto. rejected concede 0. partial concede entre 1 y (restante - 1). accepted concede exactamente el restante.",
    "Un artefacto que el servidor no pudo comprobar nunca justifica accepted por sí solo.",
    "El tiempo, el esfuerzo y la intención no causan daño. Explica el veredicto en una o dos frases dirigidas al jugador.",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export class AnthropicCodice implements CodicePlanner {
  readonly name = "anthropic";

  constructor(
    private readonly client: {
      messages: {
        create(body: Record<string, unknown>): Promise<{ content: Array<{ type: string; text?: string }>; parsed_output?: unknown }>;
      };
    },
    private readonly model: string,
    private readonly fallback: CodicePlanner = new HeuristicCodice(),
  ) {}

  private async structured(system: string, prompt: string, schema: unknown, maxTokens: number, effort: string): Promise<unknown> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: prompt }],
      output_config: { effort, format: { type: "json_schema", schema } },
    });
    if (response.parsed_output && typeof response.parsed_output === "object") return response.parsed_output;
    const text = response.content.find((block) => block.type === "text" && block.text)?.text ?? "";
    return firstJsonObject(text);
  }

  async plan(request: PlanRequest): Promise<QuestPlanInput> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const raw = (await this.structured(CODICE_INSTRUCTIONS, planPrompt(request), PLAN_SCHEMA, 8000, "high")) as RawPlan;
        const plan = planFromRaw(raw, request.intent);
        validatePlan(plan);
        return plan;
      } catch (error) {
        if (attempt === 1) {
          process.stderr.write(`[codice] plan degradado a heurística: ${error instanceof Error ? error.message : String(error)}\n`);
          return this.fallback.plan(request);
        }
      }
    }
    return this.fallback.plan(request);
  }

  async judge(request: JudgeRequest): Promise<Judgement> {
    try {
      const raw = (await this.structured(
        `${CODICE_INSTRUCTIONS}\n\nAhora actúas como juez de evidencia, no como planificador.`,
        judgePrompt(request),
        JUDGE_SCHEMA,
        2000,
        "low",
      )) as Judgement;
      return clampJudgement(raw, request.remainingImpact);
    } catch (error) {
      process.stderr.write(`[codice] veredicto degradado a heurística: ${error instanceof Error ? error.message : String(error)}\n`);
      return this.fallback.judge(request);
    }
  }
}

/** El servidor —no el modelo— es el dueño de las reglas de daño. */
export function clampJudgement(raw: Judgement, remainingImpact: number): Judgement {
  const reasoning = (raw.reasoning ?? "").trim() || "El Códice evaluó la evidencia.";
  if (raw.verdict === "accepted") {
    return { verdict: "accepted", impactAwarded: remainingImpact, reasoning };
  }
  if (raw.verdict === "partial") {
    if (remainingImpact <= 1) {
      return { verdict: "rejected", impactAwarded: 0, reasoning: `${reasoning} (Queda un solo punto: solo la evidencia completa puede cerrarlo.)` };
    }
    const impact = Math.min(remainingImpact - 1, Math.max(1, Math.round(raw.impactAwarded)));
    return { verdict: "partial", impactAwarded: impact, reasoning };
  }
  return { verdict: "rejected", impactAwarded: 0, reasoning };
}

// ---------------------------------------------------------------------------
// Runtime 3: Códice sobre el CLI local de Claude.
// No usa clave de API: usa la sesión de Claude Code de la máquina. Es la vía
// de desarrollo: el mismo Dungeon Master del chat, pero disponible para la
// pantalla del juego cuando no hay ninguna conversación abierta.
// ---------------------------------------------------------------------------

export class ClaudeCliCodice implements CodicePlanner {
  readonly name = "claude-cli";

  constructor(
    private readonly binary: string,
    private readonly fallback: CodicePlanner = new HeuristicCodice(),
    private readonly model?: string,
  ) {}

  private async structured(system: string, prompt: string, schema: unknown): Promise<unknown> {
    const { execFile } = await import("node:child_process");
    const { tmpdir } = await import("node:os");
    const args = ["-p", "--output-format", "json"];
    if (this.model) args.push("--model", this.model);

    const full = [
      system,
      "",
      prompt,
      "",
      "Responde ÚNICAMENTE con un objeto JSON que valide contra este esquema. Sin explicación, sin markdown, sin bloques de código.",
      JSON.stringify(schema),
    ].join("\n");

    const stdout = await new Promise<string>((resolveOut, rejectOut) => {
      const child = execFile(
        this.binary,
        args,
        { cwd: tmpdir(), timeout: 180_000, maxBuffer: 12 * 1024 * 1024, windowsHide: true },
        (error, out, err) => {
          if (error) {
            rejectOut(new Error(`${error.message}${err ? ` — ${String(err).slice(0, 400)}` : ""}`));
            return;
          }
          resolveOut(String(out));
        },
      );
      child.stdin?.end(full);
    });

    // --output-format json envuelve la respuesta; el texto del modelo va en `result`.
    let text = stdout;
    try {
      const envelope = JSON.parse(stdout) as { result?: string; is_error?: boolean };
      if (envelope.is_error) throw new Error("El CLI de Claude devolvió un error.");
      if (typeof envelope.result === "string") text = envelope.result;
    } catch {
      // Si no vino envuelto, se busca el JSON directamente en la salida.
    }
    return firstJsonObject(text);
  }

  async plan(request: PlanRequest): Promise<QuestPlanInput> {
    try {
      const raw = (await this.structured(CODICE_INSTRUCTIONS, planPrompt(request), PLAN_SCHEMA)) as RawPlan;
      const plan = planFromRaw(raw, request.intent);
      validatePlan(plan);
      return plan;
    } catch (error) {
      process.stderr.write(`[codice] plan degradado a heurística: ${error instanceof Error ? error.message : String(error)}\n`);
      return this.fallback.plan(request);
    }
  }

  async judge(request: JudgeRequest): Promise<Judgement> {
    try {
      const raw = (await this.structured(
        `${CODICE_INSTRUCTIONS}\n\nAhora actúas como juez de evidencia, no como planificador.`,
        judgePrompt(request),
        JUDGE_SCHEMA,
      )) as Judgement;
      return clampJudgement(raw, request.remainingImpact);
    } catch (error) {
      process.stderr.write(`[codice] veredicto degradado a heurística: ${error instanceof Error ? error.message : String(error)}\n`);
      return this.fallback.judge(request);
    }
  }
}

// ---------------------------------------------------------------------------
// Runtime 4: Códice sobre Gemini. Mismo contrato, otro proveedor.
// ---------------------------------------------------------------------------

export interface ImagePart {
  mimeType: string;
  dataBase64: string;
  label: string;
}

const JUDGEABLE_IMAGE = /^image\/(png|jpeg|webp|gif)$/;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_IMAGES = 4;

/**
 * Carga del disco los artefactos que son imagenes para que el juez los mire.
 * Una captura de pantalla no se puede evaluar por su nombre ni por su hash.
 */
export async function loadImageParts(artifacts: EvidenceArtifact[]): Promise<ImagePart[]> {
  const { readFile } = await import("node:fs/promises");
  const parts: ImagePart[] = [];
  for (const artifact of artifacts) {
    if (parts.length >= MAX_IMAGES) break;
    if (!artifact.storedPath || !artifact.mimeType) continue;
    if (!JUDGEABLE_IMAGE.test(artifact.mimeType)) continue;
    if ((artifact.bytes ?? 0) > MAX_IMAGE_BYTES) continue;
    try {
      const buffer = await readFile(artifact.storedPath);
      parts.push({ mimeType: artifact.mimeType, dataBase64: buffer.toString("base64"), label: artifact.label });
    } catch {
      // Si el archivo ya no esta, el juez lo trata como artefacto sin comprobar.
    }
  }
  return parts;
}

/** Gemini rechaza algunas palabras clave de JSON Schema; se limpian aquí. */
function geminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "additionalProperties") continue;
    output[key] = geminiSchema(value);
  }
  return output;
}

export class GeminiCodice implements CodicePlanner {
  readonly name = "gemini";

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fallback: CodicePlanner = new HeuristicCodice(),
  ) {}

  private async structured(system: string, prompt: string, schema: unknown, images: ImagePart[] = []): Promise<unknown> {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
    const parts: Array<Record<string, unknown>> = [
      ...images.map((image) => ({ inline_data: { mime_type: image.mimeType, data: image.dataBase64 } })),
      { text: prompt },
    ];
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: geminiSchema(schema),
        },
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) {
      throw new Error(`Gemini respondió ${response.status}: ${(await response.text()).slice(0, 400)}`);
    }
    const payload = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
    return firstJsonObject(text);
  }

  async plan(request: PlanRequest): Promise<QuestPlanInput> {
    try {
      const raw = (await this.structured(CODICE_INSTRUCTIONS, planPrompt(request), PLAN_SCHEMA)) as RawPlan;
      const plan = planFromRaw(raw, request.intent);
      validatePlan(plan);
      return plan;
    } catch (error) {
      process.stderr.write(`[codice] plan degradado a heurística: ${error instanceof Error ? error.message : String(error)}\n`);
      return this.fallback.plan(request);
    }
  }

  async judge(request: JudgeRequest): Promise<Judgement> {
    try {
      // Una captura solo prueba algo si el juez la mira de verdad.
      const images = await loadImageParts(request.artifacts);
      const raw = (await this.structured(
        `${CODICE_INSTRUCTIONS}\n\nAhora actuas como juez de evidencia, no como planificador.`,
        judgePrompt(request, images.length),
        JUDGE_SCHEMA,
        images,
      )) as Judgement;
      return clampJudgement(raw, request.remainingImpact);
    } catch (error) {
      process.stderr.write(`[codice] veredicto degradado a heurística: ${error instanceof Error ? error.message : String(error)}\n`);
      return this.fallback.judge(request);
    }
  }
}

/**
 * Selección del runtime. `TORREON_CODICE` manda; si no, se elige por las
 * credenciales disponibles. El juego nunca se queda sin Dungeon Master.
 */
export function createCodice(): CodicePlanner {
  const heuristic = new HeuristicCodice();
  const requested = process.env.TORREON_CODICE?.trim().toLowerCase();

  if (requested === "heuristico") return heuristic;

  if (requested === "claude-cli" || (!requested && process.env.TORREON_CLAUDE_BIN)) {
    const binary = process.env.TORREON_CLAUDE_BIN?.trim() || "claude";
    return new ClaudeCliCodice(binary, heuristic, process.env.TORREON_CODICE_MODEL);
  }

  if (requested === "gemini" || (!requested && process.env.GEMINI_API_KEY)) {
    const key = process.env.GEMINI_API_KEY?.trim();
    if (!key) {
      process.stdout.write("[codice] falta GEMINI_API_KEY: el Dungeon Master usa plantillas verificables.\n");
      return heuristic;
    }
    return new GeminiCodice(key, process.env.TORREON_GEMINI_MODEL ?? "gemini-3.1-pro-preview", heuristic);
  }

  if (requested === "anthropic" || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    return new LazyAnthropicCodice(process.env.TORREON_CODICE_MODEL ?? "claude-opus-5", heuristic);
  }

  process.stdout.write("[codice] sin motor configurado: el Dungeon Master usa plantillas verificables.\n");
  return heuristic;
}

/**
 * El SDK se carga solo si se usa, para que el MVP siga arrancando y los tests
 * sigan corriendo sin la dependencia instalada ni credenciales.
 */
class LazyAnthropicCodice implements CodicePlanner {
  readonly name = "anthropic";
  private delegate: Promise<CodicePlanner> | null = null;

  constructor(private readonly model: string, private readonly fallback: CodicePlanner) {}

  private resolve(): Promise<CodicePlanner> {
    this.delegate ??= import("@anthropic-ai/sdk")
      .then((module) => {
        const Anthropic = module.default;
        return new AnthropicCodice(new Anthropic() as never, this.model, this.fallback) as CodicePlanner;
      })
      .catch((error) => {
        process.stderr.write(`[codice] no fue posible cargar @anthropic-ai/sdk: ${error instanceof Error ? error.message : String(error)}\n`);
        return this.fallback;
      });
    return this.delegate;
  }

  async plan(request: PlanRequest): Promise<QuestPlanInput> {
    return (await this.resolve()).plan(request);
  }

  async judge(request: JudgeRequest): Promise<Judgement> {
    return (await this.resolve()).judge(request);
  }
}
