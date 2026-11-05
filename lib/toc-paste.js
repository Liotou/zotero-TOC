/* eslint-disable no-undef */
// zotero-TOC : sommaire fourni par l'utilisateur.
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
//      occurrence venue : presque toujours un titre courant, jamais le vrai
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

	// Numérotation de tête : « 3. », « 2.1 », « IV. », « Chapitre 2 : ».
	// Les chiffres romains et les lettres n'en sont que s'ils sont suivis
	// d'une ponctuation (« IV. », « a) ») : sans cela, « Mix et DC » perdrait
	// son premier mot, pris pour le nombre 1009.
	const LEAD_NUM = /^\s*(?:(?:chapitre|chapter|partie|part|section|annexe|appendix)\s+)?(?:\d+(?:[.\-]\d+)*\s*[.)\-\u2013\u2014:]*|(?:[ivxlcdm]{1,7}|[a-z])\s*[.)\-\u2013\u2014:]+)\s+/i;

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
	// Mots qui, suivis d'un nombre, forment un intitulé et non un renvoi de
	// page : « Partie II », « Chapitre 3 », « Tome 1 ».
	const BARE = /^(?:chapitre|chapter|partie|part|livre|book|tome|volume|section|annexe|appendix|le[cç]on|lecture|module|unit[ée]?|s[ée]ance|session)$/i;
	const PART_WORD = /^(?:partie|part|livre|book|tome|volume)\b/i;

	// Sépare un intitulé de son numéro de page final. Rend null si la ligne
	// n'en porte pas. Un séparateur net (points de conduite, tabulation,
	// plusieurs espaces, barre) rend le renvoi certain ; un simple espace
	// exige davantage de précautions.
	function splitTrailing(text) {
		let m = /^(.*?\S)(\s*(?:\.{2,}|\u2026+|[\u00b7_]{2,}|\t+|\s{2,}|\s*[\/|]\s*)\s*|\s+)(\d{1,4}|[ivxlcdm]{1,7})\s*$/i.exec(text);
		if (!m) return null;
		let title = m[1].replace(/[\s.\u00b7\u2026_\/|:,;\u2013\u2014-]+$/, "").trim();
		let strong = /\.{2,}|\u2026|[\u00b7_]{2,}|\t|\s{2,}|[\/|]/.test(m[2]);
		let num = m[3];
		if (!title || !/\p{L}/u.test(title)) return null;
		if (BARE.test(title)) return null;
		if (/^\d+$/.test(num)) {
			let v = parseInt(num, 10);
			if (!strong && num.length === 4 && v > 1400 && v < 2200) return null;
			return { title: title, printed: v, roman: false };
		}
		// Chiffre romain : seulement avec un séparateur net, ou en minuscules
		// (folios des pages liminaires). Évite « Mix », « DC », « Partie II ».
		if (!strong && num !== num.toLowerCase()) return null;
		if (!strong && num.length > 4) return null;
		let v = romanToInt(num);
		if (isNaN(v) || v <= 0) return null;
		return { title: title, printed: v, roman: true };
	}

	function hasTrailingPage(text) { return !!splitTrailing(text); }

	// Rend [{ title, level, printed, roman }]
	function parsePasted(text) {
		let raw = String(text || "").replace(/\r\n?/g, "\n").split("\n");
		let rows = [];
		for (let line of raw) {
			if (!line.trim()) continue;
			let t = line.replace(/\t/g, "    ");
			let indent = (t.match(/^ */) || [""])[0].length;
			let body = t.trim();
			// Titres Markdown : le nombre de dièses donne le niveau.
			let md = /^(#{1,6})\s+/.exec(body);
			let mdLevel = md ? md[1].length : null;
			if (md) body = body.slice(md[0].length);
			// Puces : retirées, mais leur retrait reste un indice de niveau.
			body = body.replace(/^(?:[*\u2022\u25aa\u25e6\u2023\u00b7>]|[-\u2013\u2014](?=\s))\s*/, "");
			if (!body) continue;
			if (HEADER_LINE.test(body)) continue;
			rows.push({ text: body, indent: indent, md: mdLevel });
		}
		if (!rows.length) return [];

		// Un numéro de page seul sur sa ligne appartient à l'entrée qui précède.
		let joined = [];
		for (let r of rows) {
			let prev = joined[joined.length - 1];
			if (/^(?:\d{1,4}|[ivxlcdm]{1,7})$/i.test(r.text) && prev && !hasTrailingPage(prev.text)) {
				prev.text = prev.text + "  " + r.text;
				continue;
			}
			joined.push(r);
		}
		rows = joined;

		// Le recollage des entrées coupées ne vaut QUE si le sommaire collé est
		// paginé : sans numéros de page, toutes les lignes paraîtraient
		// « ouvertes » et fusionneraient en cascade en une seule entrée. Or un
		// sommaire recopié d'une page d'éditeur n'a très souvent aucun numéro.
		let avecPage = rows.filter(r => hasTrailingPage(r.text)).length;
		let pagine = avecPage >= Math.max(2, rows.length * 0.5);

		let merged = [];
		for (let i = 0; i < rows.length; i++) {
			let r = rows[i], next = rows[i + 1];
			let nextStartsEntry = next && (LEAD_NUM.test(next.text) || next.md !== null);
			let fuse = false;
			if (next && !nextStartsEntry && r.md === null && r.text.length < 160 && (r.fusions || 0) < 2) {
				if (pagine) fuse = !hasTrailingPage(r.text) && !BARE.test(r.text.replace(/\s+[\dIVXLC]+\.?$/i, ""))
					&& Math.abs(next.indent - r.indent) <= 4;
				// Sans pagination, seule une ponctuation ouverte signale la coupure.
				else fuse = /[:;,\u2013\u2014-]$/.test(r.text);
			}
			if (fuse) {
				rows[i + 1] = {
					text: (r.text + " " + next.text).replace(/[ ]+/g, " "),
					indent: r.indent, md: null, fusions: (r.fusions || 0) + 1
				};
				continue;
			}
			merged.push(r);
		}

		let entries = [];
		for (let r of merged) {
			let sp = splitTrailing(r.text);
			let title = sp ? sp.title : r.text.replace(/[\s.\u00b7\u2026_]+$/, "").trim();
			if (!title || tokens(title).length === 0) continue;
			entries.push({
				title: title, indent: r.indent, md: r.md,
				printed: sp ? sp.printed : null, roman: sp ? sp.roman : false
			});
		}
		if (!entries.length) return [];

		// Niveau : Markdown, puis numérotation pointée, puis retrait.
		let indents = Array.from(new Set(entries.map(e => e.indent))).sort((a, b) => a - b);
		let bands = [];
		for (let x of indents) {
			if (!bands.length || x - bands[bands.length - 1] > 1) bands.push(x);
		}
		let bandOf = (x) => { let k = 0; for (let i = 0; i < bands.length; i++) if (x >= bands[i]) k = i; return k; };
		for (let e of entries) {
			let m = /^\s*(\d+(?:\.\d+)+)\b/.exec(e.title);
			if (e.md) e.level = e.md;
			else if (m) e.level = Math.min(6, m[1].split(".").length);
			else e.level = Math.min(6, bandOf(e.indent) + 1);
		}
		// « Partie » coiffe les chapitres lorsque le retrait ne le dit pas.
		let parts = entries.filter(e => PART_WORD.test(e.title));
		if (parts.length && !entries.some(e => e.md)) {
			let partLevel = Math.min.apply(null, parts.map(e => e.level));
			let peers = entries.some(e => !PART_WORD.test(e.title) && e.level <= partLevel);
			// Seules les entrées qui suivent la première partie lui sont
			// subordonnées : une préface placée avant reste au premier niveau.
			let first = entries.indexOf(parts[0]);
			if (peers) entries.forEach((e, i) => {
				if (i > first && !PART_WORD.test(e.title)) e.level = Math.min(6, e.level + 1);
			});
		}
		let min = Math.min.apply(null, entries.map(e => e.level));
		if (min > 1) for (let e of entries) e.level -= (min - 1);

		return entries;
	}


	// ---- 2. Index du document ----

	// Construit la liste des lignes candidates, en marquant celles qui sont des
	// titres courants. On indexe aussi les paires de lignes consécutives : un
	// titre long est fréquemment coupé en deux dans le corps du document.
	function buildIndex(doc, runningHeads, excludePages) {
		let items = [];
		for (let p of doc.pages) {
			// Les pages de sommaire et d'index contiennent tous les intitulés :
			// les indexer reviendrait à « retrouver » chaque entrée sur sa propre
			// ligne de table des matières.
			if (excludePages && excludePages.has(p.pageIndex)) continue;
			let lines = p.lines;
			for (let i = 0; i < lines.length; i++) {
				let l = lines[i];
				if (!l.text || l.text.length < 2) continue;
				let push = (text, y, size) => {
					let k = key(text);
					if (!k) return;
					items.push({
						k: k, toks: tokens(text), text: text, font: l.font,
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
				sim: sim, text: it.text, running: it.running, size: it.size, font: it.font
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
	// `opts.entries` : entrées déjà structurées (sommaire lu dans le document),
	// qui dispensent d'analyser un texte collé.
	// `opts.excludePages` : pages à ne pas fouiller (sommaire, index).
	// `opts.placeUnmatched` : placer en tête de la page annoncée les entrées
	// introuvables dans le texte, lorsque le décalage de pagination est connu.
	function locate(pastedText, doc, runningHeads, bodySize, opts) {
		opts = opts || {};
		let entries = opts.entries || parsePasted(pastedText);
		if (!entries.length) return { headings: [], unmatched: [], entries: [], offset: null };

		let index = buildIndex(doc, runningHeads || new Set(), opts.excludePages);
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
				sim: c.sim,
				size: c.size,
				font: c.font
			});
		});

		let res = { headings: headings, unmatched: unmatched, offset: offset, entries: entries, index: index, perEntry: perEntry, keptIdx: keptIdx, placed: 0 };
		if (opts.placeUnmatched) placeRemaining(res, doc);
		return res;
	}

	// Une entrée introuvable dans le texte mais dont la page imprimée est
	// connue peut encore être placée : en tête de la page correspondante.
	// C'est moins précis qu'un appariement, mais bien meilleur qu'une absence.
	// Complète `res` sur place.
	function placeRemaining(res, doc) {
		if (res.offset === null || res.offset === undefined) return 0;
		let have = new Set(res.headings.map(h => h.title));
		let restants = [], placed = 0;
		for (let e of res.entries) {
			if (have.has(e.title)) continue;
			let pi = e.printed !== null && !e.roman ? (e.printed - 1) + res.offset : -1;
			let page = pi >= 0 ? doc.pages.find(p => p.pageIndex === pi) : null;
			if (!page) { restants.push(e.title); continue; }
			res.headings.push({
				title: e.title, level: e.level, pageIndex: pi,
				y: Math.round(page.viewTop || page.height || 792),
				score: 0, approx: true
			});
			placed++;
		}
		res.unmatched = restants;
		res.placed = (res.placed || 0) + placed;
		res.headings.sort((x, y) => (x.pageIndex - y.pageIndex) || (y.y - x.y));
		return placed;
	}

	return {
		locate: locate,
		parsePasted: parsePasted,
		placeRemaining: placeRemaining,
		splitTrailing: splitTrailing,
		buildIndex: buildIndex,
		candidatesFor: candidatesFor,
		_internals: { key: key, norm: norm, similarity: similarity, romanToInt: romanToInt }
	};
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZTOC_PASTE;
