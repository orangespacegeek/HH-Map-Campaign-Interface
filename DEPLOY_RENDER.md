# Deploy Sunset Heresy on Render

**Free Render web services do not keep campaign data.** As of 19 October 2026, Render's published pricing and free-plan docs say:

- A Free web service is $0, with 512 MB RAM. It spins down after 15 minutes without traffic (the next visit waits about a minute). It has an ephemeral disk: campaign JSON is wiped on every redeploy, restart, and spin-down. Free web services cannot attach a persistent disk. ([Free plan limits](https://render.com/docs/free), [pricing](https://render.com/pricing))
- The smallest paid web service is **$7 per month** (plan `0.5c-512mb`, 0.5 CPU, 512 MB RAM).
- A persistent disk is **$0.25 per GB per month**. The blueprint uses 1 GB, which is **$0.25 per month**.

A campaign you want to keep is about **$7.25 per month** before bandwidth. Check [Render's pricing page](https://render.com/pricing) before you turn it on. Prices change, and a Hobby workspace plan is $0 plus compute.

`render.yaml` in this repo creates that paid service and the 1 GB disk. Do not apply the blueprint if you only wanted a free preview.

## 1. Fork the repo

Fork or clone the repository into the GitHub account that will own the Render service. Render deploys from that repo. Secrets are not in git: `data/accounts.json`, `data/sessions.json`, `data/invites.json`, `data/notifications.json`, and `data/feedback.json` are gitignored, and `.dockerignore` excludes them if you later build a Docker image. The sample campaign JSON is in the repo on purpose. A reset (below) turns it into a turn-1 campaign.

## 2. Create the service

Either use the blueprint or create a web service by hand.

### Blueprint

1. In the Render dashboard, choose **New → Blueprint**.
2. Select this repo. Render reads `render.yaml`.
3. When it asks for `CAMPAIGN_ADMIN_PASSWORD`, paste a long password you can store in a password manager. Leave `DISCORD_FEEDBACK_WEBHOOK`, `DISCORD_CAMPAIGN_WEBHOOK`, and `CORS_ORIGINS` blank unless you need them.
4. Apply the blueprint. It creates a web service on plan `0.5c-512mb` with a disk named `campaign-data` mounted at `/var/data`, and sets `DATA_DIR=/var/data`.

### By hand

1. **New → Web Service**, connect the repo.
2. Runtime **Node**. Build command `npm install`. Start command `npm start`.
3. Instance type: the $7 plan (`0.5c-512mb`), not Free, if this campaign must survive a restart.
4. Add a disk. Mount path `/var/data`. Size 1 GB is enough for this JSON. You can grow it later. You cannot shrink it.
5. Health check path: `/health`.

Disks only keep files under the mount path. `DATA_DIR` must be that path. The rest of the container, including the git checkout, is replaced on every deploy.

### Node.js

Pin a patched Node.js version. `package.json` requires Node `>=22.23.4` for the eMudhra / Node.js advisory. On the Render service, set the Node version to at least 22.23.4, then redeploy with **Clear build cache & deploy**. In the build log, check that the printed Node version is 22.23.4 or newer.

## 3. Environment variables

Set these on the service, not in a committed file.

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `DATA_DIR` | `/var/data` (the disk mount) |
| `CAMPAIGN_ADMIN_LOGIN` | `admin`, or another username |
| `CAMPAIGN_ADMIN_PASSWORD` | the password you chose |
| `DISCORD_FEEDBACK_WEBHOOK` | leave unset unless feedback should also post to Discord |
| `DISCORD_CAMPAIGN_WEBHOOK` | leave unset unless phase, battle, and deadline reminders should post to Discord. Separate from the feedback webhook. |
| `CORS_ORIGINS` | leave unset. The site only needs to call itself. |
| `TRUST_PROXY` | `1`. Render is one proxy hop and appends the client address. The login limiter uses that address. Leave this unset on a machine that is not behind a proxy, or a client can pick their own limit by sending `X-Forwarded-For`. |

Do not set `CAMPAIGN_ADMIN_FORCE_PASSWORD` on the first deploy.

Save and deploy. The first boot creates the admin account from `CAMPAIGN_ADMIN_PASSWORD` and copies nothing secret out of the image.

## 4. First login

1. Open the service URL Render gives you (or your custom domain).
2. Open **Log in** and sign in as `admin` (or `CAMPAIGN_ADMIN_LOGIN`) with the password you set.
3. If the log instead printed `CAMPAIGN_ADMIN_INITIAL_PASSWORD`, you forgot the env var. Set `CAMPAIGN_ADMIN_PASSWORD`, set `CAMPAIGN_ADMIN_FORCE_PASSWORD` to `1`, redeploy, sign in, then delete the force flag and redeploy again.

## 5. Invite players

1. Open **Players**.
2. Under **Player invites**, generate a code. The default is one use. Invites stay valid for the campaign; they are not limited to a test period.
3. Send the code and the site URL to the player.
4. They open **Log in → Sign up**, enter the code, and choose their own username and password.

That username is how they sign in afterwards. A used, revoked, or expired code is rejected.

## 6. Start the campaign you actually want to play

The repo ships a sample already on turn 3. A brand-new disk has no `systems.json`; the first boot copies `data/baseline/systems.json` into `DATA_DIR`, so sign-up can offer a starting system before the reset. After the first deploy, sign in as admin, open the dashboard, and choose **Reset campaign**. Leave both keep-boxes unchecked and type `RESET`. That sets turn 1, Logistics, restores the Port Maw starting map, clears the sample battle, and gives every current player two strength-3 forces in that player's starting system. A player who never chose one is placed in a system their side already controls, not in Port Maw with everyone else. Accounts stay. Check **Keep current map** only if you have edited systems, links, or positions and want to keep that layout. **Keep current system control** is available only after that, and it keeps each system's loyal and traitor scores.

You can do the same over SSH or a one-off shell only on a service that has a disk and shell access (paid instances):

```bash
npm run reset-campaign
```

Run that with the service's `DATA_DIR` already in the environment. `--purge-accounts` deletes player logins. Do not pass it unless you mean to.

Download a backup from the dashboard first if anyone has already entered real results. The file has no password hashes and no sessions. It does include invite codes.

## 7. Updating

Push to the branch Render deploys. Render rebuilds and restarts. With the disk mounted at `DATA_DIR`, accounts, invites, and campaign JSON stay. A service with a disk does a short restart instead of a zero-downtime swap, because two copies must not write the disk at once. That is Render's rule for disks.

Free instances, and any service without a disk, lose `data/` on that restart.

## 8. Backups and rotating the admin password

- Dashboard → **Download backup**, or `GET /api/admin/backup` while signed in as admin.
- Keep that file somewhere that is not the Render disk. The disk is the live copy, not an off-site backup. Render snapshots disks daily, but a file you downloaded is the copy you can move.

To change the admin password and sign every session out:

1. Set `CAMPAIGN_ADMIN_PASSWORD` to the new password.
2. Set `CAMPAIGN_ADMIN_FORCE_PASSWORD` to `1`.
3. Redeploy. The log should say the force reset ran.
4. Sign in with the new password.
5. Delete `CAMPAIGN_ADMIN_FORCE_PASSWORD` and redeploy again. If you leave it set, every future deploy resets the password and kicks everyone out, including a password you changed on **My account**.

## 9. Feedback webhook

Leave `DISCORD_FEEDBACK_WEBHOOK` empty until you want a channel ping. Create a Discord webhook in the channel, paste the `https://discord.com/api/webhooks/...` URL into that env var, and redeploy. Feedback is still stored in `feedback.json` on the disk either way. The admin reads it under **Feedback**. A URL that is not a Discord webhook is ignored.

## 10. Campaign Discord notifications

`DISCORD_CAMPAIGN_WEBHOOK` is separate from the feedback webhook. Leave it unset and the campaign posts nothing. A failed post never stops a phase from advancing.

Create the webhook:

1. In Discord, open the channel that should receive campaign posts.
2. Open **Edit Channel** (the gear on the channel) → **Integrations** → **Webhooks** → **New Webhook**.
3. Name it (for example `Sunset Heresy`), pick that channel, and copy the webhook URL. It looks like `https://discord.com/api/webhooks/...`.
4. On the Render service, set `DISCORD_CAMPAIGN_WEBHOOK` to that URL. Do not commit the URL. Save. Render restarts the service.
5. Sign in as the campaign admin, open the dashboard, and choose **Send test notification**. The channel should show a test message. If the variable is unset, the button says the webhook is not configured.

Players who want an @mention add their Discord user ID on **My account**. In Discord, enable Developer Mode, right-click their name, and choose **Copy User ID**. On a phone, turn Developer Mode on, then long-press their name. The ID is visible only to that player and the campaign admin. Posts mention only those saved IDs. They do not ping @everyone or roles.

The channel is notified when a phase starts (including **Begin campaign**), when the admin adds a battle, and once in the 24 hours before a phase deadline. In the Battles phase the phase-start post lists open battles, and the reminder mentions players who still have an unreported battle.

## Health

`GET /health` returns `{"ok":true,"service":"sunset-heresy"}`. Render uses that path from the blueprint. It does not check that the disk is writable.
