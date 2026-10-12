# Sunset Heresy Campaign Tracker

Horus Heresy-style campaign tracker for the Sunset Heresy campaign.

## Stack
- Node.js static file server + JSON REST API (`server.js`)
- HTML/JS front-end (campaign map, player admin, forces, systems, games, rules)
- File-based JSON data in `data/`

## Quick start
```bash
npm start
# open http://localhost:3847
```

## Deploy (Render)
- Runtime: Node
- Build: `npm install`
- Start: `npm start`
- For production persistence: attach a Render persistent disk mounted at `data/`

## Archive
Previous TypeScript/Prisma/Vite build is preserved on branch `archive/previous-build`.

## Migration status (Oct 2026)
- `archive/previous-build` holds the old code.
- `main` has the new `package.json`, README, sample `data/`, and partial cleanup of the old `frontend/` / `backend/` trees.
- Full application sources (`server.js`, HTML pages, `js/`) still need a complete local push if placeholders remain.

To finish from a machine that has the full project:
```bash
git clone https://github.com/orangespacegeek/HH-Map-Campaign-Interface.git
cd HH-Map-Campaign-Interface
# copy full project files over, then:
git add -A
git commit -m "Complete Sunset Heresy Node + static HTML build"
git push origin main
```
