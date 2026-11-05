// Source retenue et accord table/typographie, par ouvrage.
import { lib, readJSON, extract } from "./common.mjs";
const PIPE = lib("pipeline.js");
for (const g of readJSON("books.json")) {
  const doc = await extract(g.file);
  const r = PIPE.run(doc, {});
  const agree = r.stats && typeof r.stats.agree === "number" ? r.stats.agree.toFixed(2) : "-";
  console.log([g.file.split("/").pop().slice(0, 32), r.source, agree].join("\t"));
}
