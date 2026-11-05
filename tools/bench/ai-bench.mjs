// Apport du modèle : node ai-bench.mjs <books|articles> [motifs de fichiers...]
// Utilise Claude en ligne de commande, l'un des trois fournisseurs du plugin.
import { spawnSync } from "node:child_process";
import { lib, readJSON, score, extract } from "./common.mjs";
const DT = lib("detect.js"), PIPE = lib("pipeline.js"), AI = lib("ai.js");
let [set = "books", ...names] = process.argv.slice(2);
const MODE = process.env.MODE || "select";
const gt = readJSON(set === "books" ? "books.json" : "articles.json");
const pc = x => String(Math.round(x * 100)).padStart(3);
let sumD = 0, sumA = 0, n = 0;
for (const g of gt.filter(x => !names.length || names.some(m => x.file.includes(m)))) {
  const doc = await extract(g.file);
  const r = PIPE.run(doc, {});
  const cands = PIPE.aiCandidates(r);
  const census = DT._internals.styleCensus(doc.pages);
  const meta = { title: g.file.split("/").pop(), pages: doc.pages.length, bodySize: census.bodySize, hasToc: !!(r.stats && r.stats.tocPages) };
  const user = MODE === "edit" ? AI.buildEditPrompt(cands, meta) : AI.buildSelectPrompt(cands, meta);
  const system = MODE === "edit" ? AI.SYSTEM_EDIT : AI.SYSTEM_SELECT;
  const t0 = Date.now();
  const p = spawnSync("claude", ["-p", "--output-format", "text", "--model", "sonnet", "--append-system-prompt", system],
    { input: user, encoding: "utf8", maxBuffer: 5e7, cwd: "/tmp", timeout: 600000 });
  let ai = []; try { ai = MODE === "edit" ? AI.applyEdit(p.stdout, cands).headings : AI.picksToHeadings(p.stdout, cands); } catch (e) { console.log("   réponse illisible :", String(p.stdout || p.stderr).slice(0, 120)); }
  const d = score(r.headings, g.toc), a = score(ai, g.toc);
  sumD += d.F; sumA += a.F; n++;
  const agree = r.stats && typeof r.stats.agree === "number" ? r.stats.agree.toFixed(2) : "-";
  console.log(`${g.file.split("/").pop().slice(0, 32).padEnd(32)} ${r.source.padEnd(16)} acc.${agree} cand.${String(cands.length).padStart(4)} | sans F${pc(d.F)} P${pc(d.P)} R${pc(d.R)} (${r.headings.length}) | avec F${pc(a.F)} P${pc(a.P)} R${pc(a.R)} (${ai.length}) | ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
if (n) console.log(`\nF1 moyen sans modèle ${(sumD / n * 100).toFixed(1)}% | avec modèle ${(sumA / n * 100).toFixed(1)}% | ${n} documents`);
