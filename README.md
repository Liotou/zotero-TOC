# zotero-TOC

Extension Zotero (7 à 10) qui **génère le sommaire manquant d'un PDF ou d'un EPUB et l'inscrit dans le fichier**, afin que le volet « Sommaire » du lecteur Zotero devienne utilisable.

Plus de la moitié des PDF d'une bibliothèque de recherche n'ont aucun signet : le volet reste vide et l'on navigue à la molette. zotero-TOC reconstitue la structure à partir de la mise en page, puis l'écrit dans le PDF lui-même — le sommaire reste donc valable hors de Zotero, dans n'importe quel lecteur.

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
| **Générer le sommaire (avec aperçu)…** | Affiche les titres détectés et demande confirmation avant d'écrire. |
| **Régénérer en remplaçant le sommaire existant** | Le seul moyen d'écraser un sommaire déjà présent. |
| **Générer avec l'appui du modèle** | Force le recours au modèle configuré, même si la détection semblait sûre. |
| **Coller un sommaire…** | Vous fournissez le sommaire, le plugin le retrouve dans le document. Voir ci-dessous. |

Ouvrez ensuite le document et affichez le volet « Sommaire » du lecteur.

Un document qui possède déjà un sommaire n'est **jamais** modifié, sauf demande explicite : le sommaire d'origine de l'éditeur est presque toujours meilleur qu'une détection automatique.

## Comment les titres sont détectés

La détection est d'abord **typographique**, et fonctionne sans aucun modèle ni connexion :

1. **Découpage en colonnes.** Les gouttières verticales sont repérées afin de ne jamais fusionner deux colonnes en une seule ligne. C'est l'étape déterminante sur les revues scientifiques : sans elle, « 1 Introduction » se retrouve collé au corps du texte voisin et devient indétectable.
2. **Profil du document.** Le style le plus employé, en nombre de caractères, définit le corps de texte. Tout ce qui s'en écarte devient candidat.
3. **Faisceau d'indices.** Taille relative, police distincte, numérotation (`3.2 Méthode`), lexique de sections usuelles, isolement vertical, longueur de la ligne.
4. **Filtres.** Sont écartés : titres courants (y compris ceux dont le folio est en chiffres romains), pages de table des matières et d'index imprimées, intitulés qui se répètent à l'identique, légendes de figures, mentions d'éditeur et encarts juridiques.
5. **Hiérarchie.** Le niveau vient de la numérotation lorsqu'elle existe, sinon d'un regroupement des tailles de police en quatre paliers au maximum.

Les destinations pointent sur la **référence d'objet de la page**, c'est-à-dire la page telle que le lecteur la numérote. Les numéros de page imprimés ne sont jamais utilisés pour naviguer : dans un ouvrage dont la pagination démarre après les pages liminaires, un chapitre annoncé « page 1 » au sommaire imprimé est bien atteint à la page 20 du lecteur.

### Ce que cela donne

Mesuré sur 70 documents d'une bibliothèque réelle possédant un vrai sommaire d'éditeur, servant de référence :

| | |
|---|---|
| Précision moyenne | **79 %** |
| Rappel moyen | **78 %** |
| F1 médian | **86 %** |
| Documents au-dessus de 70 % de F1 | **53 / 70** |

Ces chiffres sont plutôt pessimistes : une partie des sommaires de référence sont eux-mêmes médiocres (numérisations dont les entrées sont « p. 69 », « image 3 », ou des exports PowerPoint intitulés « Slide 12 : … »), et comptent comme des échecs alors que la détection est correcte.

## Coller un sommaire

Quand la détection automatique déçoit — ouvrage numérisé, mise en page inhabituelle, titres sans marque typographique —, le plus sûr reste de fournir le sommaire soi-même : **clic droit → zotero-TOC → Coller un sommaire…**

Recopiez-le de la page « Table des matières » du document, du site de l'éditeur, du dos de l'ouvrage. Le plugin ne se contente pas de l'enregistrer : il **retrouve chaque intitulé dans le texte** et pointe la destination sur son début réel.

Deux difficultés sont traitées explicitement, et ce sont elles qui font tout l'intérêt de la fonction :

**Les titres se répètent en tête de page.** Un titre de chapitre figure souvent en haut de chacune de ses pages. Chercher naïvement le texte renverrait une de ces répétitions. Les titres courants sont donc repérés et fortement pénalisés, la taille de police et la position dans la page départagent le reste, et l'ordre du sommaire est imposé globalement : les destinations doivent former une suite de pages croissantes, ce qui élimine d'un coup les occurrences isolées.

**Les numéros de page imprimés ne sont pas ceux du lecteur.** Un ouvrage paginé après ses pages liminaires les décale d'une vingtaine de pages. Ce décalage est **estimé automatiquement** sur les intitulés les plus sûrs, puis sert d'indice pour les autres. Les numéros collés ne servent jamais de destination — seulement de faisceau de présomptions.

Les numéros de page sont donc facultatifs : un sommaire recopié sans pagination fonctionne. L'indentation, elle, est lue comme la hiérarchie.

Mesuré sur 30 documents dont le sommaire d'éditeur sert de référence, en fournissant les intitulés **sans aucun numéro de page** (le cas le plus défavorable) :

| | |
|---|---|
| Intitulé placé sur la bonne page | **84 %** |
| À une page près | 2 % |
| Non retrouvé dans le texte | 12 % |

Avec les numéros de page imprimés, la précision est nettement meilleure. Sur l'ouvrage qui avait motivé la fonction, les dix entrées sont retrouvées exactement, décalage de pagination estimé à 19 pages.

Les intitulés qui restent introuvables — texte du sommaire différent de celui du corps, numérisation approximative — peuvent être soumis au modèle, qui **choisit parmi des lignes réellement présentes** dans le document, sans jamais en rédiger. La case est proposée dans la fenêtre de collage lorsqu'un fournisseur est configuré.

Cette fonction ne concerne que les PDF : un EPUB tient déjà sa structure de ses propres balises de titre.

La fenêtre est servie depuis un espace de noms `chrome://` enregistré au démarrage : un document XUL ne s'instancie pas autrement, et resterait vide s'il était chargé directement depuis l'archive du plugin.

## EPUB

Les EPUB sont traités par les mêmes entrées de menu, mais par une voie bien plus directe : un EPUB est du XHTML, où les titres sont explicitement balisés `<h1>`–`<h6>`. Aucune heuristique typographique n'intervient — la hiérarchie est celle qu'a posée l'auteur du fichier, et le modèle n'est jamais sollicité.

Le lecteur de Zotero s'appuie sur epub.js, qui lit le document de navigation EPUB 3 (`properties="nav"`) et, à défaut, le `toc.ncx` d'EPUB 2. Le plugin réécrit celui des deux qui fait foi, et en ajoute un si aucun n'existe. Les ancres manquantes sont insérées dans les chapitres pour que chaque renvoi vise le bon titre et non le début du fichier.

Un EPUB dont le sommaire compte **moins de cinq entrées** est considéré comme dépourvu : c'est le cas typique du fichier réduit à « Démarrer », que le plugin est justement là pour réparer.

**Sûreté de l'archive.** Les entrées auxquelles on ne touche pas sont recopiées telles quelles, octets compressés compris — il n'y a donc ni recompression ni perte possible, et aucun compresseur à embarquer. Les entrées modifiées sont écrites sans compression, ce qui est légal, et `mimetype` reste la première entrée. Vérifié sur les 23 EPUB d'une bibliothèque réelle : reconstruction **à l'identique dans les 23 cas** (mêmes entrées, mêmes contenus, archives valides).

## Appui d'un modèle (facultatif)

Certains PDF ne se laissent pas analyser de façon déterministe : mise en page inhabituelle, titres sans aucune marque typographique, océrisation approximative. Un modèle peut alors prendre le relais.

Trois fournisseurs, réglables dans **Préférences → zotero-TOC** :

| Fournisseur | Clé requise | Données transmises |
|---|---|---|
| **Ollama** | aucune | rien ne quitte la machine |
| **Claude Code en ligne de commande** | aucune (abonnement du CLI) | rien ne quitte la machine |
| **API Mistral** (ou compatible OpenAI) | oui | les lignes candidates sont envoyées au service |

Réglage `Solliciter le modèle` : *jamais*, *en cas de doute seulement* (par défaut), ou *toujours*.

**Le modèle ne rédige jamais les titres.** On lui soumet une liste numérotée de lignes réellement présentes dans le PDF ; il ne renvoie que des numéros de ligne assortis d'un niveau. Les intitulés, les pages et les coordonnées restent ceux extraits du fichier. Un modèle ne peut donc ni inventer une section, ni fausser une destination — au pire il choisit mal.

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

Si le traitement échoue et que le message ne suffit pas, réglez ces deux préférences cachées (`about:config` de Zotero, ou `Préférences → Avancées → Éditeur de configuration`) :

- `extensions.zotero.ztoc.diagnosticOut` : chemin du rapport JSON à écrire ;
- `extensions.zotero.ztoc.diagnosticPdf` : chemin d'un PDF à analyser ;
- `extensions.zotero.ztoc.diagnosticItemKey` : clé d'un item de la bibliothèque, pour dérouler le traitement exactement comme le fait le menu ;
- `extensions.zotero.ztoc.diagnosticDialog` : ouvre la fenêtre de collage au démarrage et vérifie qu'elle s'instancie réellement.

Au démarrage suivant, le plugin déroule la chaîne complète et consigne l'étape fautive. Laissez `diagnosticOut` vide pour désactiver.

## Développement

```sh
./build.sh
```

produit le `.xpi` installable. Pour travailler sur les sources sans reconstruire à chaque fois, placez dans le dossier `extensions` de votre profil Zotero un fichier nommé `zotero-toc@equiriconi` contenant le chemin absolu du dépôt.

Les modules de `lib/` n'ont aucune dépendance et sont conçus pour tourner aussi bien dans Zotero que dans Node, ce qui permet de les éprouver sur un corpus de PDF hors de l'application.

| Fichier | Rôle |
|---|---|
| `lib/pdf-lib.js` | lecture de la structure d'un PDF, écriture du sommaire par mise à jour incrémentale |
| `lib/extract.js` | extraction des lignes et de leur typographie, découpage en colonnes (via le pdf.js de Zotero) |
| `lib/detect.js` | détection des titres et de leur hiérarchie |
| `lib/ai.js` | appui facultatif d'un modèle |
| `lib/toc-paste.js` | analyse d'un sommaire collé et localisation des intitulés dans le document |
| `lib/zip.js` | lecture et réécriture d'archives ZIP, sans recompression |
| `lib/epub.js` | relevé des titres d'un EPUB et génération de son document de navigation |

## Licence

MIT.
