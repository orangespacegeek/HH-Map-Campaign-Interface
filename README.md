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
Previous TypeScript/Prisma/Vite build is on branch `archive/previous-build`.

## Status (Oct 2026)
**Done on main**
- Old `frontend/` and `backend/` trees removed
- New `package.json`, `campaign_rules.md`, `rules.html`
- Sample `data/` (players, forces, games, systems, meta)
- Schema stubs

**Still needed (copy from local project)**
- `server.js` (full Node API)
- `index.html`, `campaign_map.html`, `login.html`, `player_admin.html`, `forces.html`, `systems.html`, `games.html`
- `js/api.js`, `js/map.js`
- `Sunset Heresy-ff-02.png` logo

```bash
git clone https://github.com/orangespacegeek/HH-Map-Campaign-Interface.git
cd HH-Map-Campaign-Interface
# copy the files above from your project folder, then:
git add -A && git commit -m "Add remaining Sunset Heresy app sources" && git push origin main
```
