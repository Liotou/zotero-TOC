/* eslint-disable no-undef */
// zotero-TOC : choix de la meilleure source de structure pour un PDF.
//
// La version 1 appliquait la même détection typographique à tous les
// documents. Sur un article, elle fonctionne. Sur un ouvrage, elle produit des
// sommaires de plusieurs centaines d'entrées où se mêlent exercices numérotés,
// formules, notes de fin et titres courants.
//
// Or un ouvrage contient presque toujours sa propre table des matières. La
// lire, puis retrouver chaque entrée dans le texte, donne un résultat bien plus
// fiable que n'importe quelle heuristique : c'est exactement ce que fait un
// lecteur humain. La détection typographique ne sert plus qu'en second
// recours, quand aucune table des matières exploitable n'existe.
//
// Ordre des sources :
//   1. table des matières imprimée, retrouvée dans le texte ;
//   2. détection typographique, élaguée si elle est trop dense.

var ZTOC_PIPELINE = (function () {
	"use strict";

	let DT = null, PASTE = null;
	function deps() {
		if (DT && PASTE) return;
		if (typeof ZTOC_DETECT !== "undefined") DT = ZTOC_DETECT;
		if (typeof ZTOC_PASTE !== "undefined") PASTE = ZTOC_PASTE;
		if ((!DT || !PASTE) && typeof require === "function") {
			DT = DT || require("./detect.js");
			PASTE = PASTE || require("./toc-paste.js");
		}
	}

	// ---- Lecture de la table des matières imprimée ----

	const TOC_TITLE = /^(?:(?:brief|detailed|full|short)\s+)?(?:table\s+des\s+mati[eè]res(?:\s+d[ée]taill[ée]e)?|sommaire(?:\s+d[ée]taill[ée])?|contents(?:\s+in\s+brief|\s+in\s+detail)?|table\s+of\s+contents|plan(?:\s+de\s+l'ouvrage)?)$/i;
	const LIST_TITLE = /^(?:(?:list(?:e)?|table|index)\s+(?:of|des)\s+(?:figures?|tables?|tableaux|illustrations?|graphiques?|encadr[ée]s|sch[ée]mas|abbreviations?|abr[ée]viations?|sigles))/i;
	// Entrée d'une liste de figures ou de tableaux : « Figure 7 … », « Tableau 3.2 … ».
	const NOT_ENTRY = /^(?:fig(?:ure)?|tab(?:le|leau)|graphique|encadr[ée]|illustration|planche|photo|sch[ée]ma|exhibit|box)\.?\s*[\dIVX]/i;
	// Mot générique isolé, reliquat d'un intitulé coupé (« Chapitre » seul).
	const BARE_WORD = /^(?:chapitre|chapter|partie|part|section|livre|book|tome|annexe|appendix)\s*[\dIVX]*\.?$/i;
	// Numéro de page final : arabe ou romain, après points de conduite ou espace.
	const TRAILING = /^(.*?\S)[\s.·…_]*\s((?:\d{1,4})|(?:[ivxlcdm]{1,7}))$/i;

	function romanToInt(r) {
		let map = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
		let s = r.toLowerCase(), total = 0;
		for (let i = 0; i < s.length; i++) {
			let v = map[s[i]], n = map[s[i + 1]] || 0;
			if (!v) return NaN;
			total += v < n ? -v : v;
		}
		return total;
	}

	function splitPage(text) {
		let m = TRAILING.exec(text.trim());
		if (!m) return null;
		// Certains éditeurs séparent l'intitulé du numéro par une barre ou un
		// tiret : on les retire avec les points de conduite.
		let num = m[2], title = m[1].replace(/[\s.\u00b7\u2026_\/|:\u2013\u2014-]+$/, "").trim();
		if (!title || !/\p{L}/u.test(title)) return null;
		if (/^\d+$/.test(num)) {
			let v = parseInt(num, 10);
			// Un intitulé qui finit par une année n'est pas un renvoi de page.
			if (num.length === 4 && v > 1400 && v < 2200 && !/\.{3,}/.test(text)) return null;
			return { title: title, printed: v, roman: false };
		}
		let v = romanToInt(num);
		if (isNaN(v) || v <= 0) return null;
		return { title: title, printed: v, roman: true };
	}

	// Le découpage en colonnes, indispensable pour lire un article à deux
	// colonnes, est nuisible sur une page de sommaire : les numéros alignés à
	// droite y forment une colonne à part, détachée de leurs intitulés. On
	// recolle donc, pour ces pages, les fragments qui partagent une ligne de base.
	function flatPage(page) {
		let ls = page.lines.slice().sort((a, b) => (b.y - a.y) || (a.x - b.x));
		let out = [];
		for (let l of ls) {
			// Tolérance plafonnée : sur un scan, la taille de police annoncée par
			// l'OCR est peu fiable, et deux lignes voisines fusionneraient.
			let tol = Math.max(1.5, Math.min(4, (l.size || 10) * 0.35));
			let cur = out[out.length - 1];
			if (cur && Math.abs(cur.y - l.y) <= tol) { cur.parts.push(l); continue; }
			out.push({ y: l.y, parts: [l] });
		}
		return {
			pageIndex: page.pageIndex, width: page.width, height: page.height, viewTop: page.viewTop,
			lines: out.map(o => {
				o.parts.sort((a, b) => a.x - b.x);
				let main = o.parts.reduce((a, b) => (b.text.length > a.text.length ? b : a));
				return {
					text: o.parts.map(x => x.text).join(" ").replace(/\s+/g, " ").trim(),
					x: o.parts[0].x, y: o.y, size: main.size, font: main.font
				};
			})
		};
	}

	// Une page d'index ressemble à une table des matières (des intitulés suivis
	// de numéros), mais ses renvois sont multiples et dans le désordre.
	// Signes d'un index : plusieurs renvois (« 12, 45 »), des plages (« 325-327 »),
	// ou une virgule juste avant le numéro (« Écriture, 321 »). Une table des
	// matières n'a qu'un renvoi par ligne, sans virgule.
	function looksLikeIndex(lines) {
		let signs = 0;
		for (let l of lines) {
			let t = l.text;
			if (/\d+\s*[,;]\s*\d+/.test(t)
				|| /\d+\s*[\u2013\u2014-]\s*\d+\s*(?:[,;]|$)/.test(t)
				|| /,\s*(?:\d+|[ivxlcdm]+)\s*$/i.test(t)
				|| /^\s*(?:see|voir)\b/i.test(t)) signs++;
		}
		return signs >= Math.max(3, lines.length * 0.2);
	}


	// Transforme les lignes d'une suite de pages de sommaire en entrées
	// { title, level, printed, roman }.
	function entriesFromPages(pages, runningHeads) {
		let rows = [];
		let stop = false;
		for (let p of pages) {
			if (stop) break;
			let h = p.height || 792;
			for (let l of p.lines) {
				let t = (l.text || "").trim();
				if (!t) continue;
				// Une liste des figures suit souvent la table des matières sur la
				// même page ou la suivante : elle marque la fin du sommaire.
				if (LIST_TITLE.test(t) && rows.length >= 3) { stop = true; break; }
				let rel = 1 - (l.y / h);
				// Titre courant, numéro de folio, intitulé « Sommaire » lui-même.
				if (/^[ivxlcdm\d]{1,6}$/i.test(t)) continue;
				if (TOC_TITLE.test(t)) continue;
				if ((rel < 0.07 || rel > 0.93) && t.length < 60) continue;
				if (runningHeads && runningHeads.has(runKey(t))) continue;
				rows.push({ text: t, x: l.x, size: l.size, font: l.font, page: p.pageIndex });
			}
		}

		// Recoller les intitulés coupés : une ligne sans renvoi, suivie d'une
		// ligne qui en porte un et ne commence pas une nouvelle entrée numérotée,
		// est le début de cette dernière.
		let raw = [];
		for (let i = 0; i < rows.length; i++) {
			let r = rows[i];
			let sp = splitPage(r.text);
			if (sp) { raw.push(Object.assign({}, r, sp)); continue; }
			let next = rows[i + 1];
			let nsp = next ? splitPage(next.text) : null;
			let nextNumbered = next && /^\s*(?:\d+(?:\.\d+)*|[IVXLC]+)[.)]?\s/.test(next.text);
			if (next && nsp && !nextNumbered && r.text.length < 140
				&& Math.abs(next.x - r.x) < (r.size || 10) * 2.5) {
				rows[i + 1] = Object.assign({}, next, {
					text: r.text + " " + next.text, x: r.x, size: Math.max(r.size, next.size)
				});
				continue;
			}
			// Intitulé sans renvoi : souvent une « Partie » qui regroupe des
			// chapitres. On le garde, sans page imprimée.
			if (r.text.length >= 3 && r.text.length < 120 && /\p{L}{3}/u.test(r.text)) {
				raw.push(Object.assign({}, r, { title: r.text, printed: null, roman: false }));
			}
		}

		// Niveaux : le retrait est le meilleur indice dans une table des
		// matières ; la numérotation pointée le confirme quand elle existe.
		let xs = raw.map(e => e.x).sort((a, b) => a - b);
		let tol = Math.max(4, median(raw.map(e => e.size || 10)) * 0.9);
		let bands = [];
		for (let x of xs) {
			if (!bands.length || x - bands[bands.length - 1].max > tol) bands.push({ min: x, max: x });
			else bands[bands.length - 1].max = x;
		}
		for (let e of raw) {
			let b = bands.findIndex(bd => e.x >= bd.min - 0.5 && e.x <= bd.max + 0.5);
			e.level = Math.min(4, (b < 0 ? 0 : b) + 1);
			let m = /^\s*(\d+(?:\.\d+)+)\b/.exec(e.title);
			if (m) e.level = Math.min(4, m[1].split(".").length);
		}
		// Un intitulé sans renvoi et non retiré (« Partie I ») coiffe la suite.
		let min = Math.min.apply(null, raw.map(e => e.level));
		for (let e of raw) e.level = Math.max(1, e.level - min + 1);

		return raw
			.filter(e => !NOT_ENTRY.test(e.title) && !BARE_WORD.test(e.title.trim()) && isWordy(e.title))
			.map(e => ({
				title: e.title, level: e.level, printed: e.printed, roman: e.roman,
				indent: e.level, tocPage: e.page
			}));
	}

	// Un intitulé véritable contient au moins un mot de trois lettres, et
	// surtout des lettres : écarte les débris de reconnaissance de caractères.
	function isWordy(t) {
		let letters = (t.match(/\p{L}/gu) || []).length;
		let visible = t.replace(/\s/g, "").length;
		return /\p{L}{3}/u.test(t) && letters >= visible * 0.6;
	}

	function median(arr) {
		if (!arr.length) return 10;
		let a = arr.slice().sort((x, y) => x - y);
		return a[Math.floor(a.length / 2)];
	}

	function runKey(text) {
		return String(text).toLowerCase()
			.normalize("NFD").replace(/[̀-ͯ]/g, "")
			.replace(/[^a-z0-9 ]+/g, " ")
			.replace(/\d+/g, " ").replace(/\b[ivxlcdm]{1,7}\b/g, " ")
			.replace(/\s+/g, " ").trim();
	}

	// Vraisemblance d'une liste d'entrées comme table des matières : assez
	// d'entrées paginées, des pages qui vont croissant, pas une liste de figures.
	function validateEntries(entries, titled) {
		let paged = entries.filter(e => e.printed !== null && !e.roman);
		// Certains sommaires n'impriment aucun numéro de page. S'ils sont
		// explicitement intitulés, on les retient : l'appariement par le texte
		// et l'ordre suffisent à placer leurs entrées.
		if (paged.length < 3) {
			if (titled && entries.length >= 4) return { ok: true, mono: 1, paged: entries.length * 0.5, unpaged: true };
			return { ok: false, why: "trop peu de renvois" };
		}
		let inc = 0;
		for (let i = 1; i < paged.length; i++) if (paged[i].printed >= paged[i - 1].printed) inc++;
		let mono = inc / Math.max(1, paged.length - 1);
		if (mono < 0.8) return { ok: false, why: "renvois dans le désordre (" + Math.round(mono * 100) + " %)" };
		let lists = entries.filter(e => NOT_ENTRY.test(e.title)).length;
		if (lists > entries.length * 0.4) return { ok: false, why: "liste de figures ou de tableaux" };
		return { ok: true, mono: mono, paged: paged.length };
	}

	// Repère les blocs de pages de sommaire et rend le plus riche qui soit
	// vraisemblable.
	function findPrintedToc(doc, runningHeads) {
		deps();
		let pages = doc.pages.map(flatPage);
		let candidates = DT._internals.findTocPages(pages);
		// Une page intitulée « Table des matières » compte, même peu dense.
		for (let p of pages) {
			if (p.lines.slice(0, 8).some(l => TOC_TITLE.test((l.text || "").trim()))) candidates.add(p.pageIndex);
		}
		// Écarter les listes de figures et les index explicites.
		for (let p of pages) {
			if (!candidates.has(p.pageIndex)) continue;
			let head = p.lines.slice(0, 6).map(l => (l.text || "").trim());
			if (head.some(t => LIST_TITLE.test(t)) || head.some(t => /^index$/i.test(t))) candidates.delete(p.pageIndex);
			else if (looksLikeIndex(p.lines.filter(l => (l.text || "").length > 3))) candidates.delete(p.pageIndex);
		}
		if (!candidates.size) return null;

		// Regrouper les pages consécutives (un sommaire court sur plusieurs pages).
		let sorted = Array.from(candidates).sort((a, b) => a - b);
		let blocks = [];
		for (let pi of sorted) {
			let b = blocks[blocks.length - 1];
			if (b && pi - b[b.length - 1] <= 1) b.push(pi);
			else blocks.push([pi]);
		}

		let best = null;
		for (let b of blocks) {
			let bp = pages.filter(p => b.indexOf(p.pageIndex) !== -1);
			let entries = entriesFromPages(bp, runningHeads);
			let titled = bp.some(p => p.lines.slice(0, 8).some(l => TOC_TITLE.test((l.text || "").trim())));
			let v = validateEntries(entries, titled);
			if (!v.ok) continue;
			if (!best || v.paged > best.validation.paged) best = { pages: b, entries: entries, validation: v };
		}
		return best;
	}

	// ---- Orchestration ----

	// `doc` vient de extract.js. Rend { headings, source, notes, stats }.
	function run(doc, opts) {
		deps();
		opts = opts || {};
		let notes = [];
		let heads = DT._internals.findRunningHeads(doc.pages);
		let census = DT._internals.styleCensus(doc.pages);
		let nPages = doc.pages.length;

		// 1. Table des matières imprimée.
		let toc = findPrintedToc(doc, heads);
		if (toc) {
			let exclude = new Set(toc.pages);
			// Les autres pages de sommaire ou d'index ne doivent pas non plus
			// servir de cible.
			for (let pi of DT._internals.findTocPages(doc.pages)) exclude.add(pi);
			let r = PASTE.locate(null, doc, heads, census.bodySize, {
				entries: toc.entries, excludePages: exclude, placeUnmatched: true
			});
			let found = r.headings.length;
			let total = toc.entries.length;
			if (found >= 3 && found >= total * 0.5) {
				notes.push("table des matières imprimée p. " + toc.pages.map(x => x + 1).join(", ")
					+ " : " + found + "/" + total + " entrées retrouvées"
					+ (r.offset !== null ? ", décalage " + r.offset : "")
					+ (r.placed ? ", dont " + r.placed + " placées d'après leur page" : ""));
				let det = DT.detect(doc);
				let agree = agreement(r.headings, det.headings);
				let typo = prune(det.headings, nPages, []);
				let variants = {
					sommaire: r.headings,
					typographie: typo
				};
				let merged = deepen(r.headings, det.headings, census, []);
				if (merged.length > r.headings.length) variants["sommaire+styles"] = merged;

				// Arbitrage. Si la typographie retrouve elle-même la plupart des
				// entrées de la table, les deux sources se confirment : la table
				// fait foi et les styles l'approfondissent. Sinon, l'une des deux
				// se trompe. La table a pu être mal lue (ouvrage collectif, mise en
				// page complexe) : la typographie l'emporte alors, à condition
				// qu'elle ne soit pas manifestement débordante.
				let choice;
				if (agree >= 0.7) choice = variants["sommaire+styles"] ? "sommaire+styles" : "sommaire";
				else if (det.headings.length < 500 && det.headings.length <= nPages * 1.2) choice = "typographie";
				else choice = variants["sommaire+styles"] ? "sommaire+styles" : "sommaire";
				if (opts.deepen === false && choice === "sommaire+styles") choice = "sommaire";
				notes.push("accord table/typographie : " + Math.round(agree * 100) + " % ; source retenue : " + choice);

				return {
					headings: variants[choice], source: choice, variants: variants,
					notes: notes, stats: { offset: r.offset, tocPages: toc.pages, unmatched: r.unmatched, agree: agree },
					aiCandidates: det.aiCandidates
				};
			}
			notes.push("table des matières imprimée écartée : " + found + "/" + total + " entrées retrouvées");
		}

		// 2. Détection typographique.
		let det = DT.detect(doc);
		// L'élagage ne concerne que les ouvrages : un article de vingt pages
		// compte légitimement deux ou trois intitulés par page.
		let headings = nPages >= 60 ? prune(det.headings, nPages, notes) : det.headings;
		return {
			headings: headings, source: "typographie", notes: notes,
			stats: det.stats, aiCandidates: det.aiCandidates
		};
	}

	// Part des entrées de la table, retrouvées par appariement exact, que la
	// détection typographique a repérées aussi au même endroit.
	function agreement(tocHeadings, detHeadings) {
		let exact = tocHeadings.filter(h => !h.approx);
		if (!exact.length) return 0;
		let hit = 0;
		for (let t of exact) {
			if (detHeadings.some(d => d.pageIndex === t.pageIndex
				&& Math.abs((d.y || 0) - (t.y || 0)) < Math.max(30, (t.size || 10) * 3))) hit++;
		}
		return hit / exact.length;
	}

	// ---- Approfondissement par les styles ----

	// Intitulé réduit à ses lettres, sans numérotation ni folio romain.
	function cle(t) {
		return String(t || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
			.replace(/^\s*(?:[\divxlcdm]+[.)]?\s+)+/i, "")
			.replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();
	}

	function styleKey(font, size) {
		return (font || "") + "|" + (Math.round((size || 0) * 2) / 2);
	}

	// La table imprimée ne liste souvent que les chapitres, quand le texte
	// compte aussi des sections. Mais chaque entrée retrouvée révèle le style
	// d'un vrai titre dans CE document : sa police et sa taille. On ne retient
	// alors, parmi les titres détectés par la typographie, que ceux qui portent
	// l'un de ces styles, au niveau que la table lui associe. Exercices,
	// formules et notes, composés dans le style du corps, restent dehors.
	function deepen(tocHeadings, detHeadings, census, notes) {
		let exact = tocHeadings.filter(h => !h.approx && h.font && h.size);
		if (exact.length < 3) return tocHeadings;
		let bodyKey = styleKey(census.bodyFont, census.bodySize);

		// Style -> niveau majoritaire dans la table imprimée.
		let votes = new Map();
		for (let h of exact) {
			let k = styleKey(h.font, h.size);
			if (k === bodyKey) continue;
			if (!votes.has(k)) votes.set(k, new Map());
			let v = votes.get(k);
			v.set(h.level, (v.get(h.level) || 0) + 1);
		}
		let levelOf = new Map();
		for (let [k, v] of votes) {
			let best = null, n = -1;
			for (let [lv, c] of v) if (c > n || (c === n && lv < best)) { best = lv; n = c; }
			levelOf.set(k, best);
		}
		if (!levelOf.size) return tocHeadings;

		// Les pages liminaires (titre, dédicace, préface) précèdent la première
		// entrée retrouvée : leurs lignes partagent parfois le style d'un titre,
		// mais n'appartiennent pas au corps de l'ouvrage.
		let debut = Math.min.apply(null, exact.map(h => h.pageIndex));
		let titres = new Set(tocHeadings.map(h => cle(h.title)));
		let added = [];
		for (let d of detHeadings) {
			let k = styleKey(d.font, d.size);
			if (!levelOf.has(k)) continue;
			if (d.pageIndex < debut) continue;
			// Un intitulé déjà présent dans la table, répété ailleurs (titre
			// courant mal reconnu, rappel en fin de chapitre), n'est pas ajouté.
			let c = cle(d.title);
			if (!c || titres.has(c) || [...titres].some(t => t.length >= 6 && (c.endsWith(t) || t.endsWith(c)))) continue;
			// Déjà présent dans la table : même page et position voisine.
			let dup = tocHeadings.some(t => t.pageIndex === d.pageIndex
				&& Math.abs((t.y || 0) - (d.y || 0)) < (d.size || 10) * 3);
			if (dup) continue;
			let lv = levelOf.get(k);
			// Un style de chapitre absent de la table est suspect (titre de
			// partie répété, page de garde) : on ne l'ajoute qu'au niveau le plus
			// profond connu de la table.
			if (lv === 1) continue;
			added.push({ title: d.title, level: Math.min(6, Math.max(lv, 1)), pageIndex: d.pageIndex, y: d.y, score: d.score, size: d.size, font: d.font, deep: true });
		}
		if (!added.length) return tocHeadings;
		notes.push(added.length + " intitulé(s) ajouté(s) d'après le style des titres de la table");
		let all = tocHeadings.concat(added);
		all.sort((a, b) => (a.pageIndex - b.pageIndex) || ((b.y || 0) - (a.y || 0)));
		return all;
	}

	// Un sommaire trop dense ne sert à rien : au-delà d'environ une entrée par
	// page, on retire le niveau le plus profond, et ainsi de suite. Le seuil
	// reste au-dessus de la densité des signets d'éditeur (0,7 par page en
	// moyenne sur les ouvrages mesurés) mais sous celle des détections qui
	// débordent sur les exercices et les notes.
	function prune(headings, nPages, notes) {
		let hs = headings.slice();
		let cap = Math.max(12, Math.round(nPages * 1.2));
		while (hs.length > cap) {
			let maxLevel = Math.max.apply(null, hs.map(h => h.level));
			if (maxLevel <= 1) break;
			let before = hs.length;
			hs = hs.filter(h => h.level < maxLevel);
			notes.push("niveau " + maxLevel + " retiré (" + (before - hs.length) + " entrées) : sommaire trop dense");
		}
		return hs;
	}

	// ---- Candidats soumis au modèle ----

	// Rassemble en une seule liste numérotée tout ce que les sources ont
	// proposé, avec l'origine de chaque ligne : le modèle arbitre ainsi entre
	// la table imprimée et la typographie, au lieu de recevoir l'une sans
	// l'autre. Chaque ligne existe réellement dans le document.
	function aiCandidates(result, max) {
		max = max || 600;
		let items = [];
		let add = (h, tag) => {
			let near = items.find(x => x.pageIndex === h.pageIndex
				&& Math.abs((x.y || 0) - (h.y || 0)) < Math.max(12, (h.size || 10) * 1.5));
			if (near) {
				if (near.tags.indexOf(tag) === -1) near.tags.push(tag);
				if (tag === "T") { near.text = h.title || h.text; near.tocLevel = h.level; }
				return;
			}
			items.push({
				pageIndex: h.pageIndex, y: h.y, size: h.size || 0,
				text: h.title || h.text, tags: [tag],
				tocLevel: tag === "T" ? h.level : null, score: h.score || 0
			});
		};
		let v = result.variants || {};
		(v.sommaire || (result.source === "sommaire" ? result.headings : [])).forEach(h => add(h, "T"));
		(v.typographie || (result.source === "typographie" ? result.headings : [])).forEach(h => add(h, "D"));
		(result.aiCandidates || []).forEach(h => add(h, "C"));

		// Plafonner en gardant d'abord ce que les sources ont retenu.
		if (items.length > max) {
			let rank = x => (x.tags.indexOf("T") !== -1 ? 2 : 0) + (x.tags.indexOf("D") !== -1 ? 1 : 0)
				+ ((result.headings || []).some(h => h.pageIndex === x.pageIndex && Math.abs((h.y || 0) - (x.y || 0)) < 12) ? 4 : 0);
			items = items.sort((a, b) => (rank(b) - rank(a)) || (b.score - a.score)).slice(0, max);
		}
		// Lignes déjà présentes dans le sommaire proposé, avec leur niveau.
		for (let h of result.headings || []) {
			let it = items.find(x => x.pageIndex === h.pageIndex
				&& Math.abs((x.y || 0) - (h.y || 0)) < Math.max(12, (h.size || 10) * 1.5));
			if (it) { it.kept = true; it.keptLevel = h.level; }
		}
		items.sort((a, b) => (a.pageIndex - b.pageIndex) || ((b.y || 0) - (a.y || 0)));
		return items.map((x, i) => Object.assign(x, { i: i + 1 }));
	}

	return {
		run: run,
		aiCandidates: aiCandidates,
		findPrintedToc: findPrintedToc,
		entriesFromPages: entriesFromPages,
		_internals: { splitPage: splitPage, validateEntries: validateEntries, prune: prune }
	};
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZTOC_PIPELINE;
