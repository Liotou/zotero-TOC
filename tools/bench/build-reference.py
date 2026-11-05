# Constitue les sommaires de référence à partir des PDF de la bibliothèque
# qui possèdent un vrai sommaire d'éditeur. Écarte ceux que le plugin a
# lui-même écrits (ils ont une copie dans zotero-TOC-backups) : les comparer
# au plugin reviendrait à le comparer à lui-même.
import fitz, json, glob, os, io, re, sys
data = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
junk = re.compile(r'^(?:p\.?\s*\d+|image\s*\d+|page\s*\d+|\d+|contents?|cover|untitled|slide\s*\d+.*|front ?matter|back ?matter)$', re.I)
written = {os.path.basename(b).split("_")[0] for b in glob.glob(os.path.expanduser("~/Zotero/zotero-TOC-backups/*"))}
def ok(t):
    if len(t) < 5: return False
    nj = sum(1 for e in t if junk.match(e[1])); ns = sum(1 for e in t if len(re.findall(r'\w', e[1])) < 3)
    bad = sum(1 for e in t if e[2] < 1)
    return nj/len(t) <= .15 and ns/len(t) <= .15 and bad/len(t) <= .1 and len(set(e[1].lower() for e in t)) >= len(t)*.75
books, arts = [], []
for f in glob.glob(os.path.expanduser("~/Zotero/storage/**/*.pdf"), recursive=True):
    if f.split("/")[-2] in written: continue
    try:
        d = fitz.open(f)
        if d.is_encrypted: d.close(); continue
        t = [[lv, ti.encode("utf-8", "replace").decode("utf-8", "replace").strip(), pg] for lv, ti, pg in d.get_toc()]
        if ok(t): (books if d.page_count >= 60 else arts).append({"file": f, "pages": d.page_count, "toc": t})
        d.close()
    except Exception: pass
io.open(os.path.join(data, "books.json"), "w", encoding="utf-8").write(json.dumps(books, ensure_ascii=False))
io.open(os.path.join(data, "articles.json"), "w", encoding="utf-8").write(json.dumps(arts, ensure_ascii=False))
print("ouvrages :", len(books), "| articles :", len(arts), "| exclus (écrits par le plugin) :", len(written))
