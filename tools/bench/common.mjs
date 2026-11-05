// Outils partagés des bancs d'essai.
import "./shim.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DATA = path.join(HERE, "data");
const LIB = path.join(HERE, "..", "..", "lib") + path.sep;
const require = createRequire(import.meta.url);
export const lib = (name) => require(LIB + name);
export const pdfjs = await import(pathToFileURL(path.join(DATA, "omni/resource/reader/pdf/build/pdf.mjs")).href);
export const readJSON = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8"));

// Comparaison d'intitulés : sans numérotation, accents ni ponctuation.
const strip = s => String(s).replace(/^\s*(?:(?:chapitre|chapter|partie|part)\s+)?(?:\d+(?:[.\-]\d+)*|[IVXLCDM]{1,7}|[A-Z])[.)]?\s*[:.\-\u2013\u2014]?\s+/i, "");
const nk = s => strip(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
export function sameTitle(a, b) {
  a = nk(a); b = nk(b); if (!a || !b) return false; if (a === b) return true;
  const [s, l] = a.length < b.length ? [a, b] : [b, a]; return s.length >= 8 && l.startsWith(s);
}
// Précision, rappel et F1 contre un sommaire de référence [[niveau, titre, page]].
export function score(det, ref) {
  ref = ref.filter(t => t[2] >= 1);
  const used = new Set(); let tp = 0;
  for (const d of det) for (let i = 0; i < ref.length; i++) {
    if (used.has(i)) continue;
    if (Math.abs((ref[i][2] - 1) - d.pageIndex) <= 1 && sameTitle(d.title, ref[i][1])) { tp++; used.add(i); break; }
  }
  const P = det.length ? tp / det.length : 0, R = ref.length ? tp / ref.length : 0;
  return { P, R, F: (P + R) ? 2 * P * R / (P + R) : 0 };
}
export async function extract(file, opts) {
  return lib("extract.js").extractDocument(pdfjs, new Uint8Array(fs.readFileSync(file)), opts || {});
}
