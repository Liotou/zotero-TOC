// Évalue les sommaires écrits par le diagnostic dans les copies
// « .ztoc-diagnostic.pdf » d'un dossier, contre les signets d'éditeur.
// node score-copies.mjs <dossier>
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readJSON, score } from "./common.mjs";
const dir = process.argv[2];
const gt = readJSON("books.json");
const py = `import fitz,sys,json
print(json.dumps([[l,t,p] for l,t,p in fitz.open(sys.argv[1]).get_toc()],ensure_ascii=False))`;
let sum = 0, n = 0;
for (const f of fs.readdirSync(dir).filter(x => x.endsWith(".ztoc-diagnostic.pdf"))) {
  const base = f.replace(/\.ztoc-diagnostic\.pdf$/, "");
  const g = gt.find(x => path.basename(x.file).replace(/\.pdf$/i, "") === base);
  if (!g) continue;
  const toc = JSON.parse(spawnSync("python3", ["-c", py, path.join(dir, f)], { encoding: "utf8" }).stdout);
  const det = toc.map(([l, t, p]) => ({ title: t, level: l, pageIndex: p - 1 }));
  const s = score(det, g.toc); sum += s.F; n++;
  console.log(`${base.slice(0, 34).padEnd(34)} F${String(Math.round(s.F * 100)).padStart(4)} P${String(Math.round(s.P * 100)).padStart(4)} R${String(Math.round(s.R * 100)).padStart(4)}  (${det.length} entrées)`);
}
if (n) console.log(`F1 moyen : ${(sum / n * 100).toFixed(1)}% sur ${n} ouvrages`);
