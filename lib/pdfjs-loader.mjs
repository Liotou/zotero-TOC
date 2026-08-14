// Charge le pdf.js embarqué dans Zotero depuis le contexte d'une fenêtre, où
// « navigator », « document » et « DOMMatrix » existent réellement. Chargé
// depuis le contexte système, pdf.js échoue sur son propre test de plateforme.
import * as pdfjs from "resource://zotero/reader/pdf/build/pdf.mjs";

try {
	if (pdfjs.GlobalWorkerOptions && !pdfjs.GlobalWorkerOptions.workerSrc) {
		pdfjs.GlobalWorkerOptions.workerSrc =
			"resource://zotero/reader/pdf/build/pdf.worker.mjs";
	}
}
catch (e) { /* pdf.js retombera sur son exécution en fil principal */ }

window.__ztocPdfjs = pdfjs;
window.dispatchEvent(new CustomEvent("ztoc-pdfjs-ready"));
