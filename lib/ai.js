/* eslint-disable no-undef */
// zotero-TOC — appui d'un modèle de langue pour les cas où la typographie ne
// tranche pas.
//
// Trois fournisseurs, repris de la mécanique déjà éprouvée dans Annota :
//   • ollama  — modèle local, aucune clé, aucun envoi sur le réseau ;
//   • cli     — Claude Code en ligne de commande, via l'abonnement déjà connecté ;
//   • mistral — API Mistral (ou tout point d'accès compatible OpenAI).
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
		let s = String(raw || "").trim();
		s = s.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "");
		let start = s.indexOf("[");
		let end = s.lastIndexOf("]");
		if (start === -1 || end === -1 || end < start) throw new Error("réponse sans tableau JSON");
		let arr = JSON.parse(s.slice(start, end + 1));
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
					msg += " — choisissez un modèle installé dans les préférences "
						+ "(l'étiquette compte : « llama3.1:8b », pas « llama3.1 »).";
				}
				else if (!status || status === 0) {
					msg = "Ollama injoignable — le service tourne-t-il ? (" + msg + ")";
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

	return {
		refine: refine,
		parseReply: parseReply,
		buildUserPrompt: buildUserPrompt,
		SYSTEM: SYSTEM
	};
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZTOC_AI;
