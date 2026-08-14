/* eslint-disable no-undef */
// zotero-TOC — détection typographique des titres.
//
// Fonction pure : prend les pages issues de extract.js, rend une liste de
// titres hiérarchisés. Aucune dépendance, donc directement testable hors Zotero.
//
// Principe : le corps de texte d'un document est, de très loin, le style le plus
// employé. Tout ce qui s'en écarte durablement — plus gros, autre fonte, court,
// isolé — est candidat. Les numérotations (« 3.2 Méthode ») et un lexique de
// sections usuelles viennent confirmer ou rattraper les cas où la typographie
// seule ne tranche pas.

var ZTOC_DETECT = (function () {
	"use strict";

	// Sections nommées, sans numéro, qu'on veut retenir même à taille égale.
	const KEYWORDS = new RegExp(
		"^(?:"
		+ "chapitre|chapter|partie|part|section|annexe|annexes|appendix|appendices"
		+ "|introduction|conclusion|conclusions|discussion|discussions"
		+ "|r[ée]sum[ée]|abstract|sommaire|table des mati[èe]res|contents"
		+ "|bibliographie|r[ée]f[ée]rences|references|works cited"
		+ "|remerciements|acknowledg(?:e)?ments|avant.propos|pr[ée]face|preface|foreword"
		+ "|m[ée]thodes?|methods?|methodology|m[ée]thodologie"
		+ "|r[ée]sultats?|results?|mat[ée]riel|materials and methods"
		+ "|glossaire|glossary|index|notes?|epilogue|[ée]pilogue|prologue"
		+ "|executive summary|synth[èe]se|recommandations|recommendations"
		+ ")\\b", "i");

	// « 1 », « 1.2 », « 1.2.3 », éventuellement suivi d'un point ou d'une parenthèse.
	const NUM_RE = /^(\d+(?:[.\-]\d+)*)[.)]?(?:\s+|$)/;
	const ROMAN_RE = /^([IVXLCDM]{1,7})[.)]\s+\S/;
	const LETTER_RE = /^([A-Z])[.)]\s+\S/;

	function normKey(s) {
		return String(s).toLowerCase()
			.replace(/[‘’“”]/g, "'")
			.replace(/\s+/g, " ")
			.replace(/[^\p{L}\p{N} ]/gu, "")
			.trim();
	}

	// ---- Nettoyage préalable ----

	// Repère les en-têtes / pieds de page récurrents pour les écarter : sans cela
	// le titre courant d'une revue deviendrait un titre de section sur chaque page.
	function findRunningHeads(pages) {
		let counts = new Map();
		let nPages = pages.length;
		for (let p of pages) {
			let seen = new Set();
			for (let l of p.lines) {
				let rel = relativeY(l, p);
				// Bande de marge volontairement large : les titres courants ne sont
				// pas collés au bord, et un seuil trop serré les laisse passer.
				// Ceux qui tombent malgré tout dans le corps sont rattrapés
				// plus bas, sur leur seule récurrence.
				if (rel > 0.18 && rel < 0.82) continue;
				// Retirer les chiffres, et non les remplacer : un livre numérote ses
				// pages à gauche au verso et à droite au recto, si bien qu'un même
				// titre courant produirait deux clés différentes et passerait sous
				// le seuil de récurrence.
				let k = runningKey(l.text);
				if (!k || k.length < 3) continue;
				if (seen.has(k)) continue;
				seen.add(k);
				counts.set(k, (counts.get(k) || 0) + 1);
			}
		}
		let threshold = Math.max(3, Math.ceil(nPages * 0.3));
		let out = new Set();
		for (let [k, n] of counts) if (n >= threshold) out.add(k);

		// Filet indépendant de la position : un même intitulé qui revient sur la
		// moitié des pages est un titre courant, où qu'il se trouve. Une vraie
		// section, elle, n'apparaît qu'une fois.
		let anywhere = new Map();
		for (let p of pages) {
			let seen = new Set();
			for (let l of p.lines) {
				let k = runningKey(l.text);
				if (!k || k.length < 3 || seen.has(k)) continue;
				seen.add(k);
				anywhere.set(k, (anywhere.get(k) || 0) + 1);
			}
		}
		let hard = Math.max(4, Math.ceil(nPages * 0.5));
		for (let [k, n] of anywhere) if (n >= hard) out.add(k);

		return out;
	}

	// Clé de comparaison des titres courants, insensible à la pagination.
	function runningKey(text) {
		return normKey(text).replace(/\d+/g, " ").replace(/\s+/g, " ").trim();
	}

	// Position verticale relative : 0 = haut de page, 1 = bas.
	function relativeY(line, page) {
		let h = page.height || 792;
		return 1 - ((line.y || 0) / h);
	}

	// Une page de table des matières imprimée produirait des dizaines de faux
	// titres : on l'identifie à ses lignes de renvoi (« Titre ...... 12 »).
	function findTocPages(pages) {
		let out = new Set();
		for (let p of pages) {
			let lines = p.lines.filter(l => l.text.length > 4);
			if (lines.length < 5) continue;
			let leaders = 0;
			for (let l of lines) {
				if (/\.{4,}\s*[ivxlcdm\d]+\s*$/i.test(l.text)) leaders++;
				else if (/\s{2,}\d{1,4}$/.test(l.text)) leaders++;
			}
			if (leaders >= Math.max(4, lines.length * 0.35)) out.add(p.pageIndex);
		}
		return out;
	}

	// ---- Profil typographique du document ----

	function styleCensus(pages) {
		let chars = new Map();     // "font|taille" -> nombre de caractères
		let fontChars = new Map(); // police -> nombre de caractères
		let fontLines = new Map(); // police -> nombre de lignes
		let fontLen = new Map();   // police -> longueur cumulée des lignes
		for (let p of pages) {
			for (let l of p.lines) {
				let k = l.font + "|" + (Math.round(l.size * 10) / 10);
				chars.set(k, (chars.get(k) || 0) + l.text.length);
				fontChars.set(l.font, (fontChars.get(l.font) || 0) + l.text.length);
				fontLines.set(l.font, (fontLines.get(l.font) || 0) + 1);
				fontLen.set(l.font, (fontLen.get(l.font) || 0) + l.text.length);
			}
		}
		let bodyKey = "", best = -1;
		for (let [k, n] of chars) if (n > best) { best = n; bodyKey = k; }
		let parts = bodyKey.split("|");
		let bodyFont = parts[0] || "";
		let bodyChars = fontChars.get(bodyFont) || 1;

		// Le gras n'est pas exposé par pdf.js sans rendu, mais un titre en gras
		// utilise une ressource de police distincte. Une police qui ne porte
		// qu'une petite part du texte, sur des lignes courtes et répétées, est
		// donc très probablement une police de titre.
		let headingFonts = new Set();
		for (let [f, n] of fontChars) {
			if (f === bodyFont) continue;
			let nLines = fontLines.get(f) || 0;
			let meanLen = nLines ? (fontLen.get(f) || 0) / nLines : 999;
			if (n < bodyChars * 0.2 && nLines >= 2 && meanLen < 100) headingFonts.add(f);
		}

		return {
			bodyFont: bodyFont,
			bodySize: parseFloat(parts[1]) || 10,
			headingFonts: headingFonts,
			totalChars: Array.from(chars.values()).reduce((a, b) => a + b, 0)
		};
	}

	// ---- Détection ----

	function looksLikeProse(text) {
		// Une phrase complète n'est pas un titre : elle se termine par un point et
		// contient plusieurs propositions.
		if (/[.;:!?]$/.test(text) && text.length > 90) return true;
		let words = text.split(/\s+/).length;
		return words > 14;
	}

	// Encarts juridiques et bandeaux d'éditeur : très fréquents en première page
	// des numérisations (JSTOR, Cairn…), et typographiquement indiscernables d'un
	// titre. On les écarte sur leur vocabulaire, seul indice fiable.
	const BOILERPLATE = new RegExp(
		"(?:https?://|www\\.|doi\\.org|jstor\\.org|/stable/"
		+ "|all use subject to|this content downloaded|downloaded from"
		+ "|terms (?:&|and) conditions|conditions g[ée]n[ée]rales"
		+ "|is collaborating with|not-for-profit|©|\\(c\\) 20\\d\\d"
		+ "|\\bISSN\\b|\\bISBN\\b|tous droits r[ée]serv[ée]s|all rights reserved"
		+ "|published by\\b|stable url|you may need to log in"
		+ ")", "i");

	function rejectLine(text) {
		if (!text) return true;
		if (text.length < 2) return true;
		if (text.length > 200) return true;
		// Essentiellement des chiffres, de la ponctuation ou une formule.
		let letters = (text.match(/\p{L}/gu) || []).length;
		if (letters < 2) return true;
		if (letters / text.length < 0.35) return true;
		// Un titre de section dépasse rarement la quinzaine de mots.
		if (text.split(/\s+/).length > 18) return true;
		if (BOILERPLATE.test(text)) return true;
		if (/@\S+\.\S+/.test(text) && text.length < 60) return true;
		// Légende de figure ou de tableau.
		if (/^(?:fig(?:ure)?|tab(?:le|leau)?|graphique|encadr[ée]|photo|source)\s*\.?\s*\d/i.test(text)) return true;
		return false;
	}

	function numbering(text) {
		let m = NUM_RE.exec(text);
		if (m) {
			let parts = m[1].split(/[.\-]/).filter(x => x.length);
			// « 2024 Rapport » : une année seule n'est pas une numérotation.
			if (parts.length === 1 && parts[0].length === 4 && +parts[0] > 1500) return null;
			if (parts.length > 6) return null;
			// Le reste doit ressembler à un intitulé.
			let rest = text.slice(m[0].length).trim();
			if (!rest || (rest.match(/\p{L}/gu) || []).length < 2) return null;
			return { depth: parts.length, kind: "num", rest: rest };
		}
		if (ROMAN_RE.test(text)) return { depth: 1, kind: "roman", rest: text.replace(ROMAN_RE, "").trim() };
		if (LETTER_RE.test(text)) return { depth: 2, kind: "letter", rest: text.replace(LETTER_RE, "").trim() };
		return null;
	}

	// Le vivier soumis au modèle doit rester d'une taille raisonnable : on garde
	// les plus prometteuses, puis on rétablit l'ordre du document et on numérote.
	function capPool(pool, max) {
		max = max || 350;
		let kept = pool;
		if (pool.length > max) {
			kept = pool.slice().sort((a, b) => b.score - a.score).slice(0, max);
		}
		kept = kept.slice().sort((a, b) => (a.pageIndex - b.pageIndex) || (b.y - a.y));
		return kept.map((c, i) => ({
			i: i + 1, pageIndex: c.pageIndex, y: Math.round(c.top),
			size: c.size, text: c.text
		}));
	}

	// Rend { headings, aiCandidates, stats }. `headings` = [{title, level, pageIndex, y, score}]
	function detect(doc, options) {
		options = options || {};
		let pages = doc.pages || [];
		if (!pages.length) return { headings: [], stats: { reason: "aucune page" } };

		let census = styleCensus(pages);
		let heads = findRunningHeads(pages);
		let tocPages = findTocPages(pages);
		let bodySize = census.bodySize || 10;

		let candidates = [];
		let pool = [];
		for (let p of pages) {
			if (tocPages.has(p.pageIndex)) continue;
			let lines = p.lines;
			for (let i = 0; i < lines.length; i++) {
				let l = lines[i];
				let text = l.text;
				if (rejectLine(text)) continue;
				let key = runningKey(text);
				if (heads.has(key)) continue;

				let ratio = l.size / bodySize;
				let diffFont = l.font !== census.bodyFont;
				let num = numbering(text);
				let kw = KEYWORDS.test(text);
				let prose = looksLikeProse(text);
				let upper = text === text.toUpperCase() && (text.match(/\p{L}/gu) || []).length > 3;

				// Un titre est presque toujours isolé : de l'espace au-dessus.
				let gapAbove = (i > 0) ? (lines[i - 1].y - l.y) : 999;
				let isolated = gapAbove > l.size * 1.6;

				let score = 0;
				if (ratio >= 1.6) score += 5;
				else if (ratio >= 1.3) score += 4;
				else if (ratio >= 1.15) score += 3;
				else if (ratio >= 1.06) score += 2;
				else if (ratio >= 0.97) score += 0;
				else score -= 3;                    // plus petit que le corps

				if (census.headingFonts.has(l.font)) score += 2;
				else if (diffFont) score += 0.5;
				if (num) score += 2.5;
				if (kw) score += 2;
				if (upper && text.length < 80) score += 1;
				if (isolated) score += 1;
				if (text.length < 70) score += 0.5;
				if (prose) score -= 3;
				if (/[,;]$/.test(text)) score -= 2;
				if (/^[a-zà-öø-ÿ]/.test(text) && !num) score -= 1.5;

				// Vivier plus large que le seuil de décision : c'est lui qu'on
				// soumet au modèle quand la typographie ne suffit pas. Le modèle
				// choisit PARMI ces lignes, il n'en rédige aucune.
				if (score >= 1.5) {
					pool.push({
						pageIndex: p.pageIndex, y: l.y, top: l.y + l.size,
						size: l.size, text: text, score: score
					});
				}

				if (score < 4) continue;

				candidates.push({
					pageIndex: p.pageIndex,
					y: l.y,
					top: l.y + l.size,
					size: l.size,
					font: l.font,
					text: text,
					num: num,
					kw: kw,
					score: score,
					lineIdx: i
				});
			}
		}

		if (!candidates.length) {
			return { headings: [], aiCandidates: capPool(pool), stats: { reason: "aucun candidat", bodySize: bodySize } };
		}

		// Recoller les titres qui tiennent sur deux lignes.
		let merged = [];
		for (let c of candidates) {
			let prev = merged[merged.length - 1];
			// Un titre long court sur deux lignes : même style, lignes voisines,
			// et la première ne se termine pas comme une phrase.
			let sameStyle = prev && Math.abs(prev.size - c.size) / Math.max(prev.size, c.size) < 0.15;
			if (prev && prev.pageIndex === c.pageIndex
				&& c.lineIdx === prev.lineIdx + 1
				&& sameStyle
				&& !c.num && prev.text.length + c.text.length < 200
				&& !/[.!?]$/.test(prev.text)) {
				prev.text = (prev.text + " " + c.text).replace(/\s+/g, " ");
				prev.lineIdx = c.lineIdx;
				continue;
			}
			merged.push(Object.assign({}, c));
		}

		// Attribution des niveaux.
		let numbered = merged.filter(c => c.num && c.num.kind === "num");
		let useNumbering = numbered.length >= Math.max(3, merged.length * 0.5);

		// Regrouper les tailles voisines : deux corps à 13,9 et 14,1 points sont le
		// même niveau, et un sommaire à six paliers n'aide personne à naviguer.
		let distinct = Array.from(new Set(merged.map(c => Math.round(c.size * 10) / 10)))
			.sort((a, b) => b - a);
		let bands = [];
		for (let s of distinct) {
			let band = bands[bands.length - 1];
			if (band && (band.ref - s) / band.ref < 0.06) band.sizes.push(s);
			else bands.push({ ref: s, sizes: [s] });
		}
		bands = bands.slice(0, 4);
		let bandOf = (size) => {
			let s = Math.round(size * 10) / 10;
			for (let i = 0; i < bands.length; i++) if (bands[i].sizes.indexOf(s) !== -1) return i + 1;
			return bands.length + 1;
		};

		for (let c of merged) {
			if (useNumbering && c.num && c.num.kind === "num") {
				c.level = Math.min(6, c.num.depth);
			}
			else {
				c.level = Math.min(6, bandOf(c.size));
			}
		}

		// Ramener le niveau minimal à 1 et supprimer les paliers vides.
		let used = Array.from(new Set(merged.map(c => c.level))).sort((a, b) => a - b);
		let remap = new Map();
		used.forEach((lv, i) => remap.set(lv, i + 1));
		for (let c of merged) c.level = Math.min(6, remap.get(c.level));

		// Doublons consécutifs (titre répété en tête de page).
		let out = [];
		for (let c of merged) {
			let prev = out[out.length - 1];
			if (prev && normKey(prev.title) === normKey(c.text)
				&& c.pageIndex - prev.pageIndex <= 1) continue;
			out.push({
				title: c.text,
				level: c.level,
				pageIndex: c.pageIndex,
				y: Math.round(c.top),
				score: Math.round(c.score * 10) / 10
			});
		}

		// Garde-fou : au-delà, la détection a manifestement ratissé trop large.
		let cap = options.maxHeadings || 500;
		if (out.length > cap) {
			let keep = out.slice().sort((a, b) => b.score - a.score).slice(0, cap);
			let keepSet = new Set(keep.map(h => h.pageIndex + "|" + h.title));
			out = out.filter(h => keepSet.has(h.pageIndex + "|" + h.title));
		}

		let density = out.length / Math.max(1, pages.length);
		let meanScore = out.reduce((a, h) => a + h.score, 0) / Math.max(1, out.length);

		return {
			headings: out,
			aiCandidates: capPool(pool),
			stats: {
				bodySize: bodySize,
				bodyFont: census.bodyFont,
				pages: pages.length,
				candidates: candidates.length,
				runningHeads: heads.size,
				tocPages: Array.from(tocPages),
				useNumbering: useNumbering,
				density: Math.round(density * 100) / 100,
				meanScore: Math.round(meanScore * 10) / 10
			}
		};
	}

	// Le résultat mérite-t-il d'être écrit tel quel, ou faut-il demander l'appui
	// d'un modèle ? Un sommaire trop maigre, trop dense ou peu assuré est suspect.
	function confidence(result) {
		let h = result.headings || [];
		let s = result.stats || {};
		if (h.length < 3) return { level: "faible", reason: "trop peu de titres détectés (" + h.length + ")" };
		if (s.density > 6) return { level: "faible", reason: "densité anormale (" + s.density + " titres par page)" };
		if (s.meanScore < 5) return { level: "moyenne", reason: "indices typographiques ténus" };
		if (h.length < 5 && s.pages > 40) return { level: "moyenne", reason: "document long mais peu de titres" };
		return { level: "bonne", reason: "" };
	}

	return {
		detect: detect,
		confidence: confidence,
		_internals: { numbering: numbering, normKey: normKey, styleCensus: styleCensus, findRunningHeads: findRunningHeads, findTocPages: findTocPages }
	};
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZTOC_DETECT;
