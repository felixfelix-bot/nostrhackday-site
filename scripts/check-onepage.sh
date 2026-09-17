#!/usr/bin/env bash
# Static sanity checks for the one-page redesign.
set -uo pipefail
cd "$(dirname "$0")/.."

echo "== required strings in index.html =="
for s in 'September 29th, 2026' '>Tuesday<' '29.09.2026' 'Two days before bitcoin++' 'https://btcpp.dev/' 'https://btcpp.dev/berlin26' 'https://x.com/CashuBTC/status/2099845950768324657' 'Ecash Hackday' 'fingerprint-grid' 'Mining your RSVP' 'SIGN UP'; do
  n=$(grep -c -F -- "$s" index.html)
  printf '  %-28s %s\n' "$s" "$n"
done

echo "== duplicate ids in index.html =="
grep -o 'id="[^"]*"' index.html | sort | uniq -d

echo "== ids looked up by js/signup.js that are MISSING from index.html =="
missing=0
for id in $(grep -oE "\\\$\('[A-Za-z0-9_-]+'\)" js/signup.js | sed -E "s/.*\('(.*)'\)/\1/" | sort -u); do
  if ! grep -q "id=\"$id\"" index.html; then echo "  MISSING: $id"; missing=1; fi
done
[ "$missing" = 0 ] && echo "  none"

echo "== ids present in BOTH signup.html and index.html (must be only cta-free ones) =="
comm -12 <(grep -o 'id="[^"]*"' signup.html | sort -u) <(grep -o 'id="[^"]*"' index.html | sort -u) || true

echo "== signup.html redirect markers =="
grep -c -F 'http-equiv="refresh"' signup.html
grep -c -F "location.replace('index.html#signup')" signup.html
grep -c -F 'href="index.html#signup"' signup.html

echo "== module syntax check =="
tmp=$(mktemp -d)
cp js/viz.js "$tmp/viz.mjs"
cp js/signup.js "$tmp/signup.mjs"
for f in "$tmp/viz.mjs" "$tmp/signup.mjs"; do
  if node --check "$f" 2>&1; then echo "  ok $(basename "$f")"; else echo "  FAIL $(basename "$f")"; fi
done
rm -rf "$tmp"
