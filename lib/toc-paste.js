/* eslint-disable no-undef */
// zotero-TOC — sommaire fourni par l'utilisateur.
//
// L'utilisateur colle le sommaire imprimé du document (recopié de la page
// « Table des matières », du site de l'éditeur, d'une notice…). Le plugin ne
// fait alors plus de détection typographique : il RETROUVE chaque intitulé
// dans le texte du document, et pointe la destination sur l'endroit exact.
//
// Deux difficultés, qui sont tout l'objet de ce fichier :
//
//   1. Un intitulé de chapitre se répète souvent en TÊTE DE PAGE sur des
//      dizaines de pages. Une recherche naïve du texte renverrait la première
//      occurrence venue — presque toujours un titre courant, jamais le vrai
//      début du chapitre.
//
//   2. Les numéros de page imprimés ne sont PAS ceux du lecteur : un ouvrage
//      paginé après ses pages liminaires décale tout d'une vingtaine de pages.
//      Ce décalage est inconnu, mais il est constant : on l'estime.

var ZTOC_PASTE = (function () {
	"use strict";

	// ---- Normalisation ----

	function stripAccents(s) {
		try { return s.normalize("NFD").replace(/[̀-ͯ]/g, ""); }
		catch (e) { return s; }
	}

	// Numérotation de tête : « 3. », « 2.1 », « IV. », « Chapitre 2 — ».
	const LEAD_NUM = /^\s*(?:chapitre|chapter|partie|part|section|annexe|appendix)?\s*(?:\d+(?:[.\-]\d+)*|[ivxlcdm]{1,7}|[a-z])\s*[.)\-–—:]*\s+/i;

	function norm(s) {
		return stripAccents(String(s).toLowerCase())
			.replace(/[’‘]/g, "'")
			.replace(/[^a-z0-9' ]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	}

	// Clé de comparaison : sans accents, sans ponctuation, sans numérotation.
	function key(s) {
		return norm(String(s).replace(LEAD_NUM, ""));
	}

	function tokens(s) {
		return key(s).split(" ").filter(w => w.length > 2);
	}

	// ---- 1. Analyse du texte collé ----

	// Un renvoi de sommaire se termine par un numéro de page, arabe ou romain,
	// éventuellement précédé de points de conduite.
	const TRAILING_PAGE = /^(.*?)[\s.·•_\-]*\(?\s*(\d{1,4}|[ivxlcdm]{1,8})\s*\)?$/i;
	const HEADER_LINE = /^(?:table\s+des\s+mati[eè]res|sommaire|contents|table\s+of\s+contents|index)\s*$/i;

	// Un numéro de page final, et non un chiffre qui appartient au titre
	// (« Les années 1968 »). On exige donc un séparateur net ou des points.
	function hasTrailingPage(text) {
		let m = TRAILING_PAGE.exec(text);
		if (!m || !m[1].trim()) return false;
		let num = m[2];
		if (/^\d+$/.test(num)) {
			// Un titre finissant par une année n'est pas paginé.
			let v = parseInt(num, 10);
			if (num.length === 4 && v > 1400 && v < 2200) return false;
			return true;
		}
		return /^[ivxlcdm]{1,8}$/i.test(num) && !isNaN(romanToInt(num));
	}

	function romanToInt(r) {
		let map = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
		let s = r.toLowerCase(), total = 0;
		for (let i = 0; i < s.length; i++) {
			let v = map[s[i]];
			if (!v) return NaN;
			let n = map[s[i + 1]] || 0;
			total += v < n ? -v : v;
		}
		return total;
	}

	// Rend [{ title, level, printed, roman }]
	function parsePasted(text) {
		let raw = String(text || "").replace(/\r\n?/g, "\n").split("\n");
		let rows = [];
		for (let line of raw) {
			if (!line.trim()) continue;
			if (HEADER_LINE.test(line.trim())) continue;
			// L'indentation est un indice de niveau, à relever avant de trimer.
			let indent = (line.match(/^[ \t]*/) || [""])[0].replace(/\t/g, "    ").length;
			rows.push({ text: line.trim(), indent: indent });
		}
		if (!rows.length) return [];

		// Le recollage des entrées coupées ne vaut QUE si le sommaire collé est
		// paginé : sans numéros de page, toutes les lignes paraîtraient
		// « ouvertes » et fusionneraient en cascade en une seule entrée. Or un
		// sommaire recopié d'une page d'éditeur n'a très souvent aucun numéro.
		let avecPage = rows.filter(r => hasTrailingPage(r.text)).length;
		let pagine = avecPage >= Math.max(2, rows.length * 0.5);

		let merged = [];
		if (!pagine) {
			// Une ligne se terminant par une ponctuation ouverte reste recollée :
			// c'est le seul indice fiable en l'absence de pagination.
			for (let i = 0; i < rows.length; i++) {
				let r = rows[i], next = rows[i + 1];
				if (next && /[:;,–—-]$/.test(r.text) && !LEAD_NUM.test(next.text)
					&& r.text.length < 120) {
					rows[i + 1] = {
						text: (r.text + " " + next.text).replace(/\s+/g, " "),
						indent: r.indent
					};
					continue;
				}
				merged.push(r);
			}
		}
		else {
			for (let i = 0; i < rows.length; i++) {
				let r = rows[i];
				let next = rows[i + 1];
				let nextStartsEntry = next && LEAD_NUM.test(next.text);
				// Au plus deux recollages successifs : au-delà, c'est que
				// l'hypothèse de pagination était fausse pour ce passage.
				if (!hasTrailingPage(r.text) && next && !nextStartsEntry
					&& r.text.length < 160 && (r.fusions || 0) < 2) {
					rows[i + 1] = {
						text: (r.text + " " + next.text).replace(/\s+/g, " "),
						indent: r.indent,
						fusions: (r.fusions || 0) + 1
					};
					continue;
				}
				merged.push(r);
			}
		}

		let entries = [];
		for (let r of merged) {
			let title = r.text, printed = null, roman = false;
			let m = TRAILING_PAGE.exec(r.text);
			if (m && m[1].trim()) {
				let num = m[2];
				if (/^\d+$/.test(num)) printed = parseInt(num, 10);
				else {
					let v = romanToInt(num);
					// Un mot comme « mix » ou « civil » ne doit pas passer pour un
					// chiffre romain : on exige que le reste du titre existe.
					if (!isNaN(v) && v > 0 && num.length <= 6) { printed = v; roman = true; }
				}
				if (printed !== null) title = m[1];
			}
			title = title.replace(/[\s.·•_]+$/, "").trim();
			if (!title || tokens(title).length === 0) continue;
			entries.push({ title: title, indent: r.indent, printed: printed, roman: roman });
		}

		// Niveau : la numérotation prime, l'indentation sert de repli.
		let indents = Array.from(new Set(entries.map(e => e.indent))).sort((a, b) => a - b);
		for (let e of entries) {
			let m = /^\s*(\d+(?:[.\-]\d+)*)/.exec(e.title);
			if (m && m[1].indexOf(".") !== -1) {
				e.level = Math.min(6, m[1].split(/[.\-]/).filter(x => x).length);
			}
			else {
				e.level = Math.min(6, indents.indexOf(e.indent) + 1);
			}
		}
		let min = Math.min.apply(null, entries.map(e => e.level));
		if (min > 1) for (let e of entries) e.level -= (min - 1);

		return entries;
	}

	// ---- 2. Index du document ----

	// Construit la liste des lignes candidates, en marquant celles qui sont des
	// titres courants. On indexe aussi les paires de lignes consécutives : un
	// titre long est fréquemment coupé en deux dans le corps du document.
	function buildIndex(doc, runningHeads) {
		let items = [];
		for (let p of doc.pages) {
			let lines = p.lines;
			for (let i = 0; i < lines.length; i++) {
				let l = lines[i];
				if (!l.text || l.text.length < 2) continue;
				let push = (text, y, size) => {
					let k = key(text);
					if (!k) return;
					items.push({
						k: k, toks: tokens(text), text: text,
						pageIndex: p.pageIndex, y: y, top: y + size, size: size,
						running: runningHeads.has(runKey(text)),
						rel: 1 - (y / (p.height || 792))
					});
				};
				push(l.text, l.y, l.size);
				let n = lines[i + 1];
				if (n && n.text && Math.abs(n.size - l.size) / Math.max(n.size, l.size) < 0.2
					&& (l.text.length + n.text.length) < 200) {
					push(l.text + " " + n.text, l.y, l.size);
				}
			}
		}
		return items;
	}

	function runKey(text) {
		return norm(text).replace(/\d+/g, " ")
			.replace(/\b[ivxlcdm]{1,7}\b/g, " ")
			.replace(/\s+/g, " ").trim();
	}

	// ---- 3. Appariement ----

	// Similarité entre l'intitulé collé et une ligne du document.
	function similarity(entryKey, entryToks, item) {
		if (!entryKey || !item.k) return 0;
		if (entryKey === item.k) return 1;
		if (item.k.startsWith(entryKey) && entryKey.length >= 8) return 0.94;
		if (entryKey.startsWith(item.k) && item.k.length >= 8) return 0.9;
		if (item.k.indexOf(entryKey) !== -1 && entryKey.length >= 10) return 0.85;
		if (!entryToks.length) return 0;
		let set = new Set(item.toks);
		let hit = 0;
		for (let t of entryToks) if (set.has(t)) hit++;
		let cover = hit / entryToks.length;
		if (cover < 0.6) return 0;
		// Une ligne très longue qui contient les mots par hasard vaut moins.
		let precision = hit / Math.max(1, item.toks.length);
		return 0.5 + 0.3 * cover + 0.15 * precision;
	}

	// Décalage entre pagination imprimée et pages du lecteur, estimé sur les
	// appariements les plus sûrs. C'est ce qui permet ensuite de départager
	// un vrai titre d'un titre courant portant le même texte.
	function estimateOffset(entries, index, bodySize) {
		let deltas = [];
		for (let e of entries) {
			if (e.printed === null || e.roman) continue;
			let k = key(e.title), tk = tokens(e.title);
			let best = null;
			for (let it of index) {
				if (it.running) continue;
				let s = similarity(k, tk, it);
				if (s < 0.9) continue;
				if (best && best.s >= s) continue;
				best = { s: s, it: it };
			}
			if (best && best.it.size >= bodySize * 0.98) {
				deltas.push(best.it.pageIndex - (e.printed - 1));
			}
		}
		if (deltas.length < 2) return null;
		deltas.sort((a, b) => a - b);
		return deltas[Math.floor(deltas.length / 2)];
	}

	// Rend, pour chaque entrée, la liste de ses meilleurs emplacements possibles.
	function candidatesFor(entry, index, opts) {
		let k = key(entry.title), tk = tokens(entry.title);
		let out = [];
		for (let it of index) {
			let sim = similarity(k, tk, it);
			if (sim < 0.6) continue;
			let score = sim * 10;

			// Un titre courant n'est jamais le début d'une section.
			if (it.running) score -= 7;
			// Une ligne collée en haut ou en bas de page sent l'en-tête.
			if (it.rel < 0.06 || it.rel > 0.94) score -= 2;
			// Un vrai titre est au moins de la taille du corps, souvent plus.
			if (opts.bodySize) {
				let ratio = it.size / opts.bodySize;
				if (ratio >= 1.15) score += 2.5;
				else if (ratio >= 1.02) score += 1;
				else if (ratio < 0.9) score -= 2;
			}
			// Concordance avec la page annoncée par le sommaire imprimé.
			if (entry.printed !== null && opts.offset !== null && opts.offset !== undefined) {
				let attendu = (entry.printed - 1) + opts.offset;
				let ecart = Math.abs(it.pageIndex - attendu);
				if (ecart === 0) score += 6;
				else if (ecart === 1) score += 4;
				else if (ecart <= 3) score += 1.5;
				else if (ecart > 12) score -= 3;
			}
			out.push({
				pageIndex: it.pageIndex, y: Math.round(it.top), score: score,
				sim: sim, text: it.text, running: it.running, size: it.size
			});
		}
		out.sort((a, b) => b.score - a.score);
		// Dédoublonner par page : garder le meilleur emplacement de chaque page.
		let seen = new Set(), keep = [];
		for (let c of out) {
			if (seen.has(c.pageIndex)) continue;
			seen.add(c.pageIndex);
			keep.push(c);
			if (keep.length >= 8) break;
		}
		return keep;
	}

	// Choix global : un sommaire est ordonné, les destinations doivent l'être
	// aussi. On maximise le score total sous contrainte de pages croissantes,
	// ce qui élimine d'un coup les titres courants isolés en fin d'ouvrage.
	function chooseMonotonic(perEntry) {
		let n = perEntry.length;
		let best = [], from = [];
		for (let i = 0; i < n; i++) { best.push([]); from.push([]); }

		for (let i = 0; i < n; i++) {
			let cands = perEntry[i];
			for (let ci = 0; ci < cands.length; ci++) {
				let c = cands[ci];
				let bestPrev = 0, bestJ = -1, bestK = -1;
				for (let j = i - 1; j >= 0; j--) {
					for (let kk = 0; kk < perEntry[j].length; kk++) {
						if (perEntry[j][kk].pageIndex > c.pageIndex) continue;
						let v = best[j][kk];
						if (v === undefined) continue;
						if (v > bestPrev) { bestPrev = v; bestJ = j; bestK = kk; }
					}
					// Remonter au-delà de quelques entrées ne change plus rien.
					if (i - j > 12 && bestJ !== -1) break;
				}
				best[i][ci] = bestPrev + c.score;
				from[i][ci] = [bestJ, bestK];
			}
		}

		// Meilleure fin de chaîne.
		let bv = -Infinity, bi = -1, bc = -1;
		for (let i = 0; i < n; i++) {
			for (let ci = 0; ci < (best[i] || []).length; ci++) {
				if (best[i][ci] > bv) { bv = best[i][ci]; bi = i; bc = ci; }
			}
		}
		let chosen = new Array(n).fill(null);
		while (bi >= 0 && bc >= 0) {
			chosen[bi] = perEntry[bi][bc];
			let f = from[bi][bc];
			if (!f || f[0] < 0) break;
			bi = f[0]; bc = f[1];
		}
		return chosen;
	}

	// ---- Point d'entrée ----

	// `doc` vient de extract.js, `runningHeads` de detect.js.
	// Rend { headings, unmatched, offset, entries }.
	function locate(pastedText, doc, runningHeads, bodySize) {
		let entries = parsePasted(pastedText);
		if (!entries.length) return { headings: [], unmatched: [], entries: [], offset: null };

		let index = buildIndex(doc, runningHeads || new Set());
		let offset = estimateOffset(entries, index, bodySize || 10);

		let perEntry = entries.map(e =>
			candidatesFor(e, index, { bodySize: bodySize, offset: offset }));

		// Une entrée sans aucun candidat ne doit pas rompre la chaîne ordonnée :
		// on la met de côté et on la signale.
		let keptIdx = [], kept = [];
		let unmatched = [];
		entries.forEach((e, i) => {
			if (perEntry[i].length) { keptIdx.push(i); kept.push(perEntry[i]); }
			else unmatched.push(e.title);
		});

		let chosen = chooseMonotonic(kept);

		let headings = [];
		chosen.forEach((c, ci) => {
			let e = entries[keptIdx[ci]];
			if (!c) { unmatched.push(e.title); return; }
			headings.push({
				title: e.title,
				level: e.level,
				pageIndex: c.pageIndex,
				y: c.y,
				score: Math.round(c.score * 10) / 10,
				matched: c.text,
				sim: c.sim
			});
		});

		return { headings: headings, unmatched: unmatched, offset: offset, entries: entries, index: index, perEntry: perEntry, keptIdx: keptIdx };
	}

	return {
		locate: locate,
		parsePasted: parsePasted,
		buildIndex: buildIndex,
		candidatesFor: candidatesFor,
		_internals: { key: key, norm: norm, similarity: similarity, romanToInt: romanToInt }
	};
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZTOC_PASTE;
