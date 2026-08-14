/* eslint-disable no-undef */
// zotero-TOC — script du panneau de préférences : n'affiche que les réglages du
// fournisseur choisi, et permet de vérifier que le modèle répond réellement
// avant de lancer un traitement par lot.

(function () {
	"use strict";

	function $(id) { return document.getElementById(id); }

	function syncProviderVisibility() {
		let sel = $("ztoc-provider");
		if (!sel) return;
		let p = sel.value;
		let map = {
			"ztoc-cfg-mistral": p === "mistral",
			"ztoc-cfg-ollama": p === "ollama",
			"ztoc-cfg-cli": p === "cli"
		};
		for (let id of Object.keys(map)) {
			let el = $(id);
			if (el) el.hidden = !map[id];
		}
		let test = $("ztoc-test");
		if (test) test.disabled = (p === "off");
	}

	async function runTest() {
		let out = $("ztoc-test-result");
		let btn = $("ztoc-test");
		if (!out) return;

		let TOC = Zotero.ZoteroTOC;
		if (!TOC) { out.setAttribute("value", "Plugin non initialisé."); return; }

		let err = TOC.aiReadyError();
		if (err) { out.setAttribute("value", "✗ " + err); return; }

		out.setAttribute("value", "Interrogation du modèle…");
		if (btn) btn.disabled = true;
		try {
			let { AI } = TOC.loadModules();
			// Jeu d'essai minuscule : deux vrais titres parmi du corps de texte.
			let candidates = [
				{ i: 1, pageIndex: 0, y: 700, size: 16, text: "1. Introduction" },
				{ i: 2, pageIndex: 0, y: 650, size: 10,
					text: "Le présent article examine les conditions dans lesquelles ces phénomènes apparaissent." },
				{ i: 3, pageIndex: 1, y: 700, size: 14, text: "1.1. Contexte de l'étude" },
				{ i: 4, pageIndex: 2, y: 700, size: 16, text: "2. Méthode" }
			];
			let res = await AI.refine(TOC.aiConfig(), candidates,
				{ title: "Essai", pages: 3, bodySize: 10 });
			if (!res.length) {
				out.setAttribute("value", "✗ Le modèle a répondu, mais n'a retenu aucun titre.");
			}
			else {
				out.setAttribute("value", "✓ Réponse correcte — "
					+ res.length + " titres retenus : "
					+ res.map(h => h.title).join(" / ").slice(0, 70));
			}
		}
		catch (e) {
			out.setAttribute("value", "✗ " + String(e.message || e).slice(0, 160));
		}
		finally {
			if (btn) btn.disabled = false;
		}
	}

	function init() {
		let sel = $("ztoc-provider");
		if (sel) sel.addEventListener("command", syncProviderVisibility);
		if (sel) sel.addEventListener("change", syncProviderVisibility);
		let btn = $("ztoc-test");
		if (btn) btn.addEventListener("command", () => { runTest(); });
		syncProviderVisibility();
	}

	if (document.readyState === "complete" || document.readyState === "interactive") {
		// Le panneau est déjà en place quand le script est injecté.
		setTimeout(init, 0);
	}
	else {
		window.addEventListener("DOMContentLoaded", init);
	}
})();
