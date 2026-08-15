/* eslint-disable no-undef */
// zotero-TOC — génère le sommaire manquant d'un PDF et l'inscrit dans le fichier,
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

	// ---- Chargement des modules internes ----

	loadModules() {
		if (this.mods) return this.mods;
		let scope = {};
		let loader = Services.scriptloader;
		for (let f of ["lib/pdf-lib.js", "lib/zip.js", "lib/epub.js",
			"lib/extract.js", "lib/detect.js", "lib/ai.js"]) {
			loader.loadSubScript(this.rootURI + f, scope);
		}
		this.mods = {
			PDF: scope.ZTOC_PDF,
			EX: scope.ZTOC_EXTRACT,
			DT: scope.ZTOC_DETECT,
			AI: scope.ZTOC_AI,
			ZIP: scope.ZTOC_ZIP,
			EPUB: scope.ZTOC_EPUB
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

	// Quand solliciter le modèle : jamais, seulement en cas de doute, ou toujours.
	aiMode() {
		let m = String(getPref("aiMode", "auto")).trim();
		return ["never", "auto", "always"].includes(m) ? m : "auto";
	},

	// ---- Traitement d'une pièce jointe ----

	// Rend { status, message, count }. `status` ∈ ok | skipped | error.
	async processAttachment(item, opts) {
		opts = opts || {};
		let { PDF, EX, DT, AI } = this.loadModules();
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

		// Extraction du texte et de sa typographie.
		let pdfjs = await this.getPdfjs();
		let doc;
		try {
			doc = await EX.extractDocument(pdfjs, this.toWindowBytes(bytes), {
				maxPages: parseInt(getPref("maxPages", 0), 10) || 0
			});
		}
		catch (e) {
			return { status: "error", message: "extraction du texte : " + (e.message || e), name };
		}

		let result = DT.detect(doc);
		let conf = DT.confidence(result);
		let usedAI = false;

		let mode = opts.forceAI ? "always" : this.aiMode();
		let wantAI = (mode === "always")
			|| (mode === "auto" && conf.level !== "bonne");
		if (wantAI && this.provider() !== "off" && !this.aiReadyError()) {
			try {
				let refined = await AI.refine(this.aiConfig(), result.aiCandidates || [], {
					title: name,
					pages: doc.pages.length,
					bodySize: result.stats.bodySize
				});
				// On ne remplace la détection que si le modèle a produit mieux.
				if (refined.length >= 3 && refined.length >= result.headings.length * 0.5) {
					result = { headings: refined, stats: result.stats };
					usedAI = true;
				}
				else if (refined.length && !result.headings.length) {
					result = { headings: refined, stats: result.stats };
					usedAI = true;
				}
			}
			catch (e) {
				log("modèle : " + (e.message || e));
				// Échec du modèle : on garde la détection typographique.
			}
		}

		let headings = result.headings || [];
		if (headings.length < 2) {
			return {
				status: "skipped",
				message: "aucune structure de titres identifiable"
					+ (conf.reason ? " (" + conf.reason + ")" : ""),
				name
			};
		}

		if (opts.preview) {
			let go = this.confirmHeadings(opts.window, name, headings, usedAI);
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
				if (res.status === "ok") { ok++; details.push("✓ " + res.name + " — " + res.message); }
				else if (res.status === "skipped") { skipped++; details.push("– " + res.name + " — " + res.message); }
				else { failed++; details.push("✗ " + res.name + " — " + res.message); }
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
	let push = (k, v) => { report.etapes.push(k + " : " + v); log("diagnostic " + k + " = " + v); };
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
				push("item", att.key + " — " + (att.attachmentFilename || "?"));
				let res = await this.processAttachment(att, { overwrite: true, preview: false });
				push("traitement", JSON.stringify(res));
			}
		}

		let src = String(getPref("diagnosticPdf", "")).trim();
		if (src) {
			let bytes = await IOUtils.read(src);
			push("lecture", bytes.length + " octets");
			let info = await mods.PDF.inspect(bytes);
			push("inspect", JSON.stringify(info));
			let doc = await mods.EX.extractDocument(pdfjs, this.toWindowBytes(bytes), {});
			push("extraction", doc.pages.length + " pages, "
				+ doc.pages.reduce((a, p) => a + p.lines.length, 0) + " lignes");
			let r = mods.DT.detect(doc);
			push("detection", r.headings.length + " titres | "
				+ JSON.stringify(r.headings.slice(0, 5).map(h => h.title.slice(0, 40))));
			if (r.headings.length >= 2) {
				let out = await mods.PDF.writeOutline(bytes, r.headings);
				push("ecriture", out.length + " octets (source " + bytes.length + ")");
				let tmp = src.replace(/\.pdf$/i, "") + ".ztoc-diagnostic.pdf";
				await IOUtils.write(tmp, out);
				push("fichier", tmp);
			}
		}
	}
	catch (e) {
		report.erreurs.push(String((e && e.stack) || e));
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
	if (ZoteroTOC) ZoteroTOC.removeFromAllWindows();
	try { delete Zotero.ZoteroTOC; } catch (e) { /* ignore */ }
	ZoteroTOC = undefined;
}

function uninstall() {}
