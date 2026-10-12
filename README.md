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
