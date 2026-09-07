#!/usr/bin/env node
// EL VOCABULARIO DEL CONTRATO, GENERADO (ADR-0005).
//
// `apps/web/src/types.ts` es una copia a mano de `domain.ts` y ya derivó una
// vez: el cliente ensanchó `BattleStatus` con un estado que el Núcleo no puede
// producir. Unity sería la TERCERA copia a mano, en otro lenguaje y sin ningún
// compilador que la ate a las otras dos.
//
// Esto genera el vocabulario compartido para C#. No es todavía el contrato
// entero —los DTO de cada vista llegan con el proyecto Unity, que es quien
// dirá qué forma necesita—, pero sí la parte que ya demostró que deriva sola.
//
//   node scripts/generar-contrato-csharp.mjs            # escribe el archivo
//   node scripts/generar-contrato-csharp.mjs --check    # falla si está desfasado
//
// La regla que hace esto seguro para una APK publicada (artículo 13): cada
// enum lleva `Unknown = 0`. Un valor nuevo del servidor NO rompe una versión
// vieja del cliente: cae en `Unknown` y la pantalla lo ignora con elegancia.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const origen = resolve(raiz, "apps/server/src/domain.ts");
const destino = resolve(raiz, "contract/csharp/TorreonVocabulario.cs");

/** Las uniones de literales del Núcleo. Nada más: lo demás no está decidido. */
function unionesDe(fuente) {
  const uniones = new Map();
  const patron = /^export type ([A-Za-z]+) = ((?:"[^"]*"\s*\|?\s*)+);/gm;
  let coincidencia;
  while ((coincidencia = patron.exec(fuente))) {
    const miembros = (coincidencia[2].match(/"[^"]*"/g) ?? []).map((m) => m.slice(1, -1));
    if (miembros.length > 1) uniones.set(coincidencia[1], miembros);
  }
  return uniones;
}

/** `awaiting_replan` -> `AwaitingReplan`. Un id interno nunca cambia de valor. */
const aPascal = (valor) =>
  valor
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((parte) => parte.charAt(0).toUpperCase() + parte.slice(1))
    .join("");

function generar(uniones) {
  const lineas = [
    "// GENERADO POR scripts/generar-contrato-csharp.mjs — NO SE EDITA A MANO.",
    "//",
    "// Fuente: apps/server/src/domain.ts. Si esto y la fuente no coinciden, el",
    "// build falla (ADR-0005): el vocabulario del Núcleo tiene UNA sola fuente.",
    "//",
    "// Cada enum lleva Unknown = 0 a propósito (artículo 13): un valor nuevo del",
    "// servidor no puede romper una APK que ya está instalada en un teléfono.",
    "",
    "using System.Runtime.Serialization;",
    "",
    "namespace Torreon.Contrato",
    "{",
  ];
  for (const [nombre, miembros] of [...uniones].sort(([a], [b]) => a.localeCompare(b))) {
    lineas.push(`    public enum ${nombre}`);
    lineas.push("    {");
    lineas.push("        [EnumMember(Value = \"\")]");
    lineas.push("        Unknown = 0,");
    miembros.forEach((miembro, indice) => {
      lineas.push(`        [EnumMember(Value = "${miembro}")]`);
      lineas.push(`        ${aPascal(miembro)} = ${indice + 1},`);
    });
    lineas.push("    }");
    lineas.push("");
  }
  lineas.push("}");
  return `${lineas.join("\n")}\n`;
}

const uniones = unionesDe(readFileSync(origen, "utf8"));
const generado = generar(uniones);
const comprobar = process.argv.includes("--check");

if (comprobar) {
  const actual = existsSync(destino) ? readFileSync(destino, "utf8") : "";
  if (actual !== generado) {
    process.stderr.write(
      "El contrato de C# no coincide con `domain.ts`.\n" +
        "Ejecuta `npm run contrato:csharp` y revisa el cambio: puede que estés\n" +
        "rompiendo una APK que ya está instalada (artículo 13).\n",
    );
    process.exit(1);
  }
  process.stdout.write(`Contrato al día: ${uniones.size} vocabularios.\n`);
} else {
  mkdirSync(dirname(destino), { recursive: true });
  writeFileSync(destino, generado, "utf8");
  process.stdout.write(`Contrato generado en ${destino} (${uniones.size} vocabularios).\n`);
}
