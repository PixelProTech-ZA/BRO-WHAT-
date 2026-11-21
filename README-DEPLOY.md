# BRO, WHAT?! - one flat folder

Files: index.html admin.html manifest.json sw.js icon-192.png icon-512.png icon-maskable-512.png
       api-worker.js wrangler.toml (backend, stays local via .gitignore)

1. nano wrangler.toml            -> set OPENROUTER_MODEL
2. wrangler deploy               -> copy the printed Worker URL
3. wrangler secret put OPENROUTER_API_KEY
   wrangler secret put ADMIN_PASSWORD
4. sed -i 's|name="api-base" content=""|name="api-base" content="YOUR_WORKER_URL"|' index.html admin.html
5. git add -A && git commit -m "update" && git push
