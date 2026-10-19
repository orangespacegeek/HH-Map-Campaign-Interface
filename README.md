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

Default admin login: `admin` / `change-me`  
(override with `CAMPAIGN_ADMIN_PASSWORD`)

## Inviting testers

The campaign admin only issues a code. The tester creates their own login and player record.

1. Sign in as the campaign admin and open **Players**.
2. Under **Tester invites**, optionally add a note, an expiry in days, and a use limit (default is one use), then choose **Generate code**.
3. Copy the code and send it to the tester with the site URL.
4. The tester opens **Log in → Sign up** (`login.html?tab=signup`), enters the code, and fills in their own username, password, player name, display name, contact, and allegiance.
5. The server checks the code, rejects it if it is missing, used up, revoked, or expired, and stores the password with the same scrypt hash as other accounts. The tester chooses their own username; it is stored on the account and must be unique. That username is how they sign in after the code is consumed.
6. Sign-up signs them in. Later they use **Sign in** with that username and password.

Codes are 16 characters (about 78 bits), not a short token that can be guessed. Login and sign-up are limited per IP (30 login attempts and 15 sign-ups per 15 minutes). A fresh code for someone who already has an account does not clear their password.

The invite table shows whether each code is active, used, revoked, or expired, and who used it. **Revoke** stops an unused or still-open code immediately. Codes are stored in `data/invites.json`. On Render, keep the persistent disk mounted at `data/` so invites, accounts, and players survive restarts.

## Deploy (Render)
- Runtime: Node
- Build: `npm install`
- Start: `npm start`
- For production persistence: attach a Render persistent disk mounted at `data/`

## Archive
Previous TypeScript/Prisma/Vite build is on branch `archive/previous-build`.

## Status
`main` holds the full Sunset Heresy Node + static HTML build (server, pages, js, data, schema, logo).
