// Fonction de collage : node paste-bench.mjs <books|articles> <N> [avecPages]
// Le « sommaire collé » est le sommaire de référence, indenté par niveau.
// Sans « avecPages », aucun numéro de page n'est fourni : cas le plus dur.
import { lib, readJSON, sameTitle, extract } from "./common.mjs";
const DT = lib("detect.js"), PASTE = lib("toc-paste.js");
const [set = "books", nArg = "999", mode = ""] = process.argv.slice(2);
const gt = readJSON(set === "books" ? "books.json" : "articles.json");
const N = parseInt(nArg, 10), step = Math.max(1, Math.floor(gt.length / N));
let tot = 0, exact = 0, near = 0, miss = 0, wrongLevel = 0, docs = 0, t0 = Date.now(), perDoc = [];
for (const g of gt.filter((_, i) => i % step === 0).slice(0, N)) {
  let doc; try { doc = await extract(g.file); } catch { continue; }
  const heads = DT._internals.findRunningHeads(doc.pages);
  const census = DT._internals.styleCensus(doc.pages);
  const exclude = DT._internals.findTocPages(doc.pages);
  const ref = g.toc.filter(t => t[2] >= 1);
  const text = ref.map(t => "    ".repeat(t[0] - 1) + t[1] + (mode === "avecPages" ? "  " + t[2] : "")).join("\n");
  const r = PASTE.locate(text, doc, heads, census.bodySize, { excludePages: exclude, placeUnmatched: true });
  docs++;
  let dOk = 0;
  for (const [lv, ti, pg] of ref) {
    tot++;
    const h = r.headings.find(x => sameTitle(x.title, ti));
    if (!h) { miss++; continue; }
    const d = Math.abs(h.pageIndex + 1 - pg);
    if (d === 0) { exact++; dOk++; } else if (d === 1) { near++; dOk++; } else miss++;
    if (h.level !== lv) wrongLevel++;
  }
  perDoc.push([dOk / ref.length, ref.length, g.file.split("/").pop().slice(0, 36), r.offset]);
}
const pc = x => (x / tot * 100).toFixed(1) + "%";
console.log(`[collage ${set}${mode ? " avec pages" : " sans pages"}] ${docs} docs, ${tot} entrées | page exacte ${pc(exact)} | à une page ${pc(near)} | manquées ou fausses ${pc(miss)} | niveau différent ${pc(wrongLevel)} | ${((Date.now() - t0) / 1000).toFixed(0)}s`);
const macro = perDoc.reduce((a, d) => a + d[0], 0) / perDoc.length;
const sorted = perDoc.map(d => d[0]).sort((a, b) => a - b);
console.log(`   moyenne par document : ${(macro * 100).toFixed(1)}% bien placées | médiane ${(sorted[Math.floor(sorted.length / 2)] * 100).toFixed(1)}%`);
if (process.env.DETAIL) perDoc.sort((a, b) => a[0] - b[0]).slice(0, 10).forEach(d => console.log(`   ${(d[0] * 100).toFixed(0).padStart(3)}%  ${String(d[1]).padStart(5)} entrées  décalage ${d[3]}  ${d[2]}`));
