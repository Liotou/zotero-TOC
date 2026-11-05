// Banc d'essai : node bench.mjs <books|articles> <N> <detect|pipeline> [DETAIL=1]
import { lib, readJSON, score, extract } from "./common.mjs";
const DT = lib("detect.js"), PIPE = lib("pipeline.js");
const [set = "books", nArg = "999", engine = "pipeline"] = process.argv.slice(2);
const gt = readJSON(set === "books" ? "books.json" : "articles.json");
const N = parseInt(nArg, 10), step = Math.max(1, Math.floor(gt.length / N));
const sample = gt.filter((_, i) => i % step === 0).slice(0, N);
let SP = 0, SR = 0, n = 0, rows = [], t0 = Date.now(), sources = {};
for (const g of sample) {
  let doc; try { doc = await extract(g.file); } catch { continue; }
  let det, src = "detect";
  if (engine === "pipeline") { const r = PIPE.run(doc, {}); det = r.headings; src = r.source; }
  else det = DT.detect(doc).headings;
  sources[src] = (sources[src] || 0) + 1;
  const s = score(det, g.toc); SP += s.P; SR += s.R; n++;
  rows.push(Object.assign(s, { f: g.file.split("/").pop().slice(0, 34), pages: g.pages, ref: g.toc.length, det: det.length, src }));
}
const F = rows.map(r => r.F).sort((a, b) => a - b), pc = x => (x * 100).toFixed(1) + "%";
console.log(`[${set} | ${engine}] docs ${n} | P ${pc(SP / n)} | R ${pc(SR / n)} | F1 médian ${pc(F[Math.floor(F.length / 2)])} | F1 moyen ${pc(F.reduce((a, b) => a + b, 0) / F.length)} | ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log("   sources :", JSON.stringify(sources));
if (process.env.DETAIL) rows.sort((a, b) => a.F - b.F).forEach(r => console.log(`   F${(r.F * 100).toFixed(0).padStart(3)} P${(r.P * 100).toFixed(0).padStart(3)} R${(r.R * 100).toFixed(0).padStart(3)} réf${String(r.ref).padStart(5)} dét${String(r.det).padStart(4)} ${String(r.pages).padStart(5)}p ${r.src.padEnd(16)} ${r.f}`));
