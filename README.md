# HH-Map-Campaign-Interface

Warhammer 40,000 500 Worlds Map Campaign Web App
500 Worlds: Titus – War on the Vespator Front system. A map/sticker campaign from the recent GW release.
App supports:
- Interactive sector map (planets/systems as nodes).
- Alliances/Factions (e.g., 2–3 teams: Imperials, Chaos, Xenos/Necrons, customizable).
- Power Levels (1–4 per planet, with strongholds).
- Infrastructure (strongholds, staging grounds, fortifications, etc.).
- Campaign Phases (multi-month turns with Operations: attacks, builds, moves).
- Battle tracking (link to missions, results updating control/power).
- Theaters of War and special rules (e.g., Xenoflora effects).
- User accounts/roles for players, GM ("Warmaster"), and viewers.


Tech Stack
- Frontend: React + Vite + TypeScript + Tailwind CSS + Leaflet.js (for interactive maps) or Konva.js/SVG for node-based maps.
- Backend: Node.js + Express + TypeScript.
- Database: SQLite (via Prisma) for simplicity; easy to swap to PostgreSQL.
- Auth: Simple JWT or Clerk/Firebase (expandable).
- Deployment: Ready for Vercel/Netlify (frontend) + Render/Heroku (backend).

Tools used Windows, Git Bash, GitHub, Notepad++