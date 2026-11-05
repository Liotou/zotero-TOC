/* eslint-disable no-undef */
// zotero-TOC : appui d'un modèle de langue pour les cas où la typographie ne
// tranche pas.
//
// Trois fournisseurs, repris de la mécanique déjà éprouvée dans Annota :
//   • ollama : modèle local, aucune clé, aucun envoi sur le réseau ;
//   • cli : Claude Code en ligne de commande, via l'abonnement déjà connecté ;
//   • mistral : API Mistral (ou tout point d'accès compatible OpenAI).
//
// Principe important : le modèle ne RÉDIGE jamais les titres. On lui soumet une
// liste numérotée de lignes réellement présentes dans le PDF, et il ne renvoie
// que des NUMÉROS de ligne assortis d'un niveau. Les intitulés, les pages et les
// coordonnées restent ceux extraits du fichier : un modèle ne peut donc pas
// inventer une section qui n'existe pas, ni fausser une destination.

var ZTOC_AI = (function () {
	"use strict";

	const SYSTEM = "Tu analyses la structure d'un document scientifique. "
		+ "On te donne des lignes numérotées extraites d'un PDF, avec leur page et "
		+ "leur taille de police. Tu dois désigner celles qui sont des TITRES DE "
		+ "SECTION, et leur niveau hiérarchique (1 = titre principal, 2 = "
		+ "sous-section, 3 = sous-sous-section). "
		+ "Écarte : titres courants répétés, en-têtes de revue, noms d'auteurs, "
		+ "affiliations, légendes de figures et de tableaux, notes de bas de page, "
		+ "mentions de copyright, et le corps du texte. "
		+ "Réponds UNIQUEMENT par un tableau JSON, sans commentaire ni bloc de "
		+ "code, de la forme [{\"i\":12,\"l\":1},{\"i\":18,\"l\":2}] où « i » est le "
		+ "numéro de ligne fourni et « l » le niveau. "
		+ "N'invente aucun numéro qui ne figure pas dans la liste.";

	function buildUserPrompt(lines, meta) {
		let head = "Document : « " + (meta.title || "sans titre") + " », "
			+ meta.pages + " pages. Taille du corps de texte : " + meta.bodySize + " pt.\n\n"
			+ "Lignes candidates :\n";
		let body = lines.map(l =>
			"[" + l.i + "] p" + (l.pageIndex + 1) + " " + l.size.toFixed(1) + "pt : " + l.text
		).join("\n");
		return head + body;
	}

	// Extrait le tableau JSON même si le modèle l'a enrobé de texte ou de balises.
	function parseReply(raw) {
		let arr = firstJSONObject(raw, "[", "]");
		if (!Array.isArray(arr)) throw new Error("réponse JSON inattendue");
		let out = [];
		for (let e of arr) {
			if (!e || typeof e !== "object") continue;
			let i = parseInt(e.i !== undefined ? e.i : e.index, 10);
			let l = parseInt(e.l !== undefined ? e.l : e.level, 10);
			if (!Number.isFinite(i)) continue;
			out.push({ i: i, l: Number.isFinite(l) ? Math.max(1, Math.min(6, l)) : 1 });
		}
		return out;
	}

	// ---- Fournisseurs ----

	async function callOpenAICompatible(cfg, system, user) {
		let headers = { "Content-Type": "application/json" };
		if (cfg.apiKey) headers["Authorization"] = "Bearer " + cfg.apiKey;
		let payload = {
			model: cfg.model,
			temperature: 0,
			stream: false,
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: user }
			]
		};
		let resp;
		try {
			resp = await Zotero.HTTP.request("POST", cfg.endpoint, {
				headers: headers,
				body: JSON.stringify(payload),
				responseType: "json",
				timeout: cfg.timeout || 120000
			});
		}
		catch (e) {
			let status = (e && e.xmlhttp) ? e.xmlhttp.status : "?";
			let raw = "";
			try { raw = e.xmlhttp ? e.xmlhttp.responseText : ""; } catch (e2) { /* ignore */ }
			let msg = "";
			try {
				let d = JSON.parse(raw);
				msg = (d && d.error && (d.error.message || d.error)) || (d && d.message) || "";
				if (typeof msg !== "string") msg = JSON.stringify(msg);
			}
			catch (e2) { /* pas du JSON */ }
			if (!msg) msg = String(raw).slice(0, 200);
			if (cfg.isOllama) {
				if (/not found/i.test(msg)) {
					msg += " : choisissez un modèle installé dans les préférences "
						+ "(l'étiquette compte : « llama3.1:8b », pas « llama3.1 »).";
				}
				else if (!status || status === 0) {
					msg = "Ollama injoignable : le service tourne-t-il ? (" + msg + ")";
				}
			}
			throw new Error("Modèle (HTTP " + status + ") " + msg);
		}
		let data = resp.response;
		let content = data && data.choices && data.choices[0]
			&& data.choices[0].message && data.choices[0].message.content;
		if (!content) throw new Error("Réponse vide du modèle");
		return content;
	}

	// Claude Code en local. Aucune clé : l'authentification est celle du CLI.
	async function callCLI(cfg, system, user) {
		let Subprocess;
		try {
			({ Subprocess } = ChromeUtils.importESModule(
				"resource://gre/modules/Subprocess.sys.mjs"));
		}
		catch (e) {
			throw new Error("Subprocess indisponible : " + (e.message || e));
		}
		let cmd = cfg.cliPath || "claude";
		let args = ["-p", "--output-format", "text"];
		if (cfg.cliModel) args.push("--model", cfg.cliModel);
		if (system) args.push("--append-system-prompt", system);

		// Répertoire neutre : évite de charger un CLAUDE.md de projet.
		let workdir;
		try { workdir = Zotero.getTempDirectory().path; } catch (e) { workdir = undefined; }

		let proc;
		try {
			proc = await Subprocess.call({
				command: cmd, arguments: args, workdir: workdir, stderr: "pipe"
			});
		}
		catch (e) {
			throw new Error("Impossible de lancer « " + cmd + " » : " + (e.message || e));
		}

		let killTimer = setTimeout(() => { try { proc.kill(); } catch (e) { /* ignore */ } }, 300000);
		try {
			await proc.stdin.write(user);
			await proc.stdin.close();
			let out = "", chunk;
			while ((chunk = await proc.stdout.readString()) !== "") out += chunk;
			let errText = "", ce;
			while ((ce = await proc.stderr.readString()) !== "") errText += ce;
			let { exitCode } = await proc.wait();
			if (exitCode !== 0) {
				throw new Error("CLI code " + exitCode + " : "
					+ (errText.trim() || "(pas de sortie d'erreur)").slice(0, 300));
			}
			if (!out.trim()) throw new Error("Réponse vide du CLI");
			return out;
		}
		finally {
			clearTimeout(killTimer);
		}
	}

	// ---- Point d'entrée ----

	// `candidates` : lignes soumises au modèle, chacune {i, pageIndex, size, text, y}
	// Rend la liste des titres retenus, dans l'ordre du document.
	async function refine(cfg, candidates, meta) {
		if (!candidates.length) return [];
		let user = buildUserPrompt(candidates, meta);
		let raw;
		if (cfg.provider === "cli") raw = await callCLI(cfg, SYSTEM, user);
		else raw = await callOpenAICompatible(cfg, SYSTEM, user);

		let picks = parseReply(raw);
		let byIndex = new Map();
		for (let c of candidates) byIndex.set(c.i, c);

		let out = [];
		let seen = new Set();
		for (let p of picks) {
			let c = byIndex.get(p.i);
			// Un numéro inconnu est ignoré : le modèle ne peut rien créer.
			if (!c || seen.has(p.i)) continue;
			seen.add(p.i);
			out.push({ title: c.text, level: p.l, pageIndex: c.pageIndex, y: c.y, score: 99 });
		}
		// Remettre dans l'ordre du document, quel que soit l'ordre de la réponse.
		out.sort((a, b) => (a.pageIndex - b.pageIndex) || (b.y - a.y));

		// Ramener le niveau minimal à 1 pour éviter un sommaire entièrement indenté.
		if (out.length) {
			let min = Math.min.apply(null, out.map(h => h.level));
			if (min > 1) for (let h of out) h.level = h.level - min + 1;
		}
		return out;
	}

	// ---- Sélection de la structure parmi des candidats annotés ----

	const SYSTEM_SELECT = "Tu reconstitues la table des matières d'un document "
		+ "(article, rapport, ouvrage). On te donne des lignes numérotées réellement "
		+ "présentes dans le document, avec leur page, leur taille de police et leur "
		+ "origine : T = retrouvée dans la table des matières imprimée du document "
		+ "(niveau imprimé indiqué), D = repérée comme titre par la mise en page, "
		+ "C = simple ligne plausible. "
		+ "Choisis les lignes qui sont de VRAIS TITRES de parties, chapitres, "
		+ "sections ou sous-sections, et donne leur niveau (1 = le plus haut). "
		+ "Les lignes T sont en principe fiables et donnent la hiérarchie ; garde-les "
		+ "sauf erreur manifeste, et ajoute les lignes D ou C qui sont des sous-titres "
		+ "véritables, au niveau qui convient sous leur chapitre. "
		+ "Écarte impérativement : exercices et questions numérotés, formules, notes "
		+ "et références bibliographiques, légendes de figures et de tableaux, titres "
		+ "courants répétés en haut de page, noms d'auteurs, affiliations, mentions "
		+ "d'éditeur, fragments de phrases du corps du texte. "
		+ "Un sommaire utile compte rarement plus d'un titre par page en moyenne. "
		+ "Réponds UNIQUEMENT par un tableau JSON, sans commentaire ni bloc de code, "
		+ "de la forme [{\"i\":12,\"l\":1},{\"i\":18,\"l\":2}]. "
		+ "N'invente aucun numéro qui ne figure pas dans la liste.";

	// `candidates` : [{ i, pageIndex, y, size, text, tags, tocLevel }]
	// Rend [{ title, level, pageIndex, y }] dans l'ordre du document.
	function buildSelectPrompt(candidates, meta) {
		let head = "Document : « " + (meta.title || "sans titre") + " », " + meta.pages
			+ " pages, corps de texte en " + meta.bodySize + " pt."
			+ (meta.hasToc ? " Une table des matières imprimée a été retrouvée." : " Aucune table des matières imprimée exploitable.")
			+ "\n\nLignes :\n";
		let body = candidates.map(c =>
			"[" + c.i + "] p" + (c.pageIndex + 1) + " " + (c.size || 0).toFixed(1) + "pt "
			+ c.tags.join("") + (c.tocLevel ? "(niv." + c.tocLevel + ")" : "")
			+ " : " + String(c.text).slice(0, 120)).join("\n");
		return head + body;
	}

	// Convertit la réponse du modèle en titres, en ne gardant que les numéros
	// réellement proposés.
	function picksToHeadings(raw, candidates) {
		let picks = parseReply(raw);
		let byI = new Map(candidates.map(c => [c.i, c]));
		let seen = new Set(), out = [];
		for (let p of picks) {
			let c = byI.get(p.i);
			if (!c || seen.has(p.i)) continue;
			seen.add(p.i);
			out.push({ title: c.text, level: p.l, pageIndex: c.pageIndex, y: c.y, size: c.size });
		}
		out.sort((a, b) => (a.pageIndex - b.pageIndex) || ((b.y || 0) - (a.y || 0)));
		if (out.length) {
			let min = Math.min.apply(null, out.map(h => h.level));
			if (min > 1) for (let h of out) h.level -= (min - 1);
		}
		return out;
	}

	async function selectOutline(cfg, candidates, meta) {
		if (!candidates.length) return [];
		let user = buildSelectPrompt(candidates, meta);
		let raw;
		if (cfg.provider === "cli") raw = await callCLI(cfg, SYSTEM_SELECT, user);
		else raw = await callOpenAICompatible(cfg, SYSTEM_SELECT, user);
		return picksToHeadings(raw, candidates);
	}

	// ---- Correction d'un sommaire proposé ----
	//
	// Plutôt que de reconstruire le sommaire à partir de centaines de lignes,
	// le modèle corrige celui que le plugin a déjà établi : lignes à retirer,
	// lignes à ajouter, niveaux à changer. Une réponse paresseuse ne change
	// alors presque rien, au lieu de tout vider ; et la tâche, plus simple, est
	// mieux réussie par un modèle moins puissant.

	const SYSTEM_EDIT = "Tu vérifies la table des matières qu'un logiciel a établie "
		+ "pour un document (article, rapport, ouvrage). On te donne des lignes "
		+ "numérotées réellement présentes dans le document, avec leur page, leur "
		+ "taille de police et leur origine : T = retrouvée dans la table des "
		+ "matières imprimée du document, D = repérée comme titre par la mise en page, "
		+ "C = simple ligne plausible. Les lignes marquées [RETENUE niv.N] forment "
		+ "le sommaire proposé, au niveau N. "
		+ "Corrige ce sommaire : RETIRE les lignes retenues qui ne sont pas de vrais "
		+ "titres de section (exercices et questions numérotés, formules, notes, "
		+ "références bibliographiques, légendes, titres courants répétés en haut de "
		+ "page, noms d'auteurs, affiliations, dédicaces, mentions d'éditeur, "
		+ "fragments de phrases). AJOUTE les lignes non retenues qui sont de vrais "
		+ "titres de section manquants. CHANGE le niveau d'une ligne retenue si la "
		+ "hiérarchie est fausse (1 = le plus haut). Ne touche pas à ce qui est juste : "
		+ "un sommaire déjà correct appelle une réponse vide. "
		+ "Réponds UNIQUEMENT par un objet JSON, sans commentaire ni bloc de code, de "
		+ "la forme {\"retirer\":[4,9],\"ajouter\":[{\"i\":12,\"l\":2}],"
		+ "\"niveaux\":[{\"i\":7,\"l\":1}]}. N'invente aucun numéro.";

	function buildEditPrompt(candidates, meta) {
		let head = "Document : « " + (meta.title || "sans titre") + " », " + meta.pages
			+ " pages, corps de texte en " + meta.bodySize + " pt."
			+ (meta.hasToc ? " Une table des matières imprimée a été retrouvée." : " Aucune table des matières imprimée exploitable.")
			+ " Sommaire proposé : " + candidates.filter(c => c.kept).length + " lignes retenues.\n\nLignes :\n";
		return head + candidates.map(c =>
			"[" + c.i + "] p" + (c.pageIndex + 1) + " " + (c.size || 0).toFixed(1) + "pt "
			+ c.tags.join("") + (c.kept ? " [RETENUE niv." + c.keptLevel + "]" : "")
			+ " : " + String(c.text).slice(0, 120)).join("\n");
	}

	// Premier objet JSON complet d'une réponse, en suivant l'équilibre des
	// accolades et en ignorant celles des chaînes. Un modèle ajoute volontiers
	// une phrase d'explication après son JSON, parfois avec ses propres
	// accolades : prendre « de la première à la dernière » échouerait alors.
	function firstJSONObject(raw, open, close) {
		open = open || "{"; close = close || "}";
		let s = String(raw || "");
		let start = s.indexOf(open);
		while (start !== -1) {
			let depth = 0, inStr = false, esc = false;
			for (let i = start; i < s.length; i++) {
				let c = s[i];
				if (inStr) {
					if (esc) esc = false;
					else if (c === "\\") esc = true;
					else if (c === '"') inStr = false;
					continue;
				}
				if (c === '"') inStr = true;
				else if (c === open) depth++;
				else if (c === close && --depth === 0) {
					try { return JSON.parse(s.slice(start, i + 1)); }
					catch (e) { break; }
				}
			}
			start = s.indexOf(open, start + 1);
		}
		throw new Error("réponse sans JSON lisible");
	}

	// Applique la correction. Rend { headings, removed, added, relevelled }.
	function applyEdit(raw, candidates) {
		let obj = firstJSONObject(raw);
		let byI = new Map(candidates.map(c => [c.i, c]));
		let num = (x) => parseInt(x && typeof x === "object" ? x.i : x, 10);
		let retirer = new Set((obj.retirer || []).map(num).filter(i => byI.has(i) && byI.get(i).kept));
		let niveaux = new Map();
		for (let n of (obj.niveaux || [])) {
			let i = num(n), l = parseInt(n.l, 10);
			if (byI.has(i) && byI.get(i).kept && l >= 1 && l <= 6) niveaux.set(i, l);
		}
		let ajouter = new Map();
		for (let n of (obj.ajouter || [])) {
			let i = num(n), l = parseInt(n.l, 10);
			if (byI.has(i) && !byI.get(i).kept) ajouter.set(i, (l >= 1 && l <= 6) ? l : 2);
		}
		let out = [];
		for (let c of candidates) {
			if (c.kept && !retirer.has(c.i)) {
				out.push({ title: c.text, level: niveaux.get(c.i) || c.keptLevel, pageIndex: c.pageIndex, y: c.y, size: c.size });
			}
			else if (ajouter.has(c.i)) {
				out.push({ title: c.text, level: ajouter.get(c.i), pageIndex: c.pageIndex, y: c.y, size: c.size });
			}
		}
		out.sort((x, y) => (x.pageIndex - y.pageIndex) || ((y.y || 0) - (x.y || 0)));
		return { headings: out, removed: retirer.size, added: ajouter.size, relevelled: niveaux.size };
	}

	async function editOutline(cfg, candidates, meta) {
		let user = buildEditPrompt(candidates, meta);
		let raw;
		if (cfg.provider === "cli") raw = await callCLI(cfg, SYSTEM_EDIT, user);
		else raw = await callOpenAICompatible(cfg, SYSTEM_EDIT, user);
		return applyEdit(raw, candidates);
	}

	// ---- Appariement d'un sommaire collé ----

	const SYSTEM_MATCH = "On te donne des intitulés recopiés du sommaire d'un "
		+ "document, et pour chacun une liste numérotée de lignes du document qui "
		+ "pourraient marquer le début de cette section. "
		+ "Choisis pour chaque intitulé le numéro de la ligne qui en marque le "
		+ "DÉBUT RÉEL. "
		+ "Attention : un titre de chapitre est très souvent répété en haut de "
		+ "chaque page (titre courant) ; ne choisis jamais une de ces répétitions, "
		+ "mais la première occurrence qui ouvre véritablement la section. "
		+ "Écarte de même les mentions du titre dans le corps du texte ou dans une "
		+ "table des matières imprimée. "
		+ "Si aucune ligne ne convient, mets null. "
		+ "Réponds UNIQUEMENT par un tableau JSON, sans commentaire ni bloc de "
		+ "code, de la forme [{\"e\":1,\"i\":42},{\"e\":2,\"i\":null}] où « e » est "
		+ "le numéro de l'intitulé et « i » celui de la ligne retenue.";

	// `questions` : [{ e, title, options: [{ i, page, text }] }]
	// Rend une Map e -> i (numéro de ligne retenu).
	async function matchTitles(cfg, questions) {
		if (!questions.length) return new Map();
		let user = questions.map(q =>
			"Intitulé " + q.e + " : « " + q.title + " »\n"
			+ q.options.map(o => "   [" + o.i + "] p" + (o.page + 1) + " : " + o.text).join("\n")
		).join("\n\n");

		let raw;
		if (cfg.provider === "cli") raw = await callCLI(cfg, SYSTEM_MATCH, user);
		else raw = await callOpenAICompatible(cfg, SYSTEM_MATCH, user);

		let arr;
		try { arr = parseAny(raw); }
		catch (e) { throw new Error("réponse du modèle illisible : " + (e.message || e)); }

		let out = new Map();
		let valides = new Map();
		for (let q of questions) valides.set(q.e, new Set(q.options.map(o => o.i)));
		for (let r of arr) {
			let e = parseInt(r.e, 10);
			let i = (r.i === null || r.i === undefined) ? null : parseInt(r.i, 10);
			if (!Number.isFinite(e) || i === null || !Number.isFinite(i)) continue;
			// Un numéro qui n'était pas proposé est rejeté : le modèle ne peut
			// désigner que des lignes réellement présentes dans le document.
			if (!valides.has(e) || !valides.get(e).has(i)) continue;
			out.set(e, i);
		}
		return out;
	}

	function parseAny(raw) {
		let arr = firstJSONObject(raw, "[", "]");
		if (!Array.isArray(arr)) throw new Error("tableau attendu");
		return arr;
	}

	return {
		editOutline: editOutline,
		buildEditPrompt: buildEditPrompt,
		applyEdit: applyEdit,
		SYSTEM_EDIT: SYSTEM_EDIT,
		selectOutline: selectOutline,
		buildSelectPrompt: buildSelectPrompt,
		picksToHeadings: picksToHeadings,
		SYSTEM_SELECT: SYSTEM_SELECT,
		matchTitles: matchTitles,
		refine: refine,
		parseReply: parseReply,
		buildUserPrompt: buildUserPrompt,
		SYSTEM: SYSTEM
	};
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZTOC_AI;
