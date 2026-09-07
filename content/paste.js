/* eslint-disable no-undef */
// zotero-TOC — fenêtre de collage du sommaire.
// Le résultat est déposé dans l'objet passé en argument par l'appelant.

(function () {
	"use strict";

	function args() {
		return (window.arguments && window.arguments[0]) || {};
	}

	function majCompte() {
		let zone = document.getElementById("ztoc-paste-area");
		let etiquette = document.getElementById("ztoc-paste-count");
		if (!zone || !etiquette) return;
		let n = zone.value.split("\n").filter(l => l.trim()).length;
		etiquette.setAttribute("value", n ? n + " ligne(s)" : "");
	}

	function init() {
		let a = args();
		// Témoin d'instanciation : permet à l'appelant de distinguer une
		// annulation d'une fenêtre qui ne s'est jamais affichée.
		a.ouverte = true;
		let zone = document.getElementById("ztoc-paste-area");
		let ia = document.getElementById("ztoc-paste-ai");

		if (a.titre) document.title = "zotero-TOC — " + a.titre;
		if (ia) {
			// La case n'a de sens que si un fournisseur est configuré. On passe
			// par les PROPRIÉTÉS et non les attributs : sur une case XUL,
			// getAttribute("checked") ne suit pas les clics de l'utilisateur.
			if (a.iaDisponible) ia.checked = true;
			else {
				ia.disabled = true;
				ia.label = "Aucun modèle configuré (Préférences → zotero-TOC)";
			}
		}

		zone.addEventListener("input", majCompte);
		zone.focus();

		document.getElementById("ztoc-paste-ok").addEventListener("command", () => {
			a.texte = zone.value;
			a.utiliserIA = !!(ia && !ia.disabled && ia.checked);
			a.valide = true;
			window.close();
		});
		document.getElementById("ztoc-paste-cancel").addEventListener("command", () => {
			a.valide = false;
			window.close();
		});

		// Entrée valide, Échap annule.
		window.addEventListener("keydown", (e) => {
			if (e.key === "Escape") { a.valide = false; window.close(); }
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
				let ok = document.getElementById("ztoc-paste-ok");
				if (ok.doCommand) ok.doCommand(); else ok.click();
			}
		});
	}

	window.addEventListener("load", init, { once: true });
})();
