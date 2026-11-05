/* eslint-disable no-undef */
// zotero-TOC : génère le sommaire manquant d'un PDF et l'inscrit dans le fichier,
// pour que le volet « Sommaire » du lecteur Zotero devienne utilisable.
//
// Chaîne de traitement, pour un PDF donné :
//   1. lecture de la structure du fichier (lib/pdf-lib.js) ;
//   2. si un sommaire existe déjà, on ne touche à rien ;
//   3. extraction des lignes avec leur typographie via le pdf.js de Zotero
//      (lib/extract.js) ;
//   4. détection des titres (lib/detect.js) ;
//   5. si le résultat est douteux, appui facultatif d'un modèle (lib/ai.js) ;
//   6. écriture du sommaire par mise à jour incrémentale (lib/pdf-lib.js).

var ZoteroTOC;

const PREF_BRANCH = "ztoc.";

function getPref(key, fallback) {
	let val = Zotero.Prefs.get(PREF_BRANCH + key);
	return (val === undefined || val === null) ? fallback : val;
}

function log(msg) {
	Zotero.debug("[zotero-TOC] " + msg);
}

function toRoman(n) {
	let table = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
		[50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
	let out = "";
	for (let [v, r] of table) while (n >= v) { out += r; n -= v; }
	return out;
}

function toast(title, body, type) {
	try {
		let pw = new Zotero.ProgressWindow({ closeOnClick: true });
		pw.changeHeadline(title);
		if (body) {
			let icon = type === "error"
				? "chrome://zotero/skin/cross.png"
				: "chrome://zotero/skin/tick.png";
			pw.addLines([body], [icon]);
		}
		pw.show();
		pw.startCloseTimer(type === "error" ? 8000 : 3500);
	}
	catch (e) {
		log("toast : " + e);
	}
}

ZoteroTOC = {
	id: null,
	version: null,
	rootURI: null,
	_windows: new Map(),
	_pdfjs: null,
	_busy: false,

	init({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
	},

	// Une fenêtre XUL ne s'instancie QUE depuis une URL « chrome:// » : chargée
	// directement depuis l'archive du plugin, elle reste vide. Il faut donc
	// déclarer un espace de noms chrome, comme le font les autres extensions.
	registerChrome() {
		try {
			let aomStartup = Components.classes[
				"@mozilla.org/addons/addon-manager-startup;1"
			].getService(Components.interfaces.amIAddonManagerStartup);
			let manifestURI = Services.io.newURI(this.rootURI + "manifest.json");
			this._chromeHandle = aomStartup.registerChrome(manifestURI, [
				["content", "zotero-toc", this.rootURI + "content/"]
			]);
			log("espace chrome enregistré");
		}
		catch (e) {
			this._chromeHandle = null;
			log("registerChrome : " + e);
		}
	},

	unregisterChrome() {
		try { if (this._chromeHandle) this._chromeHandle.destruct(); }
		catch (e) { /* sans importance */ }
		this._chromeHandle = null;
	},

	// ---- Chargement des modules internes ----

	loadModules() {
		if (this.mods) return this.mods;
		let scope = {};
		let loader = Services.scriptloader;
		for (let f of ["lib/pdf-lib.js", "lib/zip.js", "lib/epub.js",
			"lib/extract.js", "lib/detect.js", "lib/toc-paste.js", "lib/pipeline.js", "lib/ai.js"]) {
			loader.loadSubScript(this.rootURI + f, scope);
		}
		this.mods = {
			PDF: scope.ZTOC_PDF,
			EX: scope.ZTOC_EXTRACT,
			DT: scope.ZTOC_DETECT,
			AI: scope.ZTOC_AI,
			ZIP: scope.ZTOC_ZIP,
			EPUB: scope.ZTOC_EPUB,
			PASTE: scope.ZTOC_PASTE,
			PIPE: scope.ZTOC_PIPELINE
		};
		return this.mods;
	},

	// pdf.js est déjà présent dans Zotero (il fait tourner le lecteur) : on le
	// réutilise plutôt que d'alourdir le plugin de deux mégaoctets.
	//
	// Il doit impérativement être chargé depuis une FENÊTRE : son test interne de
	// plateforme lit « navigator », qui n'existe pas dans le contexte système des
	// modules privilégiés. Un chargement direct s'importe sans erreur mais échoue
	// au premier document ouvert.
	async getPdfjs() {
		if (this._pdfjs) return this._pdfjs;

		let win = null;
		try { win = Zotero.getMainWindow(); } catch (e) { win = null; }
		if (!win) {
			let wins = Zotero.getMainWindows();
			win = wins && wins.length ? wins[0] : null;
		}
		if (!win) throw new Error("aucune fenêtre Zotero ouverte : impossible de charger pdf.js");

		if (win.__ztocPdfjs) { this._pdfjs = win.__ztocPdfjs; return this._pdfjs; }

		let rootURI = this.rootURI;
		let mod = await new Promise((resolve, reject) => {
			let timer = win.setTimeout(
				() => reject(new Error("délai dépassé au chargement de pdf.js")), 20000);
			let done = (err) => {
				win.clearTimeout(timer);
				if (err) reject(err);
				else if (win.__ztocPdfjs) resolve(win.__ztocPdfjs);
				else reject(new Error("pdf.js chargé mais introuvable"));
			};
			try {
				win.addEventListener("ztoc-pdfjs-ready", () => done(null), { once: true });
				let doc = win.document;
				let script = doc.createElementNS("http://www.w3.org/1999/xhtml", "script");
				script.setAttribute("type", "module");
				script.setAttribute("src", rootURI + "lib/pdfjs-loader.mjs");
				script.addEventListener("error",
					() => done(new Error("chargement de pdfjs-loader.mjs refusé")));
				doc.documentElement.appendChild(script);
			}
			catch (e) { done(e); }
		});

		if (!mod || !mod.getDocument) throw new Error("pdf.js indisponible dans cette version de Zotero");
		this._pdfjsWindow = win;
		this._pdfjs = mod;
		return mod;
	},

	// Un seul processus de travail pdf.js pour tous les documents. pdf.js en
	// crée sinon un par document, que la fermeture ne libère pas toujours dans
	// Zotero : après quelques documents traités à la suite, pdf.js cessait de
	// répondre (constaté au 4e puis au 9e document d'une série).
	getPdfWorker(pdfjs) {
		if (this._pdfWorker && !this._pdfWorker.destroyed) return this._pdfWorker;
		try { this._pdfWorker = new pdfjs.PDFWorker({ name: "zotero-toc" }); }
		catch (e) { log("PDFWorker : " + e); this._pdfWorker = null; }
		return this._pdfWorker;
	},

	resetPdfWorker() {
		try { if (this._pdfWorker) this._pdfWorker.destroy(); } catch (e) { /* sans importance */ }
		this._pdfWorker = null;
	},

	// Extraction avec reprise : si pdf.js ne répond plus, son processus est
	// recréé et le document retenté une fois.
	async extractWithRetry(EX, bytes, opts) {
		let pdfjs = await this.getPdfjs();
		let essai = async () => EX.extractDocument(pdfjs, this.toWindowBytes(bytes),
			Object.assign({}, opts, { worker: this.getPdfWorker(pdfjs) }));
		try { return await essai(); }
		catch (e) {
			if (!/délai dépassé|ne répond plus/.test(String(e.message))) throw e;
			log("pdf.js ne répond plus : processus recréé, nouvel essai");
			this.resetPdfWorker();
			return await essai();
		}
	},

	// pdf.js vit dans le compartiment de la fenêtre : lui passer un tableau créé
	// ici peut être refusé. On recopie dans un tableau de SON compartiment.
	toWindowBytes(bytes) {
		let win = this._pdfjsWindow;
		if (!win || !win.Uint8Array) return bytes;
		try {
			let arr = new win.Uint8Array(bytes.length);
			arr.set(bytes);
			return arr;
		}
		catch (e) { return bytes; }
	},

	// ---- Réglages du modèle ----

	provider() {
		let p = String(getPref("provider", "off")).trim();
		return ["off", "mistral", "ollama", "cli"].includes(p) ? p : "off";
	},

	aiConfig() {
		let p = this.provider();
		if (p === "ollama") {
			return {
				provider: "ollama",
				isOllama: true,
				endpoint: String(getPref("ollamaEndpoint",
					"http://localhost:11434/v1/chat/completions")).trim(),
				model: String(getPref("ollamaModel", "llama3.1:8b")).trim() || "llama3.1:8b",
				apiKey: "",
				timeout: 300000
			};
		}
		if (p === "cli") {
			return {
				provider: "cli",
				cliPath: String(getPref("cliPath", "claude")).trim() || "claude",
				cliModel: String(getPref("cliModel", "")).trim()
			};
		}
		return {
			provider: "mistral",
			endpoint: String(getPref("endpoint",
				"https://api.mistral.ai/v1/chat/completions")).trim(),
			model: String(getPref("model", "mistral-large-latest")).trim()
				|| "mistral-large-latest",
			apiKey: String(getPref("apiKey", "")).trim(),
			timeout: 120000
		};
	},

	// Message d'erreur si le fournisseur choisi n'est pas utilisable, sinon null.
	aiReadyError() {
		let p = this.provider();
		if (p === "off") return "aucun modèle configuré";
		let cfg = this.aiConfig();
		if (p === "cli") return cfg.cliPath ? null : "chemin du CLI non renseigné";
		if (!cfg.endpoint) return "point d'accès non renseigné";
		if (p === "mistral" && !cfg.apiKey) return "clé API Mistral manquante";
		return null;
	},

	// Le modèle intervient dès que le résultat n'est pas confirmé par deux
	// sources pleinement concordantes : table imprimée ET typographie d'accord
	// sur au moins 95 % des entrées. Mesuré sur 28 ouvrages, ce seuil capte
	// presque tout le gain d'un arbitrage systématique (70,9 % de F1 contre
	// 71,2 %) avec un tiers d'appels en moins ; à 0,85, le gain retombait à
	// 67,4 %.
	shouldAskModel(result, mode) {
		if (mode === "never" || this.provider() === "off" || this.aiReadyError()) return false;
		if (mode === "always") return true;
		let confirme = /^sommaire/.test(result.source)
			&& result.stats && typeof result.stats.agree === "number" && result.stats.agree >= 0.95;
		return !confirme;
	},

	describeSource(result) {
		let src = {
			"sommaire": "table des matières imprimée",
			"sommaire+styles": "table des matières imprimée, approfondie par les styles",
			"typographie": "mise en page (aucune table des matières exploitable)"
		};
		let base = String(result.source || "").replace(/\+modèle$/, "");
		let txt = "Source : " + (src[base] || base);
		if (/\+modèle$/.test(result.source || "")) txt += ", arbitrée par le modèle";
		return txt;
	},

	// Quand solliciter le modèle : jamais, seulement en cas de doute, ou toujours.
	aiMode() {
		let m = String(getPref("aiMode", "auto")).trim();
		return ["never", "auto", "always"].includes(m) ? m : "auto";
	},

	// ---- Traitement d'une pièce jointe ----

	// Rend { status, message, count }. `status` ∈ ok | skipped | error.
	async processAttachment(item, opts) {
		opts = opts || {};
		let { PDF, EX, DT, AI, PIPE } = this.loadModules();
		let name = item.getField("title") || item.attachmentFilename || "(sans titre)";

		if (!item.isFileAttachment()) {
			return { status: "skipped", message: "n'est pas un fichier", name };
		}
		let type = item.attachmentContentType;
		if (type === "application/epub+zip") return this.processEPUB(item, opts, name);
		if (type !== "application/pdf") {
			return { status: "skipped", message: "n'est ni un PDF ni un EPUB", name };
		}
		if (item.library && item.library.editable === false) {
			return { status: "skipped", message: "bibliothèque en lecture seule", name };
		}

		let path;
		try { path = await item.getFilePathAsync(); }
		catch (e) { path = null; }
		if (!path) return { status: "skipped", message: "fichier absent du disque", name };

		let bytes;
		try { bytes = await IOUtils.read(path); }
		catch (e) { return { status: "error", message: "lecture impossible : " + e, name }; }

		let info;
		try { info = await PDF.inspect(bytes); }
		catch (e) { return { status: "error", message: "PDF illisible : " + (e.message || e), name }; }

		if (info.encrypted) {
			return { status: "skipped", message: "PDF protégé (chiffré)", name };
		}
		if (info.hasOutline && !opts.overwrite) {
			return { status: "skipped", message: "possède déjà un sommaire", name };
		}

		let built;
		try { built = await this.buildOutline(bytes, name, opts); }
		catch (e) {
			return { status: "error", message: "extraction du texte : " + (e.message || e), name };
		}
		let result = built.result, usedAI = built.usedAI;

		let headings = result.headings || [];
		if (headings.length < 2) {
			return {
				status: "skipped",
				message: "aucune structure de titres identifiable",
				name
			};
		}

		if (opts.preview) {
			let go = this.confirmHeadings(opts.window, name + "\n" + this.describeSource(result), headings, usedAI);
			if (!go) return { status: "skipped", message: "abandonné", name };
		}

		// Sauvegarde du fichier d'origine avant modification.
		if (getPref("keepBackup", true)) {
			try { await this.backup(path, item); }
			catch (e) { log("sauvegarde : " + e); }
		}

		let out;
		try { out = await PDF.writeOutline(bytes, headings); }
		catch (e) { return { status: "error", message: "écriture : " + (e.message || e), name }; }

		try {
			// Écriture atomique : le fichier n'est remplacé qu'une fois complet.
			await IOUtils.write(path, out, { tmpPath: path + ".ztoc-tmp" });
		}
		catch (e) {
			return { status: "error", message: "enregistrement : " + (e.message || e), name };
		}

		await this.afterWrite(item);

		return {
			status: "ok",
			count: headings.length,
			usedAI: usedAI,
			message: headings.length + " entrées" + (usedAI ? " (avec appui du modèle)" : ""),
			name
		};
	},

	// Cœur du traitement d'un PDF : extraction, choix de la source, arbitrage
	// éventuel par le modèle. Ne touche à aucun fichier : il sert aussi bien
	// au menu qu'au diagnostic, qui travaille sur des copies.
	async buildOutline(bytes, name, opts) {
		opts = opts || {};
		let { EX, DT, AI, PIPE } = this.loadModules();
		// Extraction du texte et de sa typographie.
		let doc;
		try {
			doc = await this.extractWithRetry(EX, bytes, {
				maxPages: parseInt(getPref("maxPages", 0), 10) || 0,
				onProgress: opts.onProgress
			});
		}
		catch (e) {
			throw new Error(e.message || e);
		}

		// Choix de la meilleure source : table des matières imprimée retrouvée
		// dans le texte, approfondie par les styles, ou détection typographique.
		let result = PIPE.run(doc, {});
		let usedAI = false;

		if (this.shouldAskModel(result, opts.forceAI ? "always" : this.aiMode())) {
			try {
				let census = DT._internals.styleCensus(doc.pages);
				let cands = PIPE.aiCandidates(result);
				let meta = {
					title: name, pages: doc.pages.length, bodySize: census.bodySize,
					hasToc: !!(result.stats && result.stats.tocPages)
				};
				let base = result.headings.length;
				let contrat = opts.aiContract || String(getPref("aiContract", "edit"));
				if (contrat === "select") {
					let chosen = await AI.selectOutline(this.aiConfig(), cands, meta);
					// Garde-fou : une réponse squelettique ne remplace pas un
					// sommaire déterministe fourni. Le modèle affine, il ne vide pas.
					if (chosen.length >= 3 && (base < 3 || chosen.length >= base * 0.3)) {
						result.notes.push("modèle : " + chosen.length + " entrées retenues sur "
							+ cands.length + " candidates (sans modèle : " + base + ")");
						result = Object.assign({}, result, { headings: chosen, source: result.source + "+modèle" });
						usedAI = true;
					}
					else result.notes.push("modèle : réponse écartée (" + chosen.length + " entrées)");
				}
				else {
					// Correction du sommaire proposé : retraits, ajouts, niveaux.
					let ed = await AI.editOutline(this.aiConfig(), cands, meta);
					result.notes.push("modèle : " + ed.removed + " retirée(s), " + ed.added
						+ " ajoutée(s), " + ed.relevelled + " niveau(x) corrigé(s)");
					if (ed.headings.length >= 3 && (ed.removed || ed.added || ed.relevelled)) {
						result = Object.assign({}, result, { headings: ed.headings, source: result.source + "+modèle" });
						usedAI = true;
					}
				}
			}
			catch (e) {
				log("modèle : " + (e.message || e));
				result.notes.push("modèle indisponible : " + String(e.message || e).slice(0, 120));
			}
		}
		log(name + " | source " + result.source + " | " + result.notes.join(" ; "));

		return { result: result, usedAI: usedAI, doc: doc };
	},

	// Un EPUB porte ses titres explicitement (<h1>…<h6>) : aucune heuristique
	// n'est nécessaire, seule la réécriture de l'archive demande du soin.
	// Un sommaire d'à peine quelques entrées (souvent « Démarrer » seul) est
	// traité comme absent : c'est le cas que le plugin est censé réparer.
	TOC_MINIMUM: 5,

	async processEPUB(item, opts, name) {
		let { PDF, ZIP, EPUB } = this.loadModules();

		if (item.library && item.library.editable === false) {
			return { status: "skipped", message: "bibliothèque en lecture seule", name };
		}
		let path;
		try { path = await item.getFilePathAsync(); }
		catch (e) { path = null; }
		if (!path) return { status: "skipped", message: "fichier absent du disque", name };

		let bytes;
		try { bytes = await IOUtils.read(path); }
		catch (e) { return { status: "error", message: "lecture impossible : " + e, name }; }

		let info;
		try { info = await EPUB.inspect(bytes, ZIP, PDF.inflate); }
		catch (e) { return { status: "error", message: "EPUB illisible : " + (e.message || e), name }; }

		if (info.tocEntries >= this.TOC_MINIMUM && !opts.overwrite) {
			return {
				status: "skipped",
				message: "possède déjà un sommaire (" + info.tocEntries + " entrées)",
				name
			};
		}

		let result;
		try {
			result = await EPUB.writeTOC(bytes, ZIP, PDF.inflate, {
				title: item.parentItem ? item.parentItem.getField("title") : "Sommaire"
			});
		}
		catch (e) {
			return { status: "skipped", message: (e.message || String(e)), name };
		}

		if (opts.preview) {
			let apercu = await this.epubPreview(bytes, ZIP, PDF.inflate, EPUB);
			if (!this.confirmHeadings(opts.window, name, apercu, false)) {
				return { status: "skipped", message: "abandonné", name };
			}
		}

		if (getPref("keepBackup", true)) {
			try { await this.backup(path, item); }
			catch (e) { log("sauvegarde : " + e); }
		}

		try {
			await IOUtils.write(path, result.bytes, { tmpPath: path + ".ztoc-tmp" });
		}
		catch (e) {
			return { status: "error", message: "enregistrement : " + (e.message || e), name };
		}

		await this.afterWrite(item);

		return {
			status: "ok",
			count: result.count,
			usedAI: false,
			message: result.count + " entrées",
			name
		};
	},

	// Aperçu : les mêmes titres que ceux qui seront écrits, sans les ancres.
	async epubPreview(bytes, ZIP, inflate, EPUB) {
		try {
			let book = await EPUB.openBook(bytes, ZIP, inflate);
			let hs = await EPUB.collectHeadings(book, ZIP, inflate);
			return hs.map(h => ({ title: h.text, level: h.level, hasPages: false }));
		}
		catch (e) { return []; }
	},

	// Prévenir Zotero que la pièce jointe a changé (index et synchronisation).
	async afterWrite(item) {
		try {
			item.attachmentSyncState = Zotero.Sync.Storage.Local.SYNC_STATE_TO_UPLOAD;
			await item.saveTx();
		}
		catch (e) { log("état de synchronisation : " + e); }

		if (getPref("addTag", true)) {
			try {
				let tag = String(getPref("tagName", "sommaire-généré")).trim();
				let target = item.parentItem || item;
				if (tag && !target.hasTag(tag)) {
					target.addTag(tag);
					await target.saveTx();
				}
			}
			catch (e) { log("étiquette : " + e); }
		}
	},

	// ---- Sommaire fourni par l'utilisateur ----

	// Ouvre la fenêtre de collage et rend le texte saisi, ou null si annulé.
	promptForTOC(window, titre, prefill, prefillNote) {
		let params = {
			titre: titre,
			prefill: prefill || "",
			note: prefillNote || "",
			iaDisponible: this.provider() !== "off" && !this.aiReadyError(),
			valide: false,
			texte: "",
			utiliserIA: false
		};
		let url = this._chromeHandle
			? "chrome://zotero-toc/content/paste.xhtml"
			: this.rootURI + "content/paste.xhtml";
		try {
			window.openDialog(url, "ztoc-paste",
				"chrome,dialog,modal,centerscreen,resizable", params);
		}
		catch (e) {
			log("fenêtre de collage : " + e);
			toast("zotero-TOC", "Impossible d'ouvrir la fenêtre : " + (e.message || e), "error");
			return null;
		}
		// Une fenêtre XUL qui ne s'instancie pas se ferme sans rien signaler :
		// on distingue ce cas d'une annulation volontaire.
		if (params.ouverte !== true && params.valide !== true) {
			toast("zotero-TOC",
				"La fenêtre de collage ne s'est pas ouverte. Signalez-le : "
				+ "espace chrome " + (this._chromeHandle ? "enregistré" : "NON enregistré") + ".",
				"error");
			return null;
		}
		if (!params.valide || !String(params.texte).trim()) return null;
		return { texte: params.texte, utiliserIA: params.utiliserIA };
	},

	// Chaîne complète : coller un sommaire, le retrouver dans le document,
	// puis l'écrire. Ne concerne que les PDF : un EPUB tient déjà sa structure
	// de ses propres balises de titre.
	async runPastedTOC(window) {
		if (this._busy) {
			toast("zotero-TOC", "Un traitement est déjà en cours.", "error");
			return;
		}
		let items = window.ZoteroPane.getSelectedItems();
		let cibles = await this.collectTargets(items);
		let pdfs = cibles.filter(a => a.attachmentContentType === "application/pdf");
		if (pdfs.length !== 1) {
			toast("zotero-TOC",
				pdfs.length ? "Sélectionnez un seul PDF : un sommaire collé vaut pour un document."
					: "Aucun PDF dans la sélection.", "error");
			return;
		}
		let att = pdfs[0];
		let nom = att.getField("title") || att.attachmentFilename || "document";

		this._busy = true;
		let pw = null, progression = null;
		let avancement = (m) => { try { progression.setText(m); } catch (e) { /* sans importance */ } };
		try {
			pw = new Zotero.ProgressWindow({ closeOnClick: false });
			pw.changeHeadline("zotero-TOC");
			progression = new pw.ItemProgress(
				"chrome://zotero/skin/treeitem-attachment-pdf.png", "Lecture du document…");
			pw.show();

			// Le document est lu AVANT d'ouvrir la fenêtre : on peut ainsi lui
			// proposer la table des matières qu'il contient déjà, à vérifier ou
			// corriger plutôt qu'à recopier.
			let ctx = await this.preparePaste(att, avancement);
			try { pw.close(); } catch (e) { /* sans importance */ }
			pw = null;
			if (ctx.error) { toast("zotero-TOC", ctx.error, "error"); return; }

			let saisie = this.promptForTOC(window, nom, ctx.prefill, ctx.prefillNote);
			if (!saisie) return;

			pw = new Zotero.ProgressWindow({ closeOnClick: false });
			pw.changeHeadline("zotero-TOC");
			progression = new pw.ItemProgress(
				"chrome://zotero/skin/treeitem-attachment-pdf.png", "Recherche des intitulés…");
			pw.show();

			let res = await this.applyPastedTOC(att, saisie, window, avancement, ctx);

			try { progression.setProgress(100); progression.setText(res.message); }
			catch (e) { /* sans importance */ }
			try { pw.startCloseTimer(res.status === "ok" ? 5000 : 9000); }
			catch (e) { /* sans importance */ }
			if (res.status === "error") toast("zotero-TOC", res.message, "error");
			log("sommaire collé | " + res.status + " | " + res.message);
		}
		catch (e) {
			try { if (pw) pw.close(); } catch (e2) { /* sans importance */ }
			log("runPastedTOC : " + e);
			toast("zotero-TOC", String(e.message || e), "error");
		}
		finally {
			this._busy = false;
		}
	},

	// Lit le document et y cherche sa propre table des matières, pour
	// pré-remplir la fenêtre de collage.
	async preparePaste(item, avancement) {
		let { PDF, EX, DT, PIPE } = this.loadModules();
		let path = await item.getFilePathAsync();
		if (!path) return { error: "fichier absent du disque" };
		let bytes = await IOUtils.read(path);
		let info = await PDF.inspect(bytes);
		if (info.encrypted) return { error: "PDF protégé (chiffré)" };

		avancement("Extraction du texte…");
		let doc = await this.extractWithRetry(EX, bytes, {});
		let heads = DT._internals.findRunningHeads(doc.pages);
		let census = DT._internals.styleCensus(doc.pages);

		avancement("Recherche de la table des matières…");
		let toc = null;
		try { toc = PIPE.findPrintedToc(doc, heads); } catch (e) { log("préremplissage : " + e); }
		let prefill = "", note = "";
		if (toc && toc.entries.length) {
			prefill = toc.entries.map(e => "    ".repeat(Math.max(0, e.level - 1)) + e.title
				+ (e.printed !== null ? "  " + (e.roman ? toRoman(e.printed) : e.printed) : "")).join("\n");
			note = "Table des matières repérée page " + toc.pages.map(x => x + 1).join(", ")
				+ " du document (" + toc.entries.length + " entrées). Vérifiez-la, corrigez-la ou remplacez-la.";
		}
		else {
			note = "Aucune table des matières repérée dans le document : collez celle de l'ouvrage.";
		}
		return { path, bytes, doc, heads, census, tocPages: toc ? toc.pages : [], prefill, prefillNote: note };
	},

	async applyPastedTOC(item, saisie, window, avancement, ctx) {
		let { PDF, DT, AI, PASTE } = this.loadModules();
		let name = item.getField("title") || item.attachmentFilename || "(sans titre)";
		if (!ctx) {
			ctx = await this.preparePaste(item, avancement);
			if (ctx.error) return { status: "error", message: ctx.error };
		}
		let { path, bytes, doc, heads, census } = ctx;

		avancement("Recherche des intitulés…");
		// Les pages de sommaire et d'index contiennent tous les intitulés : on
		// ne les fouille pas, sans quoi chaque entrée s'y retrouverait elle-même.
		let exclude = DT._internals.findTocPages(doc.pages);
		for (let pi of (ctx.tocPages || [])) exclude.add(pi);
		let r = PASTE.locate(saisie.texte, doc, heads, census.bodySize, { excludePages: exclude });

		if (!r.entries.length) {
			return { status: "error", message: "aucune entrée reconnue dans le texte collé" };
		}

		// Ordre de résolution : le texte d'abord ; le modèle pour les intitulés
		// restés introuvables ; leur numéro de page pour ce qui reste encore.
		let viaIA = 0;
		if (saisie.utiliserIA && r.unmatched.length && !this.aiReadyError()) {
			avancement("Intitulés difficiles soumis au modèle…");
			try { viaIA = await this.completePastedWithAI(r, doc, heads, census, AI, PASTE); }
			catch (e) { log("modèle (sommaire collé) : " + (e.message || e)); }
		}
		PASTE.placeRemaining(r, doc);

		let headings = r.headings;
		if (headings.length < 2) {
			return {
				status: "error",
				message: "seulement " + headings.length + " intitulé(s) retrouvé(s) dans le document"
			};
		}

		let morceaux = [headings.length + " entrées sur " + r.entries.length];
		if (r.offset !== null) morceaux.push("décalage de pagination : " + r.offset + " pages");
		if (viaIA) morceaux.push(viaIA + " retrouvées par le modèle");
		if (r.placed) morceaux.push(r.placed + " placées d'après leur numéro de page");
		let resume = morceaux.join(" ; ");
		let detail = resume;
		if (r.unmatched.length) {
			detail += "\nIntrouvables (" + r.unmatched.length + ") : "
				+ r.unmatched.slice(0, 5).map(t => "« " + t.slice(0, 50) + " »").join(", ")
				+ (r.unmatched.length > 5 ? "…" : "");
			log("intitulés non retrouvés : " + r.unmatched.join(" | "));
		}

		if (!saisie.sansConfirmation
			&& !this.confirmHeadings(window, name + "\n" + detail, headings.slice(), viaIA > 0)) {
			return { status: "skipped", message: "abandonné" };
		}

		if (getPref("keepBackup", true)) {
			try { await this.backup(path, item); }
			catch (e) { log("sauvegarde : " + e); }
		}

		avancement("Écriture du sommaire…");
		let out = await PDF.writeOutline(bytes, headings);
		await IOUtils.write(path, out, { tmpPath: path + ".ztoc-tmp" });
		await this.afterWrite(item);

		return { status: "ok", message: resume };
	},

	// Soumet au modèle les intitulés introuvables, avec une courte liste de
	// lignes plausibles. Complète `r.headings` sur place ; rend le nombre
	// d'intitulés récupérés.
	async completePastedWithAI(r, doc, heads, census, AI, PASTE) {
		let restants = r.entries.filter(e =>
			!r.headings.some(h => h.title === e.title));
		if (!restants.length) return 0;

		let index = r.index || PASTE.buildIndex(doc, heads);
		// Numéroter les lignes une fois pour toutes : le modèle ne manipule que
		// ces numéros, jamais du texte libre.
		let numeros = new Map();
		index.forEach((it, i) => numeros.set(it, i + 1));

		let questions = [];
		restants.slice(0, 25).forEach((e, qi) => {
			let cands = PASTE.candidatesFor(e, index,
				{ bodySize: census.bodySize, offset: r.offset });
			if (!cands.length) return;
			// Retrouver les objets d'index correspondants pour leur numéro.
			let options = [];
			for (let it of index) {
				for (let c of cands.slice(0, 6)) {
					if (it.pageIndex === c.pageIndex && it.text === c.text) {
						options.push({ i: numeros.get(it), page: it.pageIndex, text: it.text.slice(0, 110) });
						break;
					}
				}
				if (options.length >= 6) break;
			}
			if (options.length) questions.push({ e: qi + 1, title: e.title, options: options, entry: e });
		});
		if (!questions.length) return 0;

		let choix = await AI.matchTitles(this.aiConfig(), questions);
		let ajoutes = 0;
		for (let q of questions) {
			let i = choix.get(q.e);
			if (!i) continue;
			let it = index[i - 1];
			if (!it) continue;
			r.headings.push({
				title: q.entry.title, level: q.entry.level,
				pageIndex: it.pageIndex, y: Math.round(it.top), score: 99
			});
			ajoutes++;
		}
		if (ajoutes) {
			// Remettre l'ensemble dans l'ordre du document.
			r.headings.sort((a, b) => (a.pageIndex - b.pageIndex) || (b.y - a.y));
		}
		return ajoutes;
	},

	// Copie de sauvegarde, rangée hors du dossier de stockage de Zotero pour ne
	// pas troubler sa gestion des pièces jointes.
	async backup(path, item) {
		let dir = PathUtils.join(Zotero.DataDirectory.dir, "zotero-TOC-backups");
		await IOUtils.makeDirectory(dir, { ignoreExisting: true });
		let base = (item.key || "item") + "_" + (item.attachmentFilename || "fichier.pdf");
		let dest = PathUtils.join(dir, base.replace(/[/\\:]/g, "_"));
		if (await IOUtils.exists(dest)) return;   // ne pas écraser l'original conservé
		await IOUtils.copy(path, dest);
	},

	// ---- Fenêtre de confirmation ----

	confirmHeadings(window, name, headings, usedAI) {
		try {
			let sample = headings.slice(0, 15)
				.map(h => "  ".repeat(Math.max(0, h.level - 1)) + "• " + h.title
					// Un EPUB n'a pas de pagination : on n'annonce donc rien.
					+ (typeof h.pageIndex === "number" && h.pageIndex >= 0 && h.hasPages !== false
						? "  (p. " + (h.pageIndex + 1) + ")" : ""))
				.join("\n");
			let more = headings.length > 15 ? "\n  … et " + (headings.length - 15) + " autres" : "";
			let msg = name + "\n\n"
				+ headings.length + " entrées détectées"
				+ (usedAI ? " (avec l'appui du modèle)" : "") + " :\n\n"
				+ sample + more
				+ "\n\nÉcrire ce sommaire dans le PDF ?";
			return Services.prompt.confirm(window, "zotero-TOC", msg);
		}
		catch (e) {
			log("confirmation : " + e);
			return true;
		}
	},

	// ---- Traitement par lot ----

	async runBatch(window, opts) {
		if (this._busy) {
			toast("zotero-TOC", "Un traitement est déjà en cours.", "error");
			return;
		}
		this._busy = true;
		let pw = null;
		try {
			let items = window.ZoteroPane.getSelectedItems();
			let attachments = await this.collectTargets(items);
			if (!attachments.length) {
				toast("zotero-TOC", "Aucun PDF ni EPUB dans la sélection.", "error");
				return;
			}

			// Prévenir tôt plutôt que d'échouer à mi-parcours.
			if (opts.forceAI) {
				let err = this.aiReadyError();
				if (err) {
					toast("zotero-TOC", "Modèle indisponible : " + err
						+ " (Préférences → zotero-TOC).", "error");
					return;
				}
			}

			pw = new Zotero.ProgressWindow({ closeOnClick: false });
			pw.changeHeadline("zotero-TOC");
			let itemProgress = new pw.ItemProgress(
				"chrome://zotero/skin/treeitem-attachment-pdf.png",
				"Analyse de " + attachments.length + " document(s)…");
			pw.show();

			let done = 0, ok = 0, skipped = 0, failed = 0;
			let details = [];
			for (let att of attachments) {
				done++;
				try {
					itemProgress.setText("(" + done + "/" + attachments.length + ") "
						+ (att.attachmentFilename || att.getField("title") || "").slice(0, 45));
					itemProgress.setProgress(Math.round((done - 1) / attachments.length * 100));
				}
				catch (e) { /* sans importance */ }

				let res;
				try {
					res = await this.processAttachment(att, {
						overwrite: opts.overwrite,
						forceAI: opts.forceAI,
						preview: opts.preview,
						window: window
					});
				}
				catch (e) {
					res = { status: "error", message: String(e.message || e), name: "?" };
				}
				if (res.status === "ok") { ok++; details.push("✓ " + res.name + " : " + res.message); }
				else if (res.status === "skipped") { skipped++; details.push("- " + res.name + " : " + res.message); }
				else { failed++; details.push("✗ " + res.name + " : " + res.message); }
				log(res.status + " | " + res.name + " | " + res.message);
			}

			try { itemProgress.setProgress(100); } catch (e) { /* sans importance */ }
			try {
				itemProgress.setText(ok + " traité(s), " + skipped + " ignoré(s)"
					+ (failed ? ", " + failed + " en échec" : ""));
			}
			catch (e) { /* sans importance */ }
			try { pw.startCloseTimer(6000); } catch (e) { /* sans importance */ }

			// Le détail complet part dans le journal : la fenêtre de progression
			// ne peut pas afficher cinquante lignes lisiblement.
			log("Bilan :\n" + details.join("\n"));

			if (failed && ok === 0) {
				toast("zotero-TOC", details.find(d => d.startsWith("✗")) || "Échec.", "error");
			}
		}
		catch (e) {
			log("runBatch : " + e);
			try { if (pw) pw.close(); } catch (e2) { /* sans importance */ }
			toast("zotero-TOC", String(e.message || e), "error");
		}
		finally {
			this._busy = false;
		}
	},

	// Rassemble les pièces jointes traitables (PDF et EPUB) d'une sélection.
	async collectTargets(items) {
		let out = [];
		let seen = new Set();
		for (let item of items || []) {
			try {
				let list = [];
				if (item.isAttachment && item.isAttachment()) list = [item];
				else if (item.isRegularItem && item.isRegularItem()) {
					list = await Zotero.Items.getAsync(item.getAttachments());
				}
				for (let att of list) {
					if (!att || !att.isFileAttachment || !att.isFileAttachment()) continue;
					let t = att.attachmentContentType;
					if (t !== "application/pdf" && t !== "application/epub+zip") continue;
					if (seen.has(att.id)) continue;
					seen.add(att.id);
					out.push(att);
				}
			}
			catch (e) {
				log("collectTargets : " + e);
			}
		}
		return out;
	},

	// ---- Menu contextuel ----

	selectionHasPDF(window) {
		try {
			let items = window.ZoteroPane.getSelectedItems();
			if (!items || !items.length) return false;
			return items.some(i =>
				(i.isRegularItem && i.isRegularItem())
				|| (i.isAttachment && i.isAttachment()
					&& (i.attachmentContentType === "application/pdf"
						|| i.attachmentContentType === "application/epub+zip")));
		}
		catch (e) {
			return false;
		}
	},

	addToWindow(window) {
		try {
			if (this._windows.has(window)) return;
			let doc = window.document;
			let itemmenu = doc.getElementById("zotero-itemmenu");
			if (!itemmenu) return;

			let menu = doc.createXULElement("menu");
			menu.id = "ztoc-itemmenu";
			menu.setAttribute("label", "zotero-TOC");

			let popup = doc.createXULElement("menupopup");
			let mk = (label, opts) => {
				let mi = doc.createXULElement("menuitem");
				mi.setAttribute("label", label);
				mi.addEventListener("command", () => {
					ZoteroTOC.runBatch(window, opts).catch(e => log("runBatch : " + e));
				});
				popup.appendChild(mi);
				return mi;
			};

			mk("Générer le sommaire", { overwrite: false, preview: false });
			mk("Générer le sommaire (avec aperçu)…", { overwrite: false, preview: true });
			popup.appendChild(doc.createXULElement("menuseparator"));
			mk("Régénérer en remplaçant le sommaire existant", { overwrite: true, preview: true });
			mk("Générer avec l'appui du modèle", { overwrite: false, preview: true, forceAI: true });
			popup.appendChild(doc.createXULElement("menuseparator"));

			let coller = doc.createXULElement("menuitem");
			coller.setAttribute("label", "Coller ou corriger le sommaire…");
			coller.addEventListener("command", () => {
				ZoteroTOC.runPastedTOC(window).catch(e => log("runPastedTOC : " + e));
			});
			popup.appendChild(coller);

			menu.appendChild(popup);
			itemmenu.appendChild(menu);

			let onShowing = () => { menu.hidden = !ZoteroTOC.selectionHasPDF(window); };
			itemmenu.addEventListener("popupshowing", onShowing);

			this._windows.set(window, { menu, itemmenu, onShowing });
		}
		catch (e) {
			log("addToWindow : " + e);
		}
	},

	removeFromWindow(window) {
		let rec = this._windows.get(window);
		if (!rec) return;
		try { rec.itemmenu.removeEventListener("popupshowing", rec.onShowing); } catch (e) { /* ignore */ }
		try { rec.menu.remove(); } catch (e) { /* ignore */ }
		this._windows.delete(window);
	},

	removeFromAllWindows() {
		for (let window of Array.from(this._windows.keys())) this.removeFromWindow(window);
		this._windows.clear();
	}
};

// ---- Cycle de vie (Zotero 7/8/9) ----

function install() {}

async function startup({ id, version, rootURI }) {
	ZoteroTOC.init({ id, version, rootURI });
	ZoteroTOC.registerChrome();

	// Exposé pour le panneau de préférences (bouton de test du modèle).
	Zotero.ZoteroTOC = ZoteroTOC;

	Zotero.PreferencePanes.register({
		pluginID: "zotero-toc@equiriconi",
		src: rootURI + "preferences.xhtml",
		scripts: [rootURI + "preferences.js"],
		label: "zotero-TOC"
	});

	for (let window of Zotero.getMainWindows()) ZoteroTOC.addToWindow(window);
	log("démarré (v" + version + ")");

	// Diagnostic facultatif : si « ztoc.diagnosticOut » contient un chemin, le
	// plugin déroule toute la chaîne sur le PDF désigné par « ztoc.diagnosticPdf »
	// et écrit un rapport. Sert à identifier l'étape fautive sans passer par
	// l'interface (voir la section « Diagnostic » du README).
	let stOut = getPref("diagnosticOut", "");
	if (stOut) {
		setTimeout(() => {
			ZoteroTOC.runDiagnostic(stOut).catch(e => log("diagnostic : " + e));
		}, 4000);
	}
}

ZoteroTOC.runDiagnostic = async function (outPath) {
	let report = { etapes: [], erreurs: [] };
	// Le rapport est réécrit à chaque étape : si le traitement se fige, le
	// dernier enregistrement désigne l'étape qui bloque.
	let ecriture = Promise.resolve();
	let push = (k, v) => {
		report.etapes.push(new Date().toTimeString().slice(0, 8) + " " + k + " : " + v);
		log("diagnostic " + k + " = " + v);
		let instantane = JSON.stringify(report, null, 2);
		ecriture = ecriture.then(() => IOUtils.writeUTF8(outPath + ".partiel", instantane)).catch(() => {});
	};
	try {
		let mods = this.loadModules();
		push("modules", Object.keys(mods).filter(k => mods[k]).join(","));

		let pdfjs = await this.getPdfjs();
		push("pdfjs", "chargé, version " + (pdfjs.version || "?"));

		// Diagnostic sur une pièce jointe réelle : déroule le traitement complet
		// tel que le menu l'exécute, message d'erreur compris.
		let itemKey = String(getPref("diagnosticItemKey", "")).trim();
		if (itemKey) {
			let att = null;
			for (let lib of Zotero.Libraries.getAll()) {
				try {
					let it = await Zotero.Items.getByLibraryAndKeyAsync(lib.libraryID, itemKey);
					if (it) { att = it; break; }
				}
				catch (e) { /* bibliothèque suivante */ }
			}
			if (!att) push("item", "clé introuvable : " + itemKey);
			else {
				if (att.isRegularItem && att.isRegularItem()) {
					let kids = await Zotero.Items.getAsync(att.getAttachments());
					att = kids.find(k => k.attachmentContentType === "application/pdf") || att;
				}
				push("item", att.key + " : " + (att.attachmentFilename || "?"));
				let res = await this.processAttachment(att, { overwrite: true, preview: false });
				push("traitement", JSON.stringify(res));
			}
		}

		// Contrôle de la fenêtre de collage : on l'ouvre sans modalité, on
		// regarde si son document s'est réellement instancié, puis on referme.
		if (getPref("diagnosticDialog", false)) {
			push("chrome", this._chromeHandle ? "espace enregistré" : "NON enregistré");
			let url = "chrome://zotero-toc/content/paste.xhtml";
			try {
				let reponse = await new Promise((resolve) => {
					let xhr = new XMLHttpRequest();
					xhr.open("GET", url);
					xhr.onload = () => resolve("HTTP " + xhr.status + ", "
						+ (xhr.responseText || "").length + " octets");
					xhr.onerror = () => resolve("inaccessible");
					xhr.send();
				});
				push("url chrome", reponse);
			}
			catch (e) { push("url chrome", "erreur : " + (e.message || e)); }

			let win = Zotero.getMainWindow();
			let params = { titre: "contrôle", iaDisponible: false, valide: false };
			try {
				let dlg = win.openDialog(url, "ztoc-paste-test",
					"chrome,dialog,centerscreen,resizable", params);
				await new Promise(r => win.setTimeout(r, 2500));
				let racine = "?";
				try { racine = dlg.document.documentElement.localName; } catch (e) { racine = "inaccessible"; }
				let zone = null;
				try { zone = dlg.document.getElementById("ztoc-paste-area") ? "présente" : "absente"; }
				catch (e) { zone = "inaccessible"; }
				push("fenêtre", "racine=" + racine + " | zone de saisie=" + zone
					+ " | témoin d'ouverture=" + (params.ouverte === true));
				try { dlg.close(); } catch (e) { /* sans importance */ }
			}
			catch (e) { push("fenêtre", "ERREUR : " + (e.message || e)); }
		}

		// Diagnostic du collage de sommaire : le texte est pris dans une
		// préférence, ce qui permet d'éprouver toute la chaîne sans la fenêtre.
		let pasteKey = String(getPref("diagnosticPasteItem", "")).trim();
		let pasteFile = String(getPref("diagnosticPasteFile", "")).trim();
		if (pasteKey && pasteFile) {
			let att = null;
			for (let lib of Zotero.Libraries.getAll()) {
				try {
					let it = await Zotero.Items.getByLibraryAndKeyAsync(lib.libraryID, pasteKey);
					if (it) { att = it; break; }
				}
				catch (e) { /* bibliothèque suivante */ }
			}
			if (!att) push("collage", "clé introuvable : " + pasteKey);
			else {
				if (att.isRegularItem && att.isRegularItem()) {
					let kids = await Zotero.Items.getAsync(att.getAttachments());
					att = kids.find(k => k.attachmentContentType === "application/pdf") || att;
				}
				let texte = await IOUtils.readUTF8(pasteFile);
				let res = await this.applyPastedTOC(att,
					{ texte: texte, utiliserIA: false, sansConfirmation: true },
					null, (m) => push("étape", m));
				push("collage", JSON.stringify(res));
			}
		}

		// Diagnostic sur des copies : chemins séparés par « | ». Déroule la
		// chaîne réelle (modèle compris, s'il est configuré) et écrit le
		// résultat dans une copie « .ztoc-diagnostic.pdf », jamais dans la
		// bibliothèque.
		let srcs = String(getPref("diagnosticPdf", "")).split("|").map(x => x.trim()).filter(Boolean);
		for (let src of srcs) {
			// Un document en échec ne doit pas interrompre la série.
			try {
			let t0 = Date.now();
			let bytes = await IOUtils.read(src);
			let nom = src.split("/").pop();
			push("début", nom + " (" + bytes.length + " octets)");
			let built = await this.buildOutline(bytes, nom, {
				forceAI: !!getPref("diagnosticForceAI", false),
				aiContract: String(getPref("diagnosticAIContract", "")) || undefined,
				onProgress: (i, n) => { if (i % 50 === 0 || i === n) push("extraction", i + "/" + n + " pages"); }
			});
			push("chaîne", "source " + built.result.source + (built.usedAI ? " (modèle sollicité)" : ""));
			let r = built.result;
			push("document", nom + " | " + built.doc.pages.length + " pages | source " + r.source
				+ " | " + r.headings.length + " entrées | " + Math.round((Date.now() - t0) / 1000) + " s");
			push("notes", r.notes.join(" ; "));
			push("début", JSON.stringify(r.headings.slice(0, 8).map(h =>
				"N" + h.level + " p" + (h.pageIndex + 1) + " " + h.title.slice(0, 50))));
			if (r.headings.length >= 2) {
				let out = await mods.PDF.writeOutline(bytes, r.headings);
				let tmp = src.replace(/\.pdf$/i, "") + ".ztoc-diagnostic.pdf";
				await IOUtils.write(tmp, out);
				push("fichier", tmp);
			}
			}
			catch (e) {
				push("ÉCHEC", src.split("/").pop() + " : " + String((e && e.message) || e));
			}
		}
	}
	catch (e) {
		report.erreurs.push(String((e && e.message) || e) + " | " + String((e && e.stack) || ""));
		log("diagnostic ERREUR " + e);
	}
	try {
		await IOUtils.writeUTF8(outPath, JSON.stringify(report, null, 2));
	}
	catch (e) { log("diagnostic, écriture du rapport : " + e); }
};

function onMainWindowLoad({ window }) {
	if (ZoteroTOC) ZoteroTOC.addToWindow(window);
}

function onMainWindowUnload({ window }) {
	// Indispensable : garder une référence à une fenêtre fermée créerait une fuite.
	if (ZoteroTOC) ZoteroTOC.removeFromWindow(window);
}

function shutdown() {
	if (ZoteroTOC) {
		ZoteroTOC.removeFromAllWindows();
		ZoteroTOC.resetPdfWorker();
		ZoteroTOC.unregisterChrome();
	}
	try { delete Zotero.ZoteroTOC; } catch (e) { /* ignore */ }
	ZoteroTOC = undefined;
}

function uninstall() {}
