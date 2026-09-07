import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, stat, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { ArtifactKind, EvidenceArtifact } from "./domain.js";
import { isoAt } from "./clock.js";
import { deny } from "./errors.js";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".eml": "message/rfc822",
};

const TEXTUAL = new Set(["text/plain", "text/markdown", "text/csv", "application/json", "text/html", "message/rfc822"]);

export interface ArtifactInput {
  kind: ArtifactKind;
  /** Ruta local del documento cuando kind es "file". El MCP corre junto al jugador. */
  path?: string;
  /** Enlace cuando kind es "link". */
  url?: string;
  /** Contenido literal cuando kind es "text". */
  text?: string;
  label?: string;
  /**
   * Bytes en base64 cuando el jugador entrega el archivo desde el juego —
   * una captura pegada, una foto del teléfono— y no desde el disco del MCP.
   */
  dataBase64?: string;
  filename?: string;
  mimeType?: string;
}

const EXTENSION_BY_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_BY_EXTENSION).map(([extension, mime]) => [mime, extension]),
);

function excerptFrom(buffer: Buffer, mimeType: string): string | undefined {
  if (!TEXTUAL.has(mimeType)) return undefined;
  const head = buffer.subarray(0, 8000);
  if (head.includes(0)) return undefined;
  return head.toString("utf8").replace(/\s+/g, " ").trim().slice(0, 2000);
}

/**
 * Convierte un documento, enlace o texto real en un artefacto del reino.
 *
 * Aquí ocurre la parte que el modelo NO decide: el servidor comprueba hechos
 * (existe, pesa, su hash, su tipo) antes de que nadie emita un veredicto.
 */
export async function ingestArtifact(
  nowMs: number,
  input: ArtifactInput,
  questId: string,
  stepId: string,
  dataDir: string,
): Promise<EvidenceArtifact> {
  const id = randomUUID();
  const createdAt = isoAt(nowMs);
  const base = { id, questId, stepId, stepIds: [stepId], kind: input.kind, createdAt };

  // Entrega desde el juego: los bytes vienen en el cuerpo, no en el disco.
  if (input.kind === "file" && input.dataBase64) {
    const buffer = Buffer.from(input.dataBase64, "base64");
    if (buffer.length === 0) throw deny("El archivo llegó vacío.");
    const filename = (input.filename ?? "").trim();
    const declared = (input.mimeType ?? "").trim().toLowerCase();
    const extension = extname(filename).toLowerCase() || EXTENSION_BY_MIME[declared] || "";
    const mimeType = MIME_BY_EXTENSION[extension] ?? declared ?? "application/octet-stream";
    const storedPath = resolve(dataDir, "artifacts", `${id}${extension}`);
    await mkdir(resolve(dataDir, "artifacts"), { recursive: true });
    await writeFile(storedPath, buffer);
    return {
      ...base,
      label: input.label?.trim() || filename || `Archivo de ${buffer.length} bytes`,
      mimeType,
      bytes: buffer.length,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      storedPath,
      excerpt: excerptFrom(buffer, mimeType),
      verification: {
        verified: true,
        verifiedBy: "server" as const,
        detail: `Archivo recibido y guardado en el reino: ${buffer.length} bytes, ${mimeType}.`,
        checkedAt: createdAt,
      },
    };
  }

  if (input.kind === "file") {
    if (!input.path?.trim()) throw deny("Indica la ruta del documento que quieres entregar al Códice.");
    const sourcePath = resolve(input.path.trim());
    let stats;
    try {
      stats = await stat(sourcePath);
    } catch {
      return {
        ...base,
        label: input.label?.trim() || sourcePath,
        sourcePath,
        verification: { verified: false, detail: "El servidor no encontró ese archivo en la ruta indicada.", checkedAt: createdAt },
      };
    }
    if (!stats.isFile()) {
      return {
        ...base,
        label: input.label?.trim() || sourcePath,
        sourcePath,
        verification: { verified: false, detail: "La ruta existe pero no es un archivo.", checkedAt: createdAt },
      };
    }
    const extension = extname(sourcePath).toLowerCase();
    const mimeType = MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
    const buffer = await readFile(sourcePath);
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const storedPath = resolve(dataDir, "artifacts", `${id}${extension}`);
    await mkdir(resolve(dataDir, "artifacts"), { recursive: true });
    await copyFile(sourcePath, storedPath);
    return {
      ...base,
      label: input.label?.trim() || sourcePath.split(/[\\/]/).pop() || sourcePath,
      mimeType,
      bytes: stats.size,
      sha256,
      sourcePath,
      storedPath,
      excerpt: excerptFrom(buffer, mimeType),
      verification: {
        verified: stats.size > 0,
        detail:
          stats.size > 0
            ? `Archivo real: ${stats.size} bytes, ${mimeType}, modificado ${stats.mtime.toISOString()}, copiado al reino.`
            : "El archivo existe pero está vacío.",
        checkedAt: createdAt,
      },
    };
  }

  if (input.kind === "link") {
    const raw = input.url?.trim() ?? "";
    let parsed: URL | null = null;
    try {
      parsed = new URL(raw);
    } catch {
      parsed = null;
    }
    return {
      ...base,
      label: input.label?.trim() || raw || "enlace",
      url: parsed ? parsed.toString() : raw,
      verification: {
        verified: false,
        detail: parsed
          ? "Enlace bien formado y registrado. El servidor no navega: solo su contenido comprobado puede cerrar el paso."
          : "El enlace no es una URL válida.",
        checkedAt: createdAt,
      },
    };
  }

  const text = input.text?.trim() ?? "";
  if (!text) throw deny("El artefacto de texto está vacío.");
  return {
    ...base,
    label: input.label?.trim() || `Texto de ${text.length} caracteres`,
    mimeType: "text/plain",
    bytes: Buffer.byteLength(text, "utf8"),
    sha256: createHash("sha256").update(text).digest("hex"),
    excerpt: text.slice(0, 2000),
    verification: {
      verified: false,
      detail: "Texto declarado por el jugador: queda registrado como declaración, no como prueba comprobada por el servidor.",
      checkedAt: createdAt,
    },
  };
}

export interface WitnessInput {
  kind: ArtifactKind;
  label: string;
  /** Lo que el Dungeon Master vio realmente al abrir el artefacto. */
  observed: string;
  witness: string;
  url?: string;
  mimeType?: string;
  bytes?: number;
}

/**
 * Artefacto atestiguado: el jugador nunca toca el juego.
 *
 * Cuando el Dungeon Master vive donde vive el archivo —ChatGPT con el PDF
 * cargado, Codex con la carpeta abierta—, el servidor no puede ver los bytes,
 * pero sí puede exigir que alguien capaz de leerlos declare qué contienen y
 * dejar constancia de quién lo hizo. Es distinto de una declaracion a secas:
 * aqui hubo un artefacto y hubo un testigo que lo miro.
 */
export function witnessArtifact(input: WitnessInput, questId: string, stepId: string, nowMs: number): EvidenceArtifact {
  const observed = input.observed.trim();
  if (observed.length < 10) {
    throw deny("El testigo debe describir qué vio en el artefacto, no solo afirmar que existe.");
  }
  const createdAt = isoAt(nowMs);
  return {
    id: randomUUID(),
    questId,
    stepId,
    stepIds: [stepId],
    kind: input.kind,
    label: input.label.trim() || "Artefacto atestiguado",
    url: input.url?.trim() || undefined,
    mimeType: input.mimeType?.trim() || undefined,
    bytes: Number.isFinite(input.bytes) ? input.bytes : undefined,
    excerpt: observed.slice(0, 2000),
    verification: {
      verified: true,
      verifiedBy: "witness",
      witness: input.witness.trim() || "dungeon master",
      detail: `Examinado directamente por ${input.witness.trim() || "el Dungeon Master"}: ${observed.slice(0, 400)}`,
      checkedAt: createdAt,
    },
    createdAt,
  };
}
