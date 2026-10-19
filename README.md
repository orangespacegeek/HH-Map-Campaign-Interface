# Sunset Heresy Campaign Tracker

Horus Heresy-style map campaign for the Port Maw sub-sector. Players open it from Discord, mostly on phones. A campaign admin runs the turn. Everyone else can look at the map, and signed-in players move forces, log battles, and confirm results.

## Features

- Invite sign-up. The admin issues a code. The tester chooses their own username and password.
- Campaign turns: Logistics, Movement, Battles. Two actions per turn. The dashboard shows the live turn, scores, recent battles, and phase log. Turn controls are on the dashboard for the campaign admin.
- Map actions: move, hold, reinforce, fortify, and generate force, checked against the rules.
- Battle log with named players and forces. A result applies when the opponent confirms it. The admin can apply, void, or resolve a dispute. Actions waiting shows what still needs a person.
- My account: a player edits their display name, contact, and notes, and changes their password.
- Feedback: signed-in players send a note the admin can read. Optional Discord webhook, off unless configured.
- Admin backup download, and a reset that starts turn 1 / Logistics with two forces per player without deleting accounts.

## Local quick start

```bash
npm start
# open http://localhost:3847
```

Node 18 or newer. The server is `server.js` (static files plus a JSON API). There is no separate build step.

The campaign admin login defaults to `admin`. There is no published password.

- Set `CAMPAIGN_ADMIN_PASSWORD` before the first boot to choose it.
- If that variable is missing when the admin account is created, the server generates a random password and prints it once (`CAMPAIGN_ADMIN_INITIAL_PASSWORD` in the log). It is not written down anywhere else.
- The old prototype password is rejected in production (`NODE_ENV=production` or Render).

To rotate the admin password and sign everyone out, set both of these on the host and restart:

```bash
CAMPAIGN_ADMIN_PASSWORD=the-new-password
CAMPAIGN_ADMIN_FORCE_PASSWORD=1
```

The restart re-hashes the admin account and deletes `data/sessions.json`. Sign in with the new password, then remove `CAMPAIGN_ADMIN_FORCE_PASSWORD` so a later password change is not overwritten on the next deploy.

## Environment variables

| Variable | Required | What it does |
| --- | --- | --- |
| `PORT` | No | HTTP port. Default `3847`. Render sets this. |
| `HOST` | No | Bind address. Default `0.0.0.0`. |
| `DATA_DIR` | No | Directory for campaign JSON. Default `./data`. On Render, point this at the persistent disk (the blueprint uses `/var/data`). |
| `CAMPAIGN_ADMIN_LOGIN` | No | Admin username. Default `admin`. |
| `CAMPAIGN_ADMIN_PASSWORD` | Production | Password used when the admin account is created, and when a force-reset runs. |
| `CAMPAIGN_ADMIN_FORCE_PASSWORD` | No | Set to `1` with `CAMPAIGN_ADMIN_PASSWORD` to re-hash the admin and delete every session on boot. Remove it after that restart. |
| `NODE_ENV` | No | `production` rejects the old published admin password. |
| `CORS_ORIGINS` | No | Comma-separated extra browser origins allowed to call the API with cookies. Same-origin is always allowed. Leave unset for a normal single-site deploy. |
| `DISCORD_FEEDBACK_WEBHOOK` | No | Discord webhook URL. When set, new feedback is also posted to that channel. Unset means feedback is stored only. |
| `MAX_BODY_BYTES` | No | Request body limit. Default `1048576` (1 MB). |

`data/accounts.json`, `data/sessions.json`, `data/invites.json`, `data/notifications.json`, and `data/feedback.json` are created on first use and are gitignored. Do not commit them. The sample players, forces, systems, games, and meta in `data/` are the demo campaign and are tracked. `data/baseline/systems.json` is the Port Maw map a reset restores.

The static server only serves HTML pages, `js/`, `css/`, and images. `data/`, `schema/`, server source, and dotfiles are not on the web.

## Inviting testers

The campaign admin only issues a code. The tester creates their own login and player record.

1. Sign in as the campaign admin and open **Players**.
2. Under **Tester invites**, optionally add a note, an expiry in days, and a use limit (default is one use), then choose **Generate code**.
3. Copy the code and send it to the tester with the site URL.
4. The tester opens **Log in → Sign up** (`login.html?tab=signup`), enters the code, and fills in their own username, password, player name, display name, contact, and allegiance.
5. The server checks the code, rejects it if it is missing, used up, revoked, or expired, and stores the password with the same scrypt hash as other accounts. The username they choose is how they sign in after the code is consumed.
6. Sign-up signs them in. Later they use **Sign in** with that username and password.

Codes are 16 characters (about 78 bits). Login and sign-up are limited per IP (30 login attempts and 15 sign-ups per 15 minutes). A fresh code for someone who already has an account does not clear their password.

The invite table shows whether each code is active, used, revoked, or expired, and who used it. **Revoke** stops an unused or still-open code immediately. On Render, keep the persistent disk mounted at `DATA_DIR` so invites, accounts, and players survive restarts. See [DEPLOY_RENDER.md](DEPLOY_RENDER.md).

## Starting a fresh campaign

The files in `data/` are a sample already in progress (turn 3, Battles, one force). A fresh campaign is turn 1, Logistics, with two strength-3 forces per player in that player's starting system. Accounts are kept.

From the dashboard, as campaign admin:

1. Leave **Keep current system control** unchecked to restore the Port Maw starting map from `data/baseline/systems.json`. Check it only if you have edited system loyalty and want to keep that.
2. Choose **Reset campaign** and type `RESET`.

Or from a shell, with `DATA_DIR` set if the live data is not `./data`:

```bash
npm run reset-campaign
npm run reset-campaign -- --keep-systems
npm run reset-campaign -- --purge-accounts
```

`--purge-accounts` is the only switch that deletes logins. It removes player accounts and sessions and leaves the campaign admin. The player roster stays. Do not use it for a normal fresh start.

Reset clears battles, notifications, scores, the victor, and private action notes. It does not remove the admin account.

Before a reset on a live game, use **Download backup** on the dashboard. The file includes players, forces, systems, games, meta (including private action notes), invites, notifications, and feedback. Password hashes and sessions are left out. Invite codes are included, so treat the file as secret.

## Project structure

- `server.js` — API and static server
- `index.html` — dashboard
- `campaign_map.html`, `js/map.js` — sector map
- `actions.html` — results waiting on a player
- `forces.html`, `systems.html`, `games.html`, `rules.html`
- `player_admin.html` — roster and invites
- `login.html`, `account.html`, `feedback.html`
- `js/api.js` — browser client
- `data/` — campaign JSON; `data/baseline/systems.json` is the reset map
- `schema/` — field templates, not served
- `render.yaml` — Render blueprint
- [DEPLOY_RENDER.md](DEPLOY_RENDER.md) — deploy someone else's copy

## Deploy

[DEPLOY_RENDER.md](DEPLOY_RENDER.md) is the step-by-step for a new Render service. The short version: Node, build `npm install`, start `npm start`, persistent disk mounted at `DATA_DIR`, and `CAMPAIGN_ADMIN_PASSWORD` set in the host environment. Free Render instances have no disk and sleep when idle, so a campaign that must keep its data needs a paid instance.

Git history still contains the old admin hash, invite code, and session tokens from before they were untracked. Treat them as public. Rotating the password and wiping sessions is required.

The previous TypeScript/Prisma/Vite build is on branch `archive/previous-build`.
