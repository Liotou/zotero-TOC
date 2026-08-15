/* eslint-disable no-undef */
// zotero-TOC — génération du sommaire d'un EPUB.
//
// Bien plus simple que le PDF : un EPUB est du XHTML, où les titres sont
// explicitement balisés <h1>…<h6>. Aucune heuristique typographique n'est
// nécessaire — la hiérarchie est donnée par l'auteur du fichier.
//
// Le lecteur de Zotero s'appuie sur epub.js, qui lit d'abord le document de
// navigation EPUB 3 (élément de manifeste portant properties="nav"), et à
// défaut le toc.ncx d'EPUB 2. On réécrit donc celui des deux qui fait foi.

var ZTOC_EPUB = (function () {
	"use strict";

	// ---- Utilitaires XML ----

	function esc(s) {
		return String(s)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
	}

	const ENTITIES = {
		amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
		laquo: "«", raquo: "»", eacute: "é", egrave: "è", agrave: "à",
		ccedil: "ç", ecirc: "ê", ocirc: "ô", ugrave: "ù", icirc: "î",
		rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", hellip: "…",
		mdash: "—", ndash: "–", oelig: "œ"
	};

	function decodeEntities(s) {
		return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, g) => {
			if (g[0] === "#") {
				let cp = g[1] === "x" || g[1] === "X"
					? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
				return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
			}
			return Object.prototype.hasOwnProperty.call(ENTITIES, g) ? ENTITIES[g] : m;
		});
	}

	function stripTags(html) {
		return decodeEntities(String(html).replace(/<[^>]*>/g, " "))
			.replace(/\s+/g, " ").trim();
	}

	// Résolution de chemin relative, à la façon d'une URL.
	function resolvePath(base, rel) {
		if (!base) return rel;
		let parts = base.split("/");
		parts.pop();
		for (let seg of rel.split("/")) {
			if (seg === "." || seg === "") continue;
			if (seg === "..") parts.pop();
			else parts.push(seg);
		}
		return parts.join("/");
	}

	// Chemin de `target` vu depuis le dossier de `fromFile`.
	function relativeTo(fromFile, target) {
		let a = fromFile.split("/"); a.pop();
		let b = target.split("/");
		while (a.length && b.length > 1 && a[0] === b[0]) { a.shift(); b.shift(); }
		return new Array(a.length).fill("..").concat(b).join("/");
	}

	// ---- Lecture de la structure ----

	async function openBook(bytes, ZIP, inflate) {
		let entries = ZIP.read(bytes);
		let get = (name) => entries.find(e => e.name === name);

		let container = get("META-INF/container.xml");
		if (!container) throw new Error("EPUB invalide : container.xml absent");
		let cx = ZIP.utf8Decode(await ZIP.readEntry(container, inflate));
		let m = /full-path\s*=\s*["']([^"']+)["']/i.exec(cx);
		if (!m) throw new Error("EPUB invalide : chemin de l'OPF introuvable");
		let opfPath = m[1];

		let opfEntry = get(opfPath);
		if (!opfEntry) throw new Error("EPUB invalide : OPF absent");
		let opf = ZIP.utf8Decode(await ZIP.readEntry(opfEntry, inflate));

		// Manifeste : id -> { href, type, properties }
		let manifest = {};
		let itemRe = /<item\b([^>]*)\/?>/gi, im;
		while ((im = itemRe.exec(opf)) !== null) {
			let a = im[1];
			let id = attr(a, "id"), href = attr(a, "href");
			if (!id || !href) continue;
			manifest[id] = {
				href: href,
				path: resolvePath(opfPath, decodePath(href)),
				type: attr(a, "media-type") || "",
				properties: attr(a, "properties") || ""
			};
		}

		// Ordre de lecture.
		let spine = [];
		let srefRe = /<itemref\b([^>]*)\/?>/gi, sm;
		while ((sm = srefRe.exec(opf)) !== null) {
			let idref = attr(sm[1], "idref");
			if (idref && manifest[idref]) spine.push(manifest[idref]);
		}

		let nav = null, ncx = null;
		for (let id of Object.keys(manifest)) {
			let it = manifest[id];
			if (!nav && it.properties.split(/\s+/).indexOf("nav") !== -1) nav = it;
			if (!ncx && it.type === "application/x-dtbncx+xml") ncx = it;
		}

		return { entries, opfPath, opf, manifest, spine, nav, ncx, get };
	}

	// La valeur doit être délimitée par le MÊME guillemet que celui qui l'ouvre :
	// un nom de fichier peut contenir une apostrophe (« L'invincible.htm »), et
	// une classe de caractères indifférenciée tronquerait la valeur au premier
	// caractère rencontré.
	function attr(attrs, name) {
		let re = new RegExp("\\b" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')", "i");
		let m = re.exec(attrs);
		if (!m) return null;
		return m[1] !== undefined ? m[1] : m[2];
	}

	// Les chemins d'un OPF sont des références d'URL : ils peuvent être encodés.
	function decodePath(href) {
		if (href.indexOf("%") === -1) return href;
		try { return decodeURIComponent(href); }
		catch (e) { return href; }
	}

	// Nombre d'entrées du sommaire actuel, tel qu'epub.js le verrait.
	async function countTOC(book, ZIP, inflate) {
		let src = book.nav || book.ncx;
		if (!src) return 0;
		let e = book.get(src.path);
		if (!e) return 0;
		let text;
		try { text = ZIP.utf8Decode(await ZIP.readEntry(e, inflate)); }
		catch (err) { return 0; }
		if (book.nav && src === book.nav) {
			let seg = /<nav\b[^>]*epub:type\s*=\s*["'][^"']*toc[^"']*["'][\s\S]*?<\/nav>/i.exec(text);
			return ((seg ? seg[0] : text).match(/<a\b[^>]*href/gi) || []).length;
		}
		return (text.match(/<navPoint\b/gi) || []).length;
	}

	// État des lieux, sans rien modifier.
	async function inspect(bytes, ZIP, inflate) {
		let book = await openBook(bytes, ZIP, inflate);
		return {
			tocEntries: await countTOC(book, ZIP, inflate),
			spine: book.spine.length,
			source: book.nav ? "nav" : (book.ncx ? "ncx" : "aucun")
		};
	}

	// ---- Détection des titres ----

	const H_RE = /<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1\s*>/gi;

	// Parcourt les documents du spine et relève leurs titres. Les ancres
	// manquantes sont ajoutées au passage : sans identifiant, un renvoi ne
	// pourrait viser que le début du chapitre.
	async function collectHeadings(book, ZIP, inflate) {
		let headings = [];
		let counter = 0;

		for (let doc of book.spine) {
			let entry = book.get(doc.path);
			if (!entry) continue;
			let html;
			try { html = ZIP.utf8Decode(await ZIP.readEntry(entry, inflate)); }
			catch (e) { continue; }

			let found = [];
			let m;
			H_RE.lastIndex = 0;
			while ((m = H_RE.exec(html)) !== null) {
				let text = stripTags(m[3]);
				if (!text || text.length > 300) continue;
				found.push({
					level: parseInt(m[1], 10),
					text: text,
					attrs: m[2],
					start: m.index,
					tagLen: m[0].length,
					openLen: m[0].indexOf(">") + 1
				});
			}
			if (!found.length) continue;

			// Injection des ancres, de la fin vers le début pour ne pas décaler
			// les positions déjà relevées.
			let changed = false;
			let out = html;
			for (let i = found.length - 1; i >= 0; i--) {
				let h = found[i];
				let existing = attr(h.attrs, "id");
				if (existing) { h.id = existing; continue; }
				let id = "ztoc-" + (++counter);
				h.id = id;
				let open = out.slice(h.start, h.start + h.openLen);
				let patched = open.replace(/>$/, ' id="' + id + '">');
				out = out.slice(0, h.start) + patched + out.slice(h.start + h.openLen);
				changed = true;
			}
			if (changed) ZIP.setEntry(book.entries, doc.path, ZIP.utf8Encode(out));

			for (let h of found) {
				headings.push({ level: h.level, text: h.text, path: doc.path, id: h.id });
			}
		}

		// Ramener le niveau minimal à 1 : un livre dont tous les titres sont des
		// <h2> ne doit pas produire un sommaire entièrement indenté.
		if (headings.length) {
			let min = Math.min.apply(null, headings.map(h => h.level));
			if (min > 1) for (let h of headings) h.level = h.level - min + 1;
		}
		return headings;
	}

	// ---- Construction du sommaire ----

	function toTree(headings) {
		let roots = [], stack = [];
		for (let h of headings) {
			let node = { title: h.text, href: h.href, children: [] };
			while (stack.length >= h.level) stack.pop();
			if (!stack.length) roots.push(node);
			else stack[stack.length - 1].children.push(node);
			stack.push(node);
		}
		return roots;
	}

	function buildNCX(headings, title, uid) {
		let order = 0;
		let render = (nodes, depth) => nodes.map((n) => {
			order++;
			let pad = "  ".repeat(depth + 2);
			return pad + '<navPoint id="ztocnp' + order + '" playOrder="' + order + '">\n'
				+ pad + '  <navLabel><text>' + esc(n.title) + '</text></navLabel>\n'
				+ pad + '  <content src="' + esc(n.href) + '"/>\n'
				+ (n.children.length ? render(n.children, depth + 1) : "")
				+ pad + '</navPoint>\n';
		}).join("");

		return '<?xml version="1.0" encoding="UTF-8"?>\n'
			+ '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n'
			+ '  <head>\n    <meta name="dtb:uid" content="' + esc(uid || "") + '"/>\n'
			+ '    <meta name="dtb:depth" content="3"/>\n'
			+ '    <meta name="dtb:totalPageCount" content="0"/>\n'
			+ '    <meta name="dtb:maxPageNumber" content="0"/>\n  </head>\n'
			+ '  <docTitle><text>' + esc(title || "Sommaire") + '</text></docTitle>\n'
			+ '  <navMap>\n' + render(toTree(headings), 0) + '  </navMap>\n</ncx>\n';
	}

	function buildNav(headings, title) {
		let render = (nodes, depth) => {
			let pad = "  ".repeat(depth + 3);
			return pad + "<ol>\n" + nodes.map(n =>
				pad + '  <li><a href="' + esc(n.href) + '">' + esc(n.title) + "</a>\n"
				+ (n.children.length ? render(n.children, depth + 2) : "")
				+ pad + "  </li>\n").join("") + pad + "</ol>\n";
		};
		return '<?xml version="1.0" encoding="utf-8"?>\n'
			+ '<!DOCTYPE html>\n'
			+ '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n'
			+ '  <head><title>' + esc(title || "Sommaire") + '</title></head>\n'
			+ '  <body>\n    <nav epub:type="toc" id="toc">\n'
			+ '      <h1>' + esc(title || "Sommaire") + "</h1>\n"
			+ render(toTree(headings), 0)
			+ "    </nav>\n  </body>\n</html>\n";
	}

	// ---- Écriture ----

	// Rend { bytes, count } ou lève une erreur.
	async function writeTOC(bytes, ZIP, inflate, options) {
		options = options || {};
		let book = await openBook(bytes, ZIP, inflate);
		if (!book.spine.length) throw new Error("EPUB sans ordre de lecture");

		let headings = await collectHeadings(book, ZIP, inflate);
		if (headings.length < 2) throw new Error("aucun titre balisé dans le contenu");

		// Cible : le document que le lecteur consulte réellement.
		let target = book.nav || book.ncx;
		let targetPath = target ? target.path : resolvePath(book.opfPath, "ztoc-nav.xhtml");

		for (let h of headings) {
			h.href = relativeTo(targetPath, h.path) + "#" + h.id;
		}

		let title = options.title || "Sommaire";
		let uid = (/<dc:identifier[^>]*>([^<]*)</i.exec(book.opf) || [])[1] || "";

		if (target === book.nav && book.nav) {
			ZIP.setEntry(book.entries, targetPath, ZIP.utf8Encode(buildNav(headings, title)));
		}
		else if (target === book.ncx && book.ncx) {
			ZIP.setEntry(book.entries, targetPath, ZIP.utf8Encode(buildNCX(headings, title, uid)));
		}
		else {
			// Ni l'un ni l'autre : on ajoute un document de navigation, et on le
			// déclare dans le manifeste.
			ZIP.setEntry(book.entries, targetPath, ZIP.utf8Encode(buildNav(headings, title)));
			let decl = '<item id="ztoc-nav" href="ztoc-nav.xhtml" '
				+ 'media-type="application/xhtml+xml" properties="nav"/>';
			let opf = book.opf.replace(/<\/manifest>/i, "  " + decl + "\n</manifest>");
			if (opf === book.opf) throw new Error("manifeste OPF non modifiable");
			ZIP.setEntry(book.entries, book.opfPath, ZIP.utf8Encode(opf));
		}

		// « mimetype » doit rester la toute première entrée de l'archive.
		let mi = book.entries.findIndex(e => e.name === "mimetype");
		if (mi > 0) {
			let [mt] = book.entries.splice(mi, 1);
			book.entries.unshift(mt);
		}

		return { bytes: ZIP.write(book.entries), count: headings.length };
	}

	return {
		inspect: inspect,
		writeTOC: writeTOC,
		openBook: openBook,
		collectHeadings: collectHeadings,
		_internals: { stripTags: stripTags, resolvePath: resolvePath, relativeTo: relativeTo }
	};
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZTOC_EPUB;
