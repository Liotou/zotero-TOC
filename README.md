# zotero-TOC

Extension Zotero (7 à 10) qui **génère le sommaire manquant d'un PDF ou d'un EPUB et l'inscrit dans le fichier**, afin que le volet « Sommaire » du lecteur Zotero devienne utilisable.

Plus de la moitié des PDF d'une bibliothèque de recherche n'ont aucun signet : le volet reste vide et l'on navigue à la molette. zotero-TOC reconstitue la structure à partir de la mise en page, puis l'écrit dans le PDF lui-même : le sommaire reste donc valable hors de Zotero, dans n'importe quel lecteur.

## Installation

1. Téléchargez le fichier `.xpi` depuis la [page des versions](https://github.com/Liotou/zotero-TOC/releases/latest).
2. Dans Zotero : **Outils → Extensions**, puis la roue dentée → *Install Add-on From File…*
3. Sélectionnez le `.xpi`, puis redémarrez Zotero.

Les mises à jour suivantes sont automatiques : Zotero interroge `updates.json` de ce dépôt et propose les nouvelles versions.

## Usage

Sélectionnez un ou plusieurs documents dans votre bibliothèque, puis **clic droit → zotero-TOC** :

| Entrée | Effet |
|---|---|
| **Générer le sommaire** | Traite la sélection sans rien demander. |
| **Générer le sommaire (avec aperçu)…** | Affiche la source retenue et les entrées, puis demande confirmation avant d'écrire. |
| **Régénérer en remplaçant le sommaire existant** | Le seul moyen d'écraser un sommaire déjà présent. |
| **Générer avec l'appui du modèle** | Fait arbitrer le modèle même quand les sources concordent. |
| **Coller ou corriger le sommaire…** | Ouvre une fenêtre pré-remplie avec la table des matières trouvée dans le document, à vérifier, corriger ou remplacer. Voir plus bas. |

Ouvrez ensuite le document et affichez le volet « Sommaire » du lecteur.

Un document qui possède déjà un sommaire n'est **jamais** modifié, sauf demande explicite : le sommaire d'origine de l'éditeur est presque toujours meilleur qu'une détection automatique.

## Comment le sommaire est construit

La version 1 appliquait la même détection typographique à tous les documents. Sur un article, cela fonctionne. Sur un ouvrage, elle produisait des sommaires de plusieurs centaines d'entrées où se mêlaient exercices numérotés, formules, notes de fin et titres courants. La version 2 procède comme un lecteur humain : elle **commence par chercher la table des matières que le document contient déjà**.

1. **Table des matières imprimée.** Le plugin repère la ou les pages de sommaire (au début, ou à la fin comme dans beaucoup d'ouvrages français), en écartant les index, les listes de figures et de tableaux. Il en lit les entrées avec leur retrait, qui donne la hiérarchie, et leur numéro de page. Les colonnes sont recollées ligne à ligne : sur une page de sommaire, les numéros alignés à droite forment sinon une colonne séparée de leurs intitulés.
2. **Retrouver chaque entrée dans le texte.** Une entrée n'est pas placée d'après son numéro imprimé, qui ne correspond pas aux pages du lecteur, mais **retrouvée dans le corps du document**. Les titres courants, qui répètent l'intitulé du chapitre en haut de chaque page, sont écartés ; le décalage entre pagination imprimée et pages du lecteur est estimé, puis sert d'indice ; l'ordre de la table est imposé globalement. Une entrée introuvable dans le texte est placée en tête de la page que lui assigne ce décalage.
3. **Approfondir par les styles.** Une table imprimée ne liste souvent que les chapitres. Mais chaque entrée retrouvée révèle la police et la taille d'un vrai titre dans *ce* document. Parmi les titres détectés par la mise en page, seuls ceux qui portent l'un de ces styles sont ajoutés, au niveau que la table lui associe. Exercices, formules et notes, composés dans le style du corps, restent dehors.
4. **Confronter à la mise en page.** La table imprimée peut avoir été mal lue (ouvrage collectif, mise en page complexe). Si la détection typographique retrouve d'elle-même la plupart de ses entrées, les deux sources se confirment. Sinon, elles divergent, et c'est la mise en page qui l'emporte tant qu'elle reste plausible.
5. **À défaut, la mise en page seule.** Sans table des matières exploitable, la détection typographique prend le relais : découpage en colonnes, profil du corps de texte, faisceau d'indices (taille, police, numérotation, isolement), filtres des titres courants, légendes, encarts d'éditeur. Sur un ouvrage, un sommaire qui dépasse une entrée par page est élagué de son niveau le plus profond.
6. **Arbitrage par le modèle**, s'il est configuré : voir plus bas.

Les destinations pointent sur la **référence d'objet de la page**, c'est-à-dire la page telle que le lecteur la numérote. Les numéros de page imprimés ne sont jamais utilisés pour naviguer.

### Ce que cela donne

Mesuré sur une bibliothèque réelle, en prenant pour référence les documents qui possèdent un vrai sommaire d'éditeur (28 ouvrages, 80 articles), et en écartant ceux dont le sommaire avait été écrit par le plugin lui-même :

| Ouvrages (28) | Version 1.2 | Version 2.0, sans modèle |
|---|---|---|
| Précision | 54,0 % | **65,5 %** |
| Rappel | 70,6 % | 66,8 % |
| F1 médian | 80,0 % | **82,9 %** |
| F1 moyen | 58,1 % | **63,2 %** |

Les gains se concentrent là où la version 1 s'effondrait : un manuel de méthodes de 643 pages passe de 2 à 82 %, un ouvrage de gestion des risques de 48 à 94 %, un rapport de 52 à 85 %. Sur les articles (175), rien ne change (F1 médian 81 %) : un article n'a presque jamais de table des matières imprimée, et la détection typographique y reste la bonne méthode.

Avec l'arbitrage par un modèle (contrat de correction, déclenché quand table et mise en page ne concordent pas à 95 %), le F1 moyen des ouvrages passe à **70,9 %** avec Claude. Avec Mistral, le gain mesuré est plus modeste (de 76 à 79 % sur un échantillon de huit ouvrages difficiles) : le choix du modèle compte.

Ces chiffres sont plutôt pessimistes : la référence est le sommaire d'éditeur, souvent plus détaillé que la table imprimée, et parfois médiocre lui-même (entrées « p. 69 », « Slide 12 », « Halftitle »).

## Coller ou corriger le sommaire

Quand le résultat automatique déçoit (ouvrage numérisé, table des matières mal composée, mise en page inhabituelle), le plus sûr reste de fournir le sommaire soi-même : **clic droit → zotero-TOC → Coller ou corriger le sommaire…**

La fenêtre s'ouvre **déjà remplie** avec la table des matières que le plugin a trouvée dans le document, reconstituée avec ses retraits et ses numéros de page. Il suffit souvent de la relire et de corriger une ligne. Si rien n'a été trouvé, ou si la table imprimée est inexploitable, collez celle de l'ouvrage, recopiée du site de l'éditeur ou d'une notice de bibliothèque.

Le texte accepté est souple : une ligne par entrée ; la hiérarchie se lit au **retrait** (espaces ou tabulations), aux **puces**, aux **titres Markdown** (`#`, `##`) ou à la **numérotation** (`1`, `1.1`, `1.1.1`) ; les « Partie » coiffent automatiquement les chapitres qui les suivent. Les numéros de page sont reconnus après des points de conduite, une tabulation, une barre (`Titre / 39`) ou sur la ligne suivante ; ils sont facultatifs. Un chiffre qui appartient au titre (« Partie II », « Chapitre 3 », « Les années 1968 ») n'est pas pris pour une page.

Chaque intitulé est ensuite **retrouvé dans le texte**, selon le même procédé que pour la table imprimée : titres courants écartés, décalage de pagination estimé, ordre imposé. Les intitulés introuvables passent au modèle s'il est configuré (case proposée dans la fenêtre), puis, à défaut, sont placés en tête de la page que leur assigne leur numéro. L'aperçu final indique combien d'entrées ont été retrouvées, par quel moyen, et nomme celles qui restent introuvables.

Mesuré en collant les sommaires d'éditeur **sans aucun numéro de page** (cas le plus défavorable), la proportion d'intitulés placés sur la bonne page, en moyenne par document :

| | Bien placés (moyenne par document) | Médiane |
|---|---|---|
| Articles (175), sans numéros de page | **93 %** | 100 % |
| Ouvrages (28), sans numéros de page | **74 %** | 80 % |
| Ouvrages (28), avec numéros de page | **80 %** | 87 % |

Les intitulés manqués sont pour beaucoup des signets d'éditeur sans équivalent dans le texte (« Halftitle », « Copyright », « Cover »).

Cette fonction ne concerne que les PDF : un EPUB tient déjà sa structure de ses propres balises de titre.

La fenêtre est servie depuis un espace de noms `chrome://` enregistré au démarrage : un document XUL ne s'instancie pas autrement, et resterait vide s'il était chargé directement depuis l'archive du plugin.

## EPUB

Les EPUB sont traités par les mêmes entrées de menu, mais par une voie bien plus directe : un EPUB est du XHTML, où les titres sont explicitement balisés de `<h1>` à `<h6>`. Aucune heuristique typographique n'intervient : la hiérarchie est celle qu'a posée l'auteur du fichier, et le modèle n'est jamais sollicité.

Le lecteur de Zotero s'appuie sur epub.js, qui lit le document de navigation EPUB 3 (`properties="nav"`) et, à défaut, le `toc.ncx` d'EPUB 2. Le plugin réécrit celui des deux qui fait foi, et en ajoute un si aucun n'existe. Les ancres manquantes sont insérées dans les chapitres pour que chaque renvoi vise le bon titre et non le début du fichier.

Un EPUB dont le sommaire compte **moins de cinq entrées** est considéré comme dépourvu : c'est le cas typique du fichier réduit à « Démarrer », que le plugin est justement là pour réparer.

**Sûreté de l'archive.** Les entrées auxquelles on ne touche pas sont recopiées telles quelles, octets compressés compris : il n'y a donc ni recompression ni perte possible, et aucun compresseur à embarquer. Les entrées modifiées sont écrites sans compression, ce qui est légal, et `mimetype` reste la première entrée. Vérifié sur les 23 EPUB d'une bibliothèque réelle : reconstruction **à l'identique dans les 23 cas** (mêmes entrées, mêmes contenus, archives valides).

## Arbitrage par un modèle (facultatif)

Aucune règle fixe ne départage tous les cas : deux ouvrages peuvent présenter le même désaccord entre table imprimée et mise en page, l'un réclamant la table, l'autre la typographie. Un modèle de langue sait, lui, reconnaître qu'une liste ressemble à une vraie table des matières plutôt qu'à une suite d'exercices.

Le modèle reçoit **une liste unique de lignes candidates, numérotées**, chacune annotée de sa page, de sa taille et de son origine : retrouvée dans la table imprimée (avec son niveau), détectée par la mise en page, ou simple ligne plausible. Les lignes du sommaire proposé y sont marquées. Le modèle **corrige** ce sommaire : lignes à retirer (exercices, notes, titres courants, dédicaces…), lignes à ajouter, niveaux à changer.

Ce contrat de correction a remplacé une première version où le modèle reconstruisait le sommaire de zéro. La reconstruction pouvait détruire un bon résultat (un ouvrage chutait de 94 à 54 %) et, avec Mistral, rendait des listes squelettiques. La correction est plus sûre : une réponse paresseuse ne change presque rien, et la tâche, plus simple, est mieux réussie par un modèle moins puissant.

**Le modèle ne rédige jamais les titres.** Il ne renvoie que des numéros de ligne. Les intitulés, les pages et les coordonnées restent ceux extraits du fichier : un modèle ne peut ni inventer une section, ni fausser une destination ; au pire il choisit mal. Et une réponse squelettique est écartée au profit du résultat déterministe.

Réglage **Solliciter le modèle** :

- *jamais* : le plugin fonctionne entièrement sans modèle ;
- *quand les sources ne se confirment pas* (par défaut) : le modèle n'intervient que si table imprimée et mise en page ne concordent pas sur au moins 95 % des entrées, ou si aucune table n'existe. Mesuré sur 28 ouvrages, ce seuil capte presque tout le gain d'un arbitrage systématique avec un tiers d'appels en moins ;
- *toujours*.

Trois fournisseurs, réglables dans **Préférences → zotero-TOC** :

| Fournisseur | Clé requise | Données transmises |
|---|---|---|
| **Ollama** | aucune | rien ne quitte la machine |
| **Claude Code en ligne de commande** | aucune (abonnement du CLI) | les lignes candidates sont envoyées à Anthropic |
| **API Mistral** (ou compatible OpenAI) | oui | les lignes candidates sont envoyées au service |

Le bouton **Tester le modèle** vérifie la configuration sur un jeu d'essai avant tout traitement par lot.

## Sûreté du fichier

L'écriture se fait par **mise à jour incrémentale** : les octets d'origine ne sont jamais réécrits, le sommaire est ajouté à la fin du fichier. Un PDF signé, annoté ou exotique ne peut donc pas être corrompu ; au pire l'ajout est ignoré par le lecteur.

Cette approche a été vérifiée sur 483 PDF réels :

- 451 fichiers réécrits, **451 sommaires relus fidèlement** par une bibliothèque tierce (PyMuPDF) ;
- **aucun avertissement `qpdf` introduit**, sur 183 fichiers pourtant déjà imparfaits avant traitement ;
- les PDF chiffrés sont détectés et refusés plutôt que traités.

La décompression FlateDecode est implémentée en JavaScript pur, et non déléguée à `DecompressionStream` : ces API du DOM n'existent pas dans le contexte système où s'exécute un plugin Zotero. Elle a été vérifiée octet par octet contre la référence du système sur 2 744 flux.

Par prudence supplémentaire, une copie du fichier d'origine est conservée avant modification dans `zotero-TOC-backups`, au sein du répertoire de données de Zotero (réglage désactivable).

À noter : modifier un PDF change son empreinte, Zotero le renverra donc au serveur à la prochaine synchronisation.

## Diagnostic

Si le traitement échoue et que le message ne suffit pas, réglez ces préférences cachées (`Préférences → Avancées → Éditeur de configuration`) :

- `extensions.zotero.ztoc.diagnosticOut` : chemin du rapport JSON à écrire ;
- `extensions.zotero.ztoc.diagnosticPdf` : un ou plusieurs chemins de PDF, séparés par `|`. La chaîne réelle est déroulée (modèle compris s'il est configuré) et le résultat écrit dans une copie `.ztoc-diagnostic.pdf`, jamais dans la bibliothèque ;
- `extensions.zotero.ztoc.diagnosticForceAI` et `extensions.zotero.ztoc.diagnosticAIContract` (`edit` ou `select`) : forcer l'arbitrage du modèle, et en choisir la forme, pour ce diagnostic seulement ;
- `extensions.zotero.ztoc.diagnosticItemKey` : clé d'un item de la bibliothèque, pour dérouler le traitement exactement comme le fait le menu (le fichier est alors modifié) ;
- `extensions.zotero.ztoc.diagnosticDialog` : ouvre la fenêtre de collage au démarrage et vérifie qu'elle s'instancie réellement.

Au démarrage suivant, le plugin déroule la chaîne. Le rapport est réécrit à chaque étape dans `<diagnosticOut>.partiel` : si le traitement se fige, la dernière ligne désigne l'étape fautive. Laissez `diagnosticOut` vide pour désactiver.

Aucun document ne peut figer le plugin : l'ouverture d'un PDF, chaque page et la fermeture ont une durée maximale, au-delà de laquelle la page est sautée, ou le document abandonné avec un message clair si pdf.js ne répond plus.

## Développement

```sh
./build.sh
```

produit le `.xpi` installable. Pour travailler sur les sources sans reconstruire à chaque fois, placez dans le dossier `extensions` de votre profil Zotero un fichier nommé `zotero-toc@equiriconi` contenant le chemin absolu du dépôt.

Les modules de `lib/` n'ont aucune dépendance et sont conçus pour tourner aussi bien dans Zotero que dans Node, ce qui permet de les éprouver sur un corpus de PDF hors de l'application.

| Fichier | Rôle |
|---|---|
| `lib/pipeline.js` | choix de la source : table des matières imprimée, approfondissement par les styles, arbitrage avec la mise en page |
| `lib/toc-paste.js` | lecture d'un sommaire (collé ou imprimé) et localisation de ses intitulés dans le texte |
| `lib/detect.js` | détection typographique des titres et de leur hiérarchie |
| `lib/extract.js` | extraction des lignes et de leur typographie, découpage en colonnes (via le pdf.js de Zotero) |
| `lib/ai.js` | arbitrage facultatif par un modèle |
| `lib/pdf-lib.js` | lecture de la structure d'un PDF, écriture du sommaire par mise à jour incrémentale |
| `lib/zip.js` | lecture et réécriture d'archives ZIP, sans recompression |
| `lib/epub.js` | relevé des titres d'un EPUB et génération de son document de navigation |

### Banc d'essai

`tools/bench/` mesure la qualité sur votre propre bibliothèque Zotero, en prenant pour référence les PDF qui possèdent un vrai sommaire d'éditeur :

```sh
python3 tools/bench/build-reference.py      # constitue les références
node tools/bench/bench.mjs books 999 pipeline  # ouvrages, chaîne complète
node tools/bench/bench.mjs articles 999 pipeline
node tools/bench/paste-bench.mjs books 999     # fonction de collage
MODE=edit node tools/bench/ai-bench.mjs books  # apport du modèle (Claude en ligne de commande)
```

Le pdf.js de Zotero doit être extrait au préalable dans `tools/bench/data/omni/` (voir `tools/bench/common.mjs`). Les sommaires écrits par le plugin lui-même sont exclus des références : il serait sinon comparé à son propre travail.

## Licence

MIT.
