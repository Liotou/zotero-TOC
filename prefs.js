// Préférences par défaut (branche extensions.zotero.ztoc.*)

// ---- Appui d'un modèle ----
// Quand solliciter le modèle : "never", "auto" (uniquement si la détection
// typographique est douteuse), "always".
pref("extensions.zotero.ztoc.aiMode", "auto");

// Fournisseur : "off", "mistral", "ollama", "cli".
pref("extensions.zotero.ztoc.provider", "off");

// API Mistral (ou tout point d'accès compatible OpenAI).
pref("extensions.zotero.ztoc.apiKey", "");
pref("extensions.zotero.ztoc.model", "mistral-large-latest");
pref("extensions.zotero.ztoc.endpoint", "https://api.mistral.ai/v1/chat/completions");

// Ollama (local, aucune clé requise).
pref("extensions.zotero.ztoc.ollamaEndpoint", "http://localhost:11434/v1/chat/completions");
pref("extensions.zotero.ztoc.ollamaModel", "llama3.1:8b");

// Claude Code en ligne de commande (local, via l'abonnement du CLI).
pref("extensions.zotero.ztoc.cliPath", "claude");
pref("extensions.zotero.ztoc.cliModel", "");

// ---- Comportement ----
// Conserver une copie du PDF d'origine dans « zotero-TOC-backups »
// du répertoire de données Zotero, avant toute modification.
pref("extensions.zotero.ztoc.keepBackup", true);

// Étiqueter l'item une fois le sommaire écrit.
pref("extensions.zotero.ztoc.addTag", true);
pref("extensions.zotero.ztoc.tagName", "sommaire-généré");

// Limiter l'analyse aux N premières pages (0 = document entier).
pref("extensions.zotero.ztoc.maxPages", 0);

// ---- Diagnostic (voir README) ----
// Chemin d'un rapport JSON à écrire au démarrage ; vide = désactivé.
pref("extensions.zotero.ztoc.diagnosticOut", "");
// PDF sur lequel dérouler la chaîne complète pendant le diagnostic.
pref("extensions.zotero.ztoc.diagnosticPdf", "");
