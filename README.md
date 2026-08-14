# zotero-TOC

Extension Zotero (7, 8, 9) qui **génère le sommaire manquant d'un PDF et l'inscrit dans le fichier**, afin que le volet « Sommaire » du lecteur Zotero devienne utilisable.

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

Ouvrez ensuite le PDF et affichez le volet « Sommaire » du lecteur.

Un PDF qui possède déjà un sommaire n'est **jamais** modifié, sauf demande explicite : le sommaire d'origine de l'éditeur est presque toujours meilleur qu'une détection automatique.

## Comment les titres sont détectés

La détection est d'abord **typographique**, et fonctionne sans aucun modèle ni connexion :

1. **Découpage en colonnes.** Les gouttières verticales sont repérées afin de ne jamais fusionner deux colonnes en une seule ligne. C'est l'étape déterminante sur les revues scientifiques : sans elle, « 1 Introduction » se retrouve collé au corps du texte voisin et devient indétectable.
2. **Profil du document.** Le style le plus employé, en nombre de caractères, définit le corps de texte. Tout ce qui s'en écarte devient candidat.
3. **Faisceau d'indices.** Taille relative, police distincte, numérotation (`3.2 Méthode`), lexique de sections usuelles, isolement vertical, longueur de la ligne.
4. **Filtres.** Titres courants, numéros de page, pages de table des matières imprimée, légendes de figures, mentions d'éditeur et encarts juridiques sont écartés.
5. **Hiérarchie.** Le niveau vient de la numérotation lorsqu'elle existe, sinon d'un regroupement des tailles de police en quatre paliers au maximum.

### Ce que cela donne

Mesuré sur 70 documents d'une bibliothèque réelle possédant un vrai sommaire d'éditeur, servant de référence :

| | |
|---|---|
| Précision moyenne | **78 %** |
| Rappel moyen | **78 %** |
| F1 médian | **85 %** |
| Documents au-dessus de 70 % de F1 | **52 / 70** |

Ces chiffres sont plutôt pessimistes : une partie des sommaires de référence sont eux-mêmes médiocres (numérisations dont les entrées sont « p. 69 », « image 3 », ou des exports PowerPoint intitulés « Slide 12 : … »), et comptent comme des échecs alors que la détection est correcte.

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

Par prudence supplémentaire, une copie du fichier d'origine est conservée avant modification dans `zotero-TOC-backups`, au sein du répertoire de données de Zotero (réglage désactivable).

À noter : modifier un PDF change son empreinte, Zotero le renverra donc au serveur à la prochaine synchronisation.

## Diagnostic

Si le traitement échoue et que le message ne suffit pas, réglez ces deux préférences cachées (`about:config` de Zotero, ou `Préférences → Avancées → Éditeur de configuration`) :

- `extensions.zotero.ztoc.diagnosticPdf` : chemin d'un PDF à analyser ;
- `extensions.zotero.ztoc.diagnosticOut` : chemin du rapport JSON à écrire.

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

## Licence

MIT.
