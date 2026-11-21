#!/usr/bin/env bash
# Adds the PWA links and service worker registration to index.html. Safe to run twice.
set -e
cd "$(dirname "$0")"
f=index.html
[ -f "$f" ] || { echo "index.html not found in this folder"; exit 1; }
if grep -q 'manifest.webmanifest' "$f"; then
  echo "index.html already has the PWA links, nothing changed"
  exit 0
fi
cp "$f" index.html.bak

sed -i 's#</head>#<link rel="manifest" href="manifest.webmanifest">\n<meta name="theme-color" content="\#141414">\n<link rel="icon" type="image/png" href="favicon.png">\n<link rel="apple-touch-icon" href="apple-touch-icon.png">\n<meta name="mobile-web-app-capable" content="yes">\n<meta name="apple-mobile-web-app-capable" content="yes">\n<meta name="apple-mobile-web-app-title" content="BRO, WHAT?!">\n</head>#' "$f"

if ! grep -q 'name="viewport"' "$f"; then
  sed -i 's#</head>#<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>#' "$f"
fi

sed -i "s#</body>#<script>if('serviceWorker' in navigator){addEventListener('load',function(){navigator.serviceWorker.register('sw.js').catch(function(){})})}</script>\n</body>#" "$f"

# swap the missing-glyph chip emoji for one every Android and Linux font has
sed -i "s/\['[^']*','Health Concerns'/['🩺','Health Concerns'/" "$f"

echo "manifest links:  $(grep -c 'manifest.webmanifest' "$f")  (want 1)"
echo "sw register:     $(grep -c "register('sw.js')" "$f")  (want 1)"
echo "health chip:     $(grep -c "'🩺','Health Concerns'" "$f")  (want 1)"
echo "backup saved as index.html.bak (do not commit it)"
