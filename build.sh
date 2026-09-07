#!/bin/sh
# Fabrique le XPI installable à partir des sources.
set -e
cd "$(dirname "$0")"
VERSION=$(node -p "require('./manifest.json').version")
OUT="zotero-toc-${VERSION}.xpi"
rm -f "$OUT"
zip -qr "$OUT" \
    manifest.json bootstrap.js prefs.js \
    preferences.xhtml preferences.js \
    content \
    lib \
    -x '*.DS_Store'
echo "$OUT  ($(wc -c < "$OUT" | tr -d ' ') octets)"
echo "sha256:$(shasum -a 256 "$OUT" | cut -d' ' -f1)"
