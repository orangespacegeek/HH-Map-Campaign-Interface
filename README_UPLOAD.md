# Sunset Heresy – files to push to GitHub

These files complete the migration of:
https://github.com/orangespacegeek/HH-Map-Campaign-Interface

## Quick upload

```bash
git clone https://github.com/orangespacegeek/HH-Map-Campaign-Interface.git
cd HH-Map-Campaign-Interface

# Unzip this archive into the repo root (overwrite placeholders)
unzip -o path/to/sunset-heresy-upload.zip -d .

git add -A
git commit -m "Complete Sunset Heresy Node + static HTML build"
git push origin main
```

## Contents

- server.js – Node API + static server
- package.json
- HTML pages (index, map, login, admin, forces, systems, games, rules)
- js/api.js, js/map.js
- data/*.json – sample campaign data
- schema/*.csv – templates / field defs
- campaign_rules.md
- Sunset Heresy-ff-02.png – logo

Old TypeScript/Prisma build remains on branch `archive/previous-build`.
