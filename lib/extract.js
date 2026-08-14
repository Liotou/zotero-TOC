/* eslint-disable no-undef */
// zotero-TOC — extraction des lignes de texte avec leur typographie.
//
// S'appuie sur pdf.js. Le module pdf.js n'est PAS importé ici : il est injecté
// par l'appelant, ce qui permet d'utiliser celui déjà embarqué dans Zotero
// (resource://zotero/reader/pdf/build/pdf.mjs) sans le dupliquer dans le XPI,
// et de faire tourner exactement le même code dans le harnais de test.

var ZTOC_EXTRACT = (function () {
	"use strict";

	// Deux fragments appartiennent à la même ligne si leurs lignes de base sont
	// distantes de moins d'une fraction de la hauteur de police.
	const BASELINE_TOL = 0.4;

	// Repère les gouttières verticales d'une page, c'est-à-dire les bandes en x
	// qu'aucun fragment ne traverse. Sans cela, sur une revue en deux colonnes,
	// « 1 Introduction » à gauche et le corps du texte à droite partagent la même
	// ligne de base et se retrouveraient collés dans une seule et même ligne.
	function findGutters(frags, pageWidth) {
		if (!pageWidth || frags.length < 40) return [];
		const BIN = 4;
		let nBins = Math.ceil(pageWidth / BIN);
		let occ = new Uint32Array(nBins + 1);
		for (let f of frags) {
			let a = Math.max(0, Math.floor(f.x / BIN));
			let b = Math.min(nBins, Math.ceil((f.x + Math.max(f.width, 1)) / BIN));
			for (let i = a; i < b; i++) occ[i]++;
		}
		// La gouttière n'est presque jamais RIGOUREUSEMENT vide : le titre courant
		// et le numéro de page la traversent en haut et en bas de page. Exiger une
		// occupation nulle reviendrait à ne jamais détecter les revues à deux
		// colonnes — précisément le cas le plus fréquent. On tolère donc une
		// occupation résiduelle proportionnelle à la densité de la page.
		let freeMax = Math.max(2, Math.floor(frags.length * 0.03));
		let minWidth = Math.max(3, Math.floor(pageWidth * 0.02 / BIN));
		let leftLimit = Math.floor(pageWidth * 0.12 / BIN);
		let rightLimit = Math.ceil(pageWidth * 0.88 / BIN);

		let candidates = [];
		let run = -1;
		for (let i = 0; i <= nBins; i++) {
			if (i < nBins && occ[i] <= freeMax) { if (run === -1) run = i; continue; }
			if (run !== -1) {
				let len = i - run;
				let mid = (run + i) / 2;
				if (len >= minWidth && mid > leftLimit && mid < rightLimit) {
					candidates.push({ start: run * BIN, end: i * BIN, mid: mid * BIN, len: len });
				}
				run = -1;
			}
		}

		// Une gouttière ne sépare quelque chose que si les deux côtés portent du
		// texte en quantité : sinon c'est une simple respiration dans la mise en
		// page, et découper dessus abîmerait les lignes.
		let gutters = candidates.filter((g) => {
			let left = 0, right = 0;
			for (let f of frags) {
				if (f.x + f.width <= g.start) left++;
				else if (f.x >= g.end) right++;
			}
			return left >= frags.length * 0.2 && right >= frags.length * 0.2;
		});

		// Au-delà de trois colonnes on est presque sûrement devant un tableau :
		// mieux vaut alors ne pas découper du tout.
		if (gutters.length > 2) return [];
		return gutters;
	}

	function columnOf(frag, gutters, pageWidth) {
		// Un élément qui traverse une gouttière court sur toute la largeur
		// (titre d'article, bandeau) : on le traite à part.
		for (let g of gutters) {
			if (frag.x < g.start && frag.x + frag.width > g.end) return -1;
		}
		let center = frag.x + frag.width / 2;
		let col = 0;
		for (let g of gutters) if (center > g.mid) col++;
		return col;
	}

	// Regroupe les fragments d'une page en lignes ordonnées.
	function groupIntoLines(items, viewOffsetY, pageWidth) {
		let frags = [];
		for (let it of items) {
			if (!it.str || !it.str.trim()) continue;
			if (it.transform && it.transform.length >= 6) {
				// Ignorer le texte pivoté : jamais un titre de section, et ses
				// coordonnées fausseraient le regroupement par ligne.
				let skewed = Math.abs(it.transform[1]) > 0.01 || Math.abs(it.transform[2]) > 0.01;
				if (skewed) continue;
				frags.push({
					text: it.str,
					x: it.transform[4],
					y: it.transform[5] + (viewOffsetY || 0),
					size: it.height || Math.abs(it.transform[3]) || 0,
					font: it.fontName || "",
					width: it.width || 0
				});
			}
		}
		if (!frags.length) return [];

		let gutters = findGutters(frags, pageWidth);

		// Regrouper par colonne, jamais d'une colonne à l'autre.
		let buckets = new Map();
		for (let f of frags) {
			let col = gutters.length ? columnOf(f, gutters, pageWidth) : 0;
			if (!buckets.has(col)) buckets.set(col, []);
			buckets.get(col).push(f);
		}

		let groupsByCol = new Map();
		for (let [col, list] of buckets) {
			list.sort((a, b) => (b.y - a.y) || (a.x - b.x));
			let lines = [];
			let cur = null;
			for (let f of list) {
				let tol = Math.max(1.2, (f.size || 10) * BASELINE_TOL);
				if (cur && Math.abs(cur.y - f.y) <= tol) {
					cur.frags.push(f);
					cur.y = (cur.y * cur.frags.length + f.y) / (cur.frags.length + 1);
				}
				else {
					if (cur) lines.push(cur);
					cur = { y: f.y, frags: [f], col: col };
				}
			}
			if (cur) lines.push(cur);
			groupsByCol.set(col, lines);
		}

		// Ordre de lecture. Les éléments pleine largeur (colonne -1) découpent la
		// page en bandes ; dans chaque bande on lit la colonne de gauche en
		// entier, puis la suivante — et non de gauche à droite ligne par ligne.
		let full = (groupsByCol.get(-1) || []).slice().sort((a, b) => b.y - a.y);
		let cols = Array.from(groupsByCol.keys()).filter(c => c >= 0).sort((a, b) => a - b);
		let ordered = [];
		if (!cols.length) {
			ordered = full;
		}
		else {
			// Bornes des bandes : de +∞ au premier élément pleine largeur, etc.
			let bounds = [Infinity].concat(full.map(f => f.y)).concat([-Infinity]);
			for (let bi = 0; bi < bounds.length - 1; bi++) {
				if (bi > 0) ordered.push(full[bi - 1]);
				let top = bounds[bi], bottom = bounds[bi + 1];
				for (let col of cols) {
					let inBand = (groupsByCol.get(col) || [])
						.filter(l => l.y < top && l.y > bottom)
						.sort((a, b) => b.y - a.y);
					for (let l of inBand) ordered.push(l);
				}
			}
		}

		return ordered.map((l) => {
			l.frags.sort((a, b) => a.x - b.x);
			// Recomposer le texte en réinsérant les espaces que le PDF n'encode
			// pas toujours (fragments juxtaposés avec un écart horizontal).
			let text = "";
			let prev = null;
			for (let f of l.frags) {
				if (prev) {
					let gap = f.x - (prev.x + prev.width);
					let ref = Math.max(1, (f.size || 10) * 0.2);
					if (gap > ref && !/\s$/.test(text) && !/^\s/.test(f.text)) text += " ";
				}
				text += f.text;
				prev = f;
			}
			// Le corps de la ligne est la police la plus « présente » en caractères.
			let byStyle = new Map();
			let maxSize = 0;
			for (let f of l.frags) {
				let key = f.font + "|" + round1(f.size);
				byStyle.set(key, (byStyle.get(key) || 0) + f.text.length);
				if (f.size > maxSize) maxSize = f.size;
			}
			let domKey = "", domN = -1;
			for (let [k, n] of byStyle) if (n > domN) { domN = n; domKey = k; }
			let [font, sizeStr] = domKey.split("|");

			return {
				text: normalizeSpace(text),
				x: l.frags[0].x,
				xEnd: l.frags[l.frags.length - 1].x + l.frags[l.frags.length - 1].width,
				y: l.y,
				col: l.col,
				size: parseFloat(sizeStr) || maxSize,
				maxSize: maxSize,
				font: font || "",
				nFrags: l.frags.length
			};
		}).filter(l => l.text.length > 0);
	}

	function round1(n) { return Math.round((n || 0) * 10) / 10; }

	function normalizeSpace(s) {
		return String(s)
			.replace(/­/g, "")          // trait d'union conditionnel
			.replace(/[​-‏]/g, "")
			.replace(/\s+/g, " ")
			.trim();
	}

	// Extrait toutes les pages. `pdfjs` est le module, `data` un Uint8Array.
	// `onProgress(done, total)` est optionnel.
	async function extractDocument(pdfjs, data, opts) {
		opts = opts || {};
		let loadingTask = pdfjs.getDocument({
			data: data,
			useWorkerFetch: false,
			isEvalSupported: false,
			useSystemFonts: false,
			disableFontFace: true,
			// Pas de rendu : inutile de charger polices et images.
			stopAtErrors: false
		});
		let doc = await loadingTask.promise;
		let pages = [];
		let total = doc.numPages;
		let limit = opts.maxPages && opts.maxPages > 0 ? Math.min(total, opts.maxPages) : total;

		try {
			for (let i = 1; i <= limit; i++) {
				let page = await doc.getPage(i);
				let view = page.view || [0, 0, 612, 792];
				let tc;
				try { tc = await page.getTextContent(); }
				catch (e) { tc = { items: [] }; }
				pages.push({
					pageIndex: i - 1,
					width: view[2] - view[0],
					height: view[3] - view[1],
					viewTop: view[3],
					lines: groupIntoLines(tc.items, 0, view[2] - view[0])
				});
				try { page.cleanup(); } catch (e) { /* sans importance */ }
				if (opts.onProgress) opts.onProgress(i, limit);
			}
		}
		finally {
			try { await loadingTask.destroy(); } catch (e) { /* sans importance */ }
		}
		return { pageCount: total, pages: pages };
	}

	return {
		extractDocument: extractDocument,
		groupIntoLines: groupIntoLines,
		normalizeSpace: normalizeSpace
	};
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZTOC_EXTRACT;
