#!/usr/bin/env node
/**
 * Sunset Heresy – campaign API with roles + static file server.
 *
 * Roles:
 *   visitor         – public read (no PII)
 *   player          – edit own profile + own forces / actions
 *   campaign_admin  – full campaign management
 *
 * Auth (local for now; OAuth providers can plug in later):
 *   POST /api/auth/login          { login, password }
 *                                 legacy: { invite_code, password } claims a pre-made player
 *   POST /api/auth/logout
 *   GET  /api/auth/me
 *   POST /api/auth/set-password   (logged in) { password, current_password }
 *   POST /api/auth/create-invite  (campaign_admin) legacy: { player_id } → invite_code
 *   GET  /api/auth/invites        (campaign_admin) list player invite codes
 *   POST /api/auth/invites        (campaign_admin) { note?, expires_in_days?, max_uses? }
 *   POST /api/auth/invites/revoke (campaign_admin) { invite_id }
 *   POST /api/auth/signup         { invite_code, login, password, player_name, display_name, ... }
 *   Login and signup are rate-limited per IP (see AUTH_MAX_ATTEMPTS).
 *
 * Public reads (no private action notes, no contact details):
 *   GET /api/public/players|forces|systems|games|meta
 *   GET /health and GET /api/health
 *
 * Protected writes use session cookie or Authorization: Bearer <token>.
 * Cookie-authenticated writes must come from the same origin (or CORS_ORIGINS)
 * and send header X-SH-Request: 1.
 *
 * Tester tools:
 *   POST /api/feedback                 (logged in) { message, page? }
 *   GET  /api/feedback                 (campaign_admin)
 *   GET  /api/admin/backup             (campaign_admin) campaign JSON download
 *   POST /api/campaign/reset           (campaign_admin) { confirm: "RESET", keep_map?, keep_control? }
 *   POST /api/campaign/phase-deadline  (campaign_admin) { phase_ends_at } — ISO time, or null to clear
 *   POST /api/campaign/auto-advance    (campaign_admin) { enabled: boolean }
 *   A past phase deadline, or every counted player being out of actions during
 *   Logistics, advances one phase. Checked on startup and about every 30s
 *   (AUTO_ADVANCE_INTERVAL_MS). phase_ends_at is one instant, cleared after a
 *   successful advance, so a later weekly schedule can store the next instant.
 *   node server.js reset-campaign [--keep-map] [--keep-control] [--purge-accounts]
 *   --keep-control requires --keep-map.
 *
 * Env:
 *   PORT, HOST, DATA_DIR (default ./data). A missing systems.json is seeded from
 *     data/baseline/systems.json so sign-up can choose a start system.
 *   CAMPAIGN_ADMIN_LOGIN (default admin)
 *   CAMPAIGN_ADMIN_PASSWORD (required for a chosen admin password; if unset on
 *     first boot a random password is generated and printed once)
 *   CAMPAIGN_ADMIN_FORCE_PASSWORD=1  (with PASSWORD set: re-hash admin on boot
 *     and invalidate every session)
 *   CORS_ORIGINS (optional comma-separated extra origins; same-origin is always allowed)
 *   DISCORD_FEEDBACK_WEBHOOK (optional; off when unset)
 *   MAX_BODY_BYTES (default 1048576)
 *   TRUST_PROXY (unset or 0: ignore X-Forwarded-For and rate-limit the socket
 *     address. Render is one proxy hop, so set TRUST_PROXY=1 there. The hop
 *     count is how many entries to trust from the right of X-Forwarded-For.)
 *
 * Static files are an allow-list (HTML pages, js/, css/, images). data/, schema/,
 * server source, and dotfiles are not served.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = Number(process.env.PORT) || 3847;
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const SESSION_DAYS = 14;
// The old prototype password was published in the repo and on the login page.
// It is never used as a fallback. In production it is rejected outright.
const PUBLISHED_ADMIN_PASSWORD = "change-me";

const COLLECTIONS = {
  players: { file: "players.json", idKey: "player_id" },
  forces: { file: "forces.json", idKey: "force_id" },
  systems: { file: "systems.json", idKey: "sys_id" },
  games: { file: "games.json", idKey: "game_id" },
  meta: { file: "meta.json", idKey: null },
  accounts: { file: "accounts.json", idKey: "account_id" },
  sessions: { file: "sessions.json", idKey: "token" },
  invites: { file: "invites.json", idKey: "invite_id" },
  notifications: { file: "notifications.json", idKey: "notification_id" },
  feedback: { file: "feedback.json", idKey: "feedback_id" }
};

const PUBLIC_PAGES = new Set([
  "index.html",
  "login.html",
  "campaign_map.html",
  "player_admin.html",
  "forces.html",
  "systems.html",
  "games.html",
  "rules.html",
  "actions.html",
  "account.html",
  "feedback.html"
]);

const PUBLIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".gif": "image/gif"
};

// Pages that require login (client still loads; API enforces). Listed for docs.
const ADMIN_PAGES = ["player_admin.html"];

function ensureDataDir() {
  if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
}

function seedBaselineSystems() {
  const dest = path.join(DATA, "systems.json");
  if (fs.existsSync(dest)) return false;
  const baseline = loadBaselineSystems();
  if (!baseline || !baseline.length) return false;
  ensureDataDir();
  atomicWrite(dest, JSON.stringify(baseline, null, 2) + "\n");
  console.log("Seeded " + baseline.length + " systems from data/baseline/systems.json");
  return true;
}

function atomicWrite(fp, text) {
  const tmp = fp + ".tmp-" + process.pid + "-" + crypto.randomBytes(4).toString("hex");
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, fp);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {}
    throw err;
  }
}

function readCollection(name) {
  const spec = COLLECTIONS[name];
  if (!spec) return null;
  const fp = path.join(DATA, spec.file);
  if (!fs.existsSync(fp)) {
    const empty = name === "meta" ? {} : [];
    atomicWrite(fp, JSON.stringify(empty, null, 2));
    return empty;
  }
  return JSON.parse(fs.readFileSync(fp, "utf8"));
}

function writeCollection(name, data) {
  const spec = COLLECTIONS[name];
  if (!spec) throw new Error("Unknown collection");
  const fp = path.join(DATA, spec.file);
  atomicWrite(fp, JSON.stringify(data, null, 2));
}

function nextId(list, idKey) {
  if (!list.length) return 1;
  return list.reduce((m, row) => Math.max(m, Number(row[idKey]) || 0), 0) + 1;
}

function considerPlayerId(max, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= max) return max;
  return n;
}

/** Highest player id still stored anywhere, so a deleted row cannot be reused. */
function highestPlayerId() {
  let max = 0;
  readCollection("players").forEach((p) => {
    max = considerPlayerId(max, p.player_id);
  });
  readCollection("forces").forEach((f) => {
    max = considerPlayerId(max, f.player_id);
  });
  readCollection("games").forEach((g) => {
    max = considerPlayerId(max, g.attacker_id);
    max = considerPlayerId(max, g.defender_id);
    max = considerPlayerId(max, g.winner_id);
    max = considerPlayerId(max, g.proposed_by);
    max = considerPlayerId(max, g.disputed_by);
  });
  readCollection("accounts").forEach((a) => {
    max = considerPlayerId(max, a.player_id);
  });
  const invites = readCollection("invites");
  if (Array.isArray(invites)) {
    invites.forEach((invite) => {
      (invite.used_by || []).forEach((use) => {
        max = considerPlayerId(max, use.player_id);
      });
    });
  }
  return max;
}

/**
 * Next player id from meta.next_player_id. The counter only moves forward.
 * If it is missing, or older data references a higher id, seed past that id.
 */
function allocatePlayerId() {
  const meta = readCollection("meta") || {};
  const id = Math.max(Number(meta.next_player_id) || 1, highestPlayerId() + 1);
  meta.next_player_id = id + 1;
  writeCollection("meta", meta);
  return id;
}

function dropSessionsForPlayer(playerId) {
  const accounts = readCollection("accounts");
  const ids = new Set(
    accounts.filter((a) => Number(a.player_id) === Number(playerId)).map((a) => a.account_id)
  );
  if (!ids.size) return;
  const sessions = readCollection("sessions").filter((s) => !ids.has(s.account_id));
  writeCollection("sessions", sessions);
}

/**
 * Removing a player keeps the force rows and every battle. Forces are marked
 * "removed" (not destroyed, and not given to anyone else) so they drop out of
 * pairing, fortify, and the map. Open and pending battles for those forces are
 * voided with no winner. Applied battles stay.
 */
function retireRemovedPlayer(playerId) {
  const forces = readCollection("forces");
  const owned = forces.filter((f) => Number(f.player_id) === Number(playerId));
  owned.forEach((force) => {
    force.status = "removed";
    force.dest_sys_id = null;
  });
  if (owned.length) writeCollection("forces", forces);
  const games = readCollection("games");
  const state = battleState();
  voidUnfoughtBattles(
    owned.map((force) => force.force_id),
    { games, state, reason: "player_removed" }
  );
  writeCollection("games", games);
  saveBattleState(state);
  dropSessionsForPlayer(playerId);
}

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), s, 64).toString("hex");
  return { salt: s, hash };
}

function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(String(password), salt, 64).toString("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(check, "hex"), Buffer.from(hash, "hex"));
  } catch {
    return false;
  }
}

function randomToken() {
  return crypto.randomBytes(24).toString("hex");
}

// Unambiguous alphabet: no 0/O, 1/I/L, or 8/B, which are easy to misread when a code is shared.
const INVITE_ALPHABET = "ACDEFGHJKLMNPQRSTUVWXYZ2345679";

function randomInvite() {
  // 16 characters from a 29-letter alphabet (~78 bits). Rejection sampling avoids modulo bias.
  const span = INVITE_ALPHABET.length * Math.floor(256 / INVITE_ALPHABET.length);
  let out = "";
  while (out.length < 16) {
    const buf = crypto.randomBytes(32);
    for (let i = 0; i < buf.length && out.length < 16; i++) {
      if (buf[i] < span) out += INVITE_ALPHABET[buf[i] % INVITE_ALPHABET.length];
    }
  }
  return out;
}

const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/;
const ALLEGIANCES = ["Loyalist", "Traitor"];
const NEEDS_SIDE = "needs side";
const INVITE_MAX_USES_CAP = 25;

function isBlackshieldMark(value) {
  const text = String(value == null ? "" : value).trim().toLowerCase();
  return text === "blackshield" || text === "blackshields";
}

function sideOf(player) {
  if (!player) return null;
  return ALLEGIANCES.includes(player.allegiance) ? player.allegiance : null;
}

function requirePlayerSide(value) {
  const allegiance = String(value == null ? "" : value).trim();
  if (!ALLEGIANCES.includes(allegiance)) {
    return { ok: false, error: "Allegiance must be Loyalist or Traitor" };
  }
  return { ok: true, allegiance };
}

function otherSide(allegiance) {
  if (allegiance === "Loyalist") return "Traitor";
  if (allegiance === "Traitor") return "Loyalist";
  return null;
}

/**
 * Force allegiance is the owning player's side. A Blackshields army is a force
 * type on that side. When the stored allegiance is still the old Blackshield
 * mark, fill force_type Blackshields only if the type is blank or the same mark.
 * A type that was already filled in (Legion, Militia, …) is kept.
 */
function applyOwnerSide(force, side) {
  const marked = isBlackshieldMark(force.allegiance);
  const next = { ...force, allegiance: side };
  const type = String(force.force_type || "").trim();
  if (marked && (!type || isBlackshieldMark(type))) next.force_type = "Blackshields";
  else if (!marked && isBlackshieldMark(type)) next.force_type = "Blackshields";
  return next;
}

function preserveBlackshieldMark(force) {
  if (!isBlackshieldMark(force.allegiance)) return force;
  const type = String(force.force_type || "").trim();
  const nextType = !type || isBlackshieldMark(type) ? "Blackshields" : type;
  if (force.allegiance === "Blackshield" && force.force_type === nextType) return force;
  return { ...force, allegiance: "Blackshield", force_type: nextType };
}

function readExistingCollection(name) {
  const spec = COLLECTIONS[name];
  if (!spec) return [];
  const fp = path.join(DATA, spec.file);
  if (!fs.existsSync(fp)) return [];
  const data = JSON.parse(fs.readFileSync(fp, "utf8"));
  return data;
}

function alignOwnerForces(playerId, side) {
  const forces = readCollection("forces");
  let changed = false;
  const next = forces.map((force) => {
    if (Number(force.player_id) !== Number(playerId)) return force;
    const updated = applyOwnerSide(force, side);
    if (updated.allegiance === force.allegiance && updated.force_type === force.force_type) return force;
    changed = true;
    return updated;
  });
  if (changed) writeCollection("forces", next);
  return changed;
}

function forceWithOwnerSide(force) {
  const owner = readCollection("players").find((player) => Number(player.player_id) === Number(force.player_id));
  if (!owner) return { ok: false, error: "Force owner was not found" };
  const side = sideOf(owner);
  if (!side) {
    return { ok: false, error: "Assign this player a Loyalist or Traitor side before editing their forces" };
  }
  return { ok: true, force: applyOwnerSide(force, side) };
}

/**
 * Idempotent load migration. Blackshield was never a third side.
 * Players marked Blackshield become "needs side" until an admin assigns one.
 * Forces of a Loyalist or Traitor player take that side. Their type becomes
 * Blackshields only when it was blank or already a Blackshield mark.
 * Forces of a player who still needs a side keep the Blackshield mark so the
 * same pass can finish them after the admin assigns a side.
 * A pre-change backup is written only when something actually changes.
 * The admin Download backup (GET /api/admin/backup) is a separate full export.
 */
function migrateBlackshieldAllegiance() {
  ensureDataDir();
  const players = readExistingCollection("players");
  const forces = readExistingCollection("forces");
  const nextPlayers = players.map((player) => {
    if (!isBlackshieldMark(player.allegiance)) return player;
    return { ...player, allegiance: NEEDS_SIDE };
  });
  const sideById = new Map();
  nextPlayers.forEach((player) => {
    const side = sideOf(player);
    if (side) sideById.set(Number(player.player_id), side);
  });
  const nextForces = forces.map((force) => {
    const side = sideById.get(Number(force.player_id));
    if (side) return applyOwnerSide(force, side);
    return preserveBlackshieldMark(force);
  });
  const playersChanged = JSON.stringify(players) !== JSON.stringify(nextPlayers);
  const forcesChanged = JSON.stringify(forces) !== JSON.stringify(nextForces);
  if (!playersChanged && !forcesChanged) return { changed: false };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(DATA, "backups");
  fs.mkdirSync(dir, { recursive: true });
  const backupFile = path.join(dir, "pre-blackshield-" + stamp + ".json");
  atomicWrite(
    backupFile,
    JSON.stringify(
      {
        taken_at: new Date().toISOString(),
        reason: "Before removing Blackshield as a player allegiance",
        players,
        forces
      },
      null,
      2
    ) + "\n"
  );
  if (playersChanged) writeCollection("players", nextPlayers);
  if (forcesChanged) writeCollection("forces", nextForces);
  const flagged = nextPlayers.filter((player, index) => player.allegiance === NEEDS_SIDE && players[index] && players[index].allegiance !== NEEDS_SIDE).length;
  console.log("Blackshield migration: " + flagged + " players flagged as needs side. Backup: " + backupFile);
  return { changed: true, backup: backupFile, flagged };
}

function normalizeInviteCode(code) {
  return String(code || "")
    .replace(/[\s-]/g, "")
    .trim()
    .toUpperCase();
}

function formatInviteCode(code) {
  const c = normalizeInviteCode(code);
  return c.replace(/(.{4})(?=.)/g, "$1-");
}

function inviteStatus(invite, now = Date.now()) {
  if (!invite) return "invalid";
  if (invite.revoked) return "revoked";
  if (invite.expires_at && new Date(invite.expires_at).getTime() <= now) return "expired";
  const max = Number(invite.max_uses) || 1;
  const uses = Number(invite.uses) || 0;
  if (uses >= max) return "used";
  return "active";
}

function inviteError(invite) {
  const status = inviteStatus(invite);
  if (status === "invalid") return "Invalid invite code";
  if (status === "revoked") return "This invite code has been revoked";
  if (status === "expired") return "This invite code has expired";
  if (status === "used") return "This invite code has already been used";
  return null;
}

function publicInvite(invite) {
  return {
    invite_id: invite.invite_id,
    code: normalizeInviteCode(invite.code),
    code_display: formatInviteCode(invite.code),
    note: invite.note || "",
    max_uses: Number(invite.max_uses) || 1,
    uses: Number(invite.uses) || 0,
    expires_at: invite.expires_at || null,
    revoked: !!invite.revoked,
    revoked_at: invite.revoked_at || null,
    created_at: invite.created_at,
    created_by: invite.created_by || null,
    status: inviteStatus(invite),
    used_by: Array.isArray(invite.used_by) ? invite.used_by : []
  };
}

function findInvite(invites, code) {
  const want = normalizeInviteCode(code);
  if (!want) return null;
  return invites.find((i) => normalizeInviteCode(i.code) === want) || null;
}

function uniqueInviteCode(invites, accounts) {
  const taken = new Set();
  invites.forEach((i) => {
    if (i.code) taken.add(normalizeInviteCode(i.code));
  });
  accounts.forEach((a) => {
    if (a.invite_code) taken.add(normalizeInviteCode(a.invite_code));
  });
  for (let n = 0; n < 8; n++) {
    const code = randomInvite();
    if (!taken.has(code)) return code;
  }
  return crypto.randomBytes(12).toString("hex").toUpperCase();
}

function findAccountByLogin(accounts, login) {
  const want = String(login || "").trim().toLowerCase();
  if (!want) return null;
  return accounts.find((a) => a.login && String(a.login).toLowerCase() === want) || null;
}

function clipText(value, max) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

function sessionCookie(req, token, maxAgeSeconds) {
  const secure =
    (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https" ||
    (req.connection && req.connection.encrypted);
  return (
    `sh_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}` +
    (secure ? "; Secure" : "")
  );
}

// Per-IP brake on password guessing and invite-code spraying. In-memory only;
// a process restart clears it, which is enough for a small tester group.
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = { login: 30, signup: 15, feedback: 10 };
const authBuckets = new Map();

function trustProxyHops() {
  const raw = String(process.env.TRUST_PROXY == null ? "" : process.env.TRUST_PROXY).trim().toLowerCase();
  if (!raw || raw === "0" || raw === "false" || raw === "off" || raw === "no") return 0;
  if (raw === "true" || raw === "yes" || raw === "on") return 1;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n > 0 && n < 20) return n;
  }
  return 0;
}

function clientIp(req) {
  const hops = trustProxyHops();
  if (hops > 0) {
    const fwd = req.headers["x-forwarded-for"];
    if (typeof fwd === "string" && fwd.trim()) {
      const parts = fwd.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length) return parts[Math.max(0, parts.length - hops)];
    }
  }
  const sock = req.socket || req.connection;
  return (sock && sock.remoteAddress) || "unknown";
}

function rateLimitAuth(req, action) {
  const limit = AUTH_MAX_ATTEMPTS[action];
  if (!limit) return null;
  const now = Date.now();
  const key = action + "|" + clientIp(req);
  let bucket = authBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + AUTH_WINDOW_MS };
    authBuckets.set(key, bucket);
  }
  bucket.count += 1;
  if (authBuckets.size > 4000) {
    for (const [k, v] of authBuckets) {
      if (v.resetAt <= now) authBuckets.delete(k);
    }
  }
  if (bucket.count > limit) {
    return { retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }
  return null;
}

function sendRateLimited(res, limited) {
  return send(
    res,
    429,
    { error: "Too many attempts. Try again in " + limited.retryAfter + " seconds." },
    { "Retry-After": String(limited.retryAfter) }
  );
}

function isProduction() {
  const nodeEnv = String(process.env.NODE_ENV || "").toLowerCase();
  const render = String(process.env.RENDER || "").toLowerCase();
  return nodeEnv === "production" || render === "true" || render === "1";
}

function clearAllSessions() {
  writeCollection("sessions", []);
}

function logGeneratedAdminPassword(login, password) {
  console.log("============================================================");
  console.log("CAMPAIGN_ADMIN_INITIAL_PASSWORD (printed once; not stored in plaintext)");
  console.log("login=" + login);
  console.log("password=" + password);
  console.log("Set CAMPAIGN_ADMIN_PASSWORD on the host so the next machine does not generate a different one.");
  console.log("To rotate later: set CAMPAIGN_ADMIN_PASSWORD to the new value and CAMPAIGN_ADMIN_FORCE_PASSWORD=1, restart, then remove the FORCE flag.");
  console.log("A FORCE reset also deletes every session.");
  console.log("============================================================");
}

function takeAdminPassword(login) {
  if (process.env.CAMPAIGN_ADMIN_PASSWORD) return process.env.CAMPAIGN_ADMIN_PASSWORD;
  const password = crypto.randomBytes(18).toString("base64url");
  logGeneratedAdminPassword(login, password);
  return password;
}

/** Ensure a campaign admin exists.
 *  Password comes from CAMPAIGN_ADMIN_PASSWORD. If that is unset when the
 *  admin is created (or has no hash yet), a random password is generated and
 *  printed once. There is no published default.
 *  Ops reset: set CAMPAIGN_ADMIN_PASSWORD and CAMPAIGN_ADMIN_FORCE_PASSWORD=1,
 *  then restart. That re-hashes the admin and deletes every session so old
 *  cookies and bearer tokens stop working. Remove FORCE afterwards so a later
 *  password change in the UI is not overwritten on the next deploy.
 */
function bootstrapAdmin() {
  const accounts = readCollection("accounts");
  let admin = accounts.find((a) => a.role === "campaign_admin");
  const login = process.env.CAMPAIGN_ADMIN_LOGIN || "admin";
  const envPassword = process.env.CAMPAIGN_ADMIN_PASSWORD;
  const forceFlag = String(process.env.CAMPAIGN_ADMIN_FORCE_PASSWORD || "").toLowerCase();
  const forceFromEnv =
    !!envPassword &&
    (forceFlag === "1" || forceFlag === "true" || forceFlag === "yes");

  if (!admin) {
    const password = takeAdminPassword(login);
    const { salt, hash } = hashPassword(password);
    admin = {
      account_id: nextId(accounts, "account_id"),
      role: "campaign_admin",
      label: "Campaign Admin",
      player_id: null,
      login,
      pass_hash: hash,
      pass_salt: salt,
      invite_code: null,
      provider: "local",
      created_at: new Date().toISOString().slice(0, 10)
    };
    accounts.push(admin);
    writeCollection("accounts", accounts);
    if (envPassword) console.log(`Created campaign admin login="${login}" from CAMPAIGN_ADMIN_PASSWORD`);
    else console.log(`Created campaign admin login="${login}" with a generated password (see above)`);
    return;
  }

  const previousLogin = admin.login;
  admin.login = admin.login || login;
  if (process.env.CAMPAIGN_ADMIN_LOGIN) admin.login = login;

  if (forceFromEnv) {
    const { salt, hash } = hashPassword(envPassword);
    admin.pass_hash = hash;
    admin.pass_salt = salt;
    writeCollection("accounts", accounts);
    clearAllSessions();
    console.log(
      `Applied CAMPAIGN_ADMIN_PASSWORD for login="${admin.login}" (FORCE env reset) and invalidated all sessions`
    );
    return;
  }

  if (!admin.pass_hash) {
    const password = takeAdminPassword(admin.login || login);
    const { salt, hash } = hashPassword(password);
    admin.pass_hash = hash;
    admin.pass_salt = salt;
    writeCollection("accounts", accounts);
    console.log(`Set campaign admin password for login="${admin.login}"`);
    return;
  }

  if (admin.login !== previousLogin) writeCollection("accounts", accounts);

  if (
    isProduction() &&
    admin.pass_hash &&
    verifyPassword(PUBLISHED_ADMIN_PASSWORD, admin.pass_salt, admin.pass_hash)
  ) {
    console.warn(
      "Campaign admin still has the old published password. Login with it is disabled in production. Set CAMPAIGN_ADMIN_PASSWORD and CAMPAIGN_ADMIN_FORCE_PASSWORD=1, then restart, to rotate it and sign everyone out."
    );
  } else if (isProduction() && !envPassword) {
    console.warn(
      "CAMPAIGN_ADMIN_PASSWORD is not set. Set it on the host so the admin password is one you chose and can rotate."
    );
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((part) => {
    const [k, ...rest] = part.trim().split("=");
    if (k) out[k] = decodeURIComponent(rest.join("=") || "");
  });
  return out;
}

function getSessionToken(req) {
  const auth = req.headers.authorization || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const cookies = parseCookies(req);
  return cookies.sh_session || null;
}

function getSession(req) {
  const token = getSessionToken(req);
  if (!token) return null;
  const sessions = readCollection("sessions");
  const now = Date.now();
  const live = sessions.filter((s) => new Date(s.expires_at).getTime() > now);
  if (live.length !== sessions.length) writeCollection("sessions", live);
  const session = live.find((s) => s.token === token);
  if (!session) return null;
  const accounts = readCollection("accounts");
  const account = accounts.find((a) => a.account_id === session.account_id);
  if (!account) return null;
  return { token, session, account };
}

function createSession(accountId) {
  const sessions = readCollection("sessions");
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  sessions.push({
    token,
    account_id: accountId,
    expires_at: expires.toISOString(),
    created_at: new Date().toISOString()
  });
  writeCollection("sessions", sessions);
  return { token, expires };
}

function destroySession(token) {
  if (!token) return;
  const sessions = readCollection("sessions").filter((s) => s.token !== token);
  writeCollection("sessions", sessions);
}

function publicPlayer(p) {
  return {
    player_id: p.player_id,
    display_name: p.display_name || "Unknown commander",
    allegiance: p.allegiance,
    status: p.status,
    start_sys_id: p.start_sys_id || null
  };
}

function publicForce(f, playersById) {
  const owner = playersById[f.player_id];
  return {
    force_id: f.force_id,
    force_name: f.force_name,
    game_system: f.game_system,
    force_type: f.force_type,
    allegiance: f.allegiance,
    legion: f.legion,
    subfaction: f.subfaction,
    organisation: f.organisation,
    warlord_name: f.warlord_name,
    primarch_present: f.primarch_present,
    titan_support: f.titan_support,
    points: f.points,
    home_sys_id: f.home_sys_id,
    sys_id: f.sys_id,
    dest_sys_id: f.dest_sys_id,
    strength: f.strength,
    status: f.status,
    // Owner shown as table name only — never real name / contact
    owner_display: owner ? owner.display_name || "Unknown" : "Unknown",
    player_id: f.player_id
  };
}

function ownSignupInvite(account) {
  const playerId = account && account.player_id;
  if (playerId == null || playerId === "") return null;
  let best = null;
  readCollection("invites").forEach((invite) => {
    const uses = Array.isArray(invite.used_by) ? invite.used_by : [];
    const mine = uses.find((u) => Number(u.player_id) === Number(playerId));
    if (!mine) return;
    const row = {
      code: formatInviteCode(invite.code),
      used_at: mine.used_at || null
    };
    if (!best || String(row.used_at || "") > String(best.used_at || "")) best = row;
  });
  return best;
}

function mePayload(account) {
  const base = {
    account_id: account.account_id,
    role: account.role,
    label: account.label,
    login: account.login || null,
    player_id: account.player_id,
    provider: account.provider || "local",
    // This player's own code only. Other sign-ups on a shared code stay on the admin invite list.
    signup_invite: ownSignupInvite(account)
  };
  if (account.player_id) {
    const players = readCollection("players");
    const p = players.find((x) => x.player_id === account.player_id);
    if (p) base.player = p; // full profile for self
  }
  return base;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function configuredOrigins() {
  return String(process.env.CORS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isAllowedOrigin(req, origin) {
  if (!origin) return false;
  if (configuredOrigins().includes(origin)) return true;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "")
    .split(",")[0]
    .trim();
  if (!host || url.host !== host) return false;
  const proto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  if (proto && url.protocol !== proto + ":") return false;
  return true;
}

function corsHeaders(req) {
  const headers = { Vary: "Origin" };
  const origin = req.headers.origin;
  if (!origin || origin === "null" || !isAllowedOrigin(req, origin)) return headers;
  headers["Access-Control-Allow-Origin"] = origin;
  headers["Access-Control-Allow-Credentials"] = "true";
  headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS";
  headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-SH-Request";
  return headers;
}

function send(res, status, body, extraHeaders = {}) {
  const req = res.req;
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(req ? corsHeaders(req) : {}),
    ...extraHeaders
  });
  res.end(payload);
}

// Cookie-authenticated writes must be same-origin (or on CORS_ORIGINS) and
// carry X-SH-Request, which a cross-site form cannot set.
function assertCsrf(req) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return null;
  if (!parseCookies(req).sh_session) return null;
  const origin = req.headers.origin;
  if (origin && origin !== "null" && !isAllowedOrigin(req, origin)) {
    return "Cross-origin write blocked";
  }
  if (req.headers["x-sh-request"] !== "1") {
    return "Write blocked. Refresh the page and try again.";
  }
  if (origin && origin !== "null") return null;
  const referer = req.headers.referer || req.headers.referrer || "";
  if (referer) {
    try {
      if (isAllowedOrigin(req, new URL(referer).origin)) return null;
    } catch (_) {}
  }
  const auth = req.headers.authorization || "";
  if (auth.toLowerCase().startsWith("bearer ")) return null;
  return "Write blocked. Refresh the page and try again.";
}

const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES) || 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    let tooBig = false;
    function fail(err) {
      if (settled) return;
      settled = true;
      reject(err);
    }
    req.on("data", (c) => {
      if (settled || tooBig) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        tooBig = true;
        fail(httpError(413, "Request body too large"));
        // Answer first, then drop the rest of the upload.
        setImmediate(() => {
          if (!req.destroyed) req.destroy();
        });
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch (_) {
        reject(httpError(400, "Invalid JSON body"));
      }
    });
    req.on("error", (err) => {
      if (settled) return;
      if (err && (err.code === "ECONNRESET" || err.code === "EPIPE")) return;
      fail(err);
    });
  });
}

function isPublicAsset(parts) {
  if (parts.some((p) => !p || p === "." || p === ".." || p.startsWith("."))) return false;
  if (parts.length === 1) {
    const name = parts[0];
    if (PUBLIC_PAGES.has(name)) return true;
    const ext = path.extname(name).toLowerCase();
    return ext !== ".html" && ext !== ".js" && ext !== ".css" && !!PUBLIC_TYPES[ext];
  }
  if (parts.length === 2 && parts[0] === "js" && path.extname(parts[1]).toLowerCase() === ".js") return true;
  if (parts.length === 2 && parts[0] === "css" && path.extname(parts[1]).toLowerCase() === ".css") return true;
  return false;
}

function serveStatic(req, res, pathname) {
  let rel = pathname === "/" ? "/index.html" : String(pathname || "/");
  rel = path.posix.normalize(rel);
  if (!rel.startsWith("/") || rel.includes("\0")) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const parts = rel.split("/").filter(Boolean);
  if (!isPublicAsset(parts)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const rootResolved = path.resolve(ROOT);
  const fp = path.resolve(rootResolved, ...parts);
  if (fp !== rootResolved && !fp.startsWith(rootResolved + path.sep)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const ext = path.extname(fp).toLowerCase();
  const type = PUBLIC_TYPES[ext] || "application/octet-stream";
  if (ext === ".html") {
    const forwarded = req.headers["x-forwarded-proto"];
    const proto = (forwarded ? String(forwarded).split(",")[0] : "http").trim() || "http";
    const host = String(req.headers["x-forwarded-host"] || req.headers.host || "localhost").split(",")[0].trim();
    const origin = proto + "://" + host;
    const pathOnly = String(req.url || "/").split("?")[0];
    let html = fs.readFileSync(fp, "utf8");
    html = html.replaceAll("__OG_IMAGE__", origin + "/Sunset%20Heresy-ff-02.png").replaceAll("__OG_URL__", origin + pathOnly);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    res.end(html);
    return;
  }
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": "public, max-age=3600",
    "X-Content-Type-Options": "nosniff"
  });
  fs.createReadStream(fp).pipe(res);
}

function requireRole(auth, roles) {
  if (!auth) return { ok: false, status: 401, error: "Login required" };
  if (!roles.includes(auth.account.role)) return { ok: false, status: 403, error: "Insufficient role" };
  return { ok: true };
}

async function handleAuth(req, res, parts, method) {
  const action = parts[1]; // login | logout | me | set-password | create-invite

  if (method === "OPTIONS") return send(res, 204, "");

  if (action === "me" && method === "GET") {
    const auth = getSession(req);
    if (!auth) return send(res, 200, { authenticated: false, role: "visitor" });
    return send(res, 200, { authenticated: true, ...mePayload(auth.account) });
  }

  if (action === "logout" && method === "POST") {
    const token = getSessionToken(req);
    destroySession(token);
    return send(res, 200, { ok: true }, {
      "Set-Cookie": "sh_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
    });
  }

  if (action === "login" && method === "POST") {
    const limited = rateLimitAuth(req, "login");
    if (limited) return sendRateLimited(res, limited);
    const body = (await readBody(req)) || {};
    if (isProduction() && String(body.password || "") === PUBLISHED_ADMIN_PASSWORD) {
      return send(res, 401, {
        error: "That password is no longer accepted. Set CAMPAIGN_ADMIN_PASSWORD and CAMPAIGN_ADMIN_FORCE_PASSWORD=1 on the host, then restart."
      });
    }
    const accounts = readCollection("accounts");
    let account = null;

    if (body.invite_code) {
      const code = normalizeInviteCode(body.invite_code);
      account = accounts.find(
        (a) => a.invite_code && normalizeInviteCode(a.invite_code) === code
      );
      if (!account) return send(res, 401, { error: "Invalid invite code" });
      const password = String(body.password || "");
      if (!account.pass_hash) {
        if (password.length < 6 || password.length > 128) {
          return send(res, 400, { error: "Choose a password (at least 6 characters) to claim this account" });
        }
      } else if (!verifyPassword(password, account.pass_salt, account.pass_hash)) {
        return send(res, 401, { error: "Wrong password" });
      }
      // A legacy pre-made player has no username until they claim the code.
      // Store one so they can sign in again after the code is consumed.
      if (!account.login) {
        const login = String(body.login == null ? "" : body.login).trim();
        if (!LOGIN_RE.test(login)) {
          return send(res, 400, {
            error: "Choose a username (3–32 letters, numbers, dots, underscores, or hyphens) to claim this account"
          });
        }
        if (findAccountByLogin(accounts, login)) {
          return send(res, 409, { error: "That username is already taken" });
        }
        account.login = login;
      }
      if (!account.pass_hash) {
        const { salt, hash } = hashPassword(password);
        account.pass_hash = hash;
        account.pass_salt = salt;
      }
      account.invite_code = null;
      writeCollection("accounts", accounts);
    } else if (body.login) {
      account = findAccountByLogin(accounts, body.login);
      if (!account || !verifyPassword(body.password, account.pass_salt, account.pass_hash)) {
        return send(res, 401, { error: "Invalid login or password" });
      }
    } else {
      return send(res, 400, { error: "Provide login+password or invite_code+password" });
    }

    const { token, expires } = createSession(account.account_id);
    return send(res, 200, { ok: true, token, expires_at: expires.toISOString(), ...mePayload(account) }, {
      "Set-Cookie": sessionCookie(req, token, SESSION_DAYS * 86400)
    });
  }

  if (action === "set-password" && method === "POST") {
    const auth = getSession(req);
    const gate = requireRole(auth, ["player", "campaign_admin"]);
    if (!gate.ok) return send(res, gate.status, { error: gate.error });
    const body = (await readBody(req)) || {};
    if (!body.password || String(body.password).length < 6) {
      return send(res, 400, { error: "Password must be at least 6 characters" });
    }
    if (isProduction() && String(body.password) === PUBLISHED_ADMIN_PASSWORD) {
      return send(res, 400, { error: "Choose a different password" });
    }
    const accounts = readCollection("accounts");
    const idx = accounts.findIndex((a) => a.account_id === auth.account.account_id);
    if (idx < 0) return send(res, 404, { error: "Account not found" });
    const row = accounts[idx];
    // Require current password when the account already has one (change flow).
    if (row.pass_hash) {
      if (!body.current_password) {
        return send(res, 400, { error: "Current password required" });
      }
      if (!verifyPassword(body.current_password, row.pass_salt, row.pass_hash)) {
        return send(res, 401, { error: "Current password is wrong" });
      }
    }
    const { salt, hash } = hashPassword(body.password);
    accounts[idx].pass_hash = hash;
    accounts[idx].pass_salt = salt;
    writeCollection("accounts", accounts);
    return send(res, 200, { ok: true });
  }

  // Legacy: attach a one-time code to a player the admin already created.
  // Player onboarding uses POST /api/auth/invites + POST /api/auth/signup instead.
  if (action === "create-invite" && method === "POST") {
    const auth = getSession(req);
    const gate = requireRole(auth, ["campaign_admin"]);
    if (!gate.ok) return send(res, gate.status, { error: gate.error });
    const body = (await readBody(req)) || {};
    const playerId = Number(body.player_id);
    if (!playerId) return send(res, 400, { error: "player_id required" });
    const players = readCollection("players");
    const player = players.find((p) => p.player_id === playerId);
    if (!player) return send(res, 404, { error: "Player not found" });

    const accounts = readCollection("accounts");
    let account = accounts.find((a) => a.player_id === playerId);
    const code = randomInvite();
    if (!account) {
      account = {
        account_id: nextId(accounts, "account_id"),
        role: "player",
        label: player.display_name || player.player_name,
        player_id: playerId,
        login: null,
        pass_hash: null,
        pass_salt: null,
        invite_code: code,
        provider: "invite",
        created_at: new Date().toISOString().slice(0, 10)
      };
      accounts.push(account);
    } else {
      // A replacement code must not erase a password the player already set.
      account.invite_code = code;
    }
    writeCollection("accounts", accounts);
    return send(res, 200, { invite_code: code, player_id: playerId, label: account.label });
  }

  if (action === "invites" && method === "GET") {
    const auth = getSession(req);
    const gate = requireRole(auth, ["campaign_admin"]);
    if (!gate.ok) return send(res, gate.status, { error: gate.error });
    const invites = readCollection("invites");
    const list = invites
      .map(publicInvite)
      .sort((a, b) => Number(b.invite_id) - Number(a.invite_id));
    return send(res, 200, { invites: list });
  }

  if (action === "invites" && method === "POST" && !parts[2]) {
    const auth = getSession(req);
    const gate = requireRole(auth, ["campaign_admin"]);
    if (!gate.ok) return send(res, gate.status, { error: gate.error });
    const body = (await readBody(req)) || {};
    const note = clipText(body.note, 120);
    let maxUses = 1;
    if (body.max_uses != null && body.max_uses !== "") {
      maxUses = Number(body.max_uses);
      if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > INVITE_MAX_USES_CAP) {
        return send(res, 400, { error: "Use limit must be a whole number from 1 to 25" });
      }
    }
    let expiresAt = null;
    if (body.expires_in_days != null && body.expires_in_days !== "") {
      const days = Number(body.expires_in_days);
      if (!Number.isInteger(days) || days < 1 || days > 365) {
        return send(res, 400, { error: "Expiry must be a whole number of days from 1 to 365, or left blank" });
      }
      expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    }

    const invites = readCollection("invites");
    const accounts = readCollection("accounts");
    const row = {
      invite_id: nextId(invites, "invite_id"),
      code: uniqueInviteCode(invites, accounts),
      note,
      max_uses: maxUses,
      uses: 0,
      expires_at: expiresAt,
      revoked: false,
      revoked_at: null,
      created_at: new Date().toISOString(),
      created_by: auth.account.account_id,
      used_by: []
    };
    invites.push(row);
    writeCollection("invites", invites);
    return send(res, 201, { ok: true, invite: publicInvite(row) });
  }

  if (action === "invites" && method === "POST" && parts[2] === "revoke") {
    const auth = getSession(req);
    const gate = requireRole(auth, ["campaign_admin"]);
    if (!gate.ok) return send(res, gate.status, { error: gate.error });
    const body = (await readBody(req)) || {};
    const inviteId = Number(body.invite_id);
    if (!inviteId) return send(res, 400, { error: "invite_id required" });
    const invites = readCollection("invites");
    const row = invites.find((i) => Number(i.invite_id) === inviteId);
    if (!row) return send(res, 404, { error: "Invite not found" });
    if (!row.revoked) {
      row.revoked = true;
      row.revoked_at = new Date().toISOString();
      writeCollection("invites", invites);
    }
    return send(res, 200, { ok: true, invite: publicInvite(row) });
  }

  if (action === "signup" && method === "POST") {
    const limited = rateLimitAuth(req, "signup");
    if (limited) return sendRateLimited(res, limited);
    const body = (await readBody(req)) || {};
    const code = normalizeInviteCode(body.invite_code);
    if (!code) return send(res, 400, { error: "Invite code is required" });

    const login = String(body.login == null ? "" : body.login).trim();
    if (!LOGIN_RE.test(login)) {
      return send(res, 400, {
        error: "Username must be 3–32 characters and use only letters, numbers, dots, underscores, or hyphens"
      });
    }
    const password = String(body.password || "");
    if (password.length < 6) {
      return send(res, 400, { error: "Password must be at least 6 characters" });
    }
    if (password.length > 128) {
      return send(res, 400, { error: "Password must be at most 128 characters" });
    }
    if (isProduction() && password === PUBLISHED_ADMIN_PASSWORD) {
      return send(res, 400, { error: "Choose a different password" });
    }
    const playerName = String(body.player_name == null ? "" : body.player_name).trim();
    if (!playerName) return send(res, 400, { error: "Player name is required" });
    if (playerName.length > 80) return send(res, 400, { error: "Player name must be at most 80 characters" });
    const displayName = String(body.display_name == null ? "" : body.display_name).trim();
    if (!displayName) return send(res, 400, { error: "Display name is required" });
    if (displayName.length > 80) return send(res, 400, { error: "Display name must be at most 80 characters" });
    const side = requirePlayerSide(body.allegiance);
    if (!side.ok) return send(res, 400, { error: side.error });
    const allegiance = side.allegiance;
    const contactRaw = String(body.contact == null ? "" : body.contact).trim();
    if (contactRaw.length > 120) return send(res, 400, { error: "Contact must be at most 120 characters" });
    const notesRaw = String(body.notes == null ? "" : body.notes).trim();
    if (notesRaw.length > 500) return send(res, 400, { error: "Notes must be at most 500 characters" });
    const contact = contactRaw || null;
    const notes = notesRaw || null;
    let startSysId = null;
    if (body.start_sys_id != null && body.start_sys_id !== "") {
      startSysId = Number(body.start_sys_id);
      if (!startSysId) return send(res, 400, { error: "Starting system is not valid" });
      const systems = readCollection("systems");
      if (!systems.some((s) => Number(s.sys_id) === startSysId)) {
        return send(res, 400, { error: "Starting system is not valid" });
      }
    }

    const invites = readCollection("invites");
    const invite = findInvite(invites, code);
    const rejection = inviteError(invite);
    if (rejection) return send(res, 400, { error: rejection });

    const accounts = readCollection("accounts");
    if (findAccountByLogin(accounts, login)) {
      return send(res, 409, { error: "That username is already taken" });
    }

    const players = readCollection("players");
    const player = {
      player_id: allocatePlayerId(),
      player_name: playerName,
      display_name: displayName,
      contact,
      status: "active",
      role: "player",
      allegiance,
      start_sys_id: startSysId,
      notes,
      joined_at: new Date().toISOString().slice(0, 10)
    };
    const { salt, hash } = hashPassword(password);
    const account = {
      account_id: nextId(accounts, "account_id"),
      role: "player",
      label: displayName,
      player_id: player.player_id,
      login,
      pass_hash: hash,
      pass_salt: salt,
      invite_code: null,
      provider: "invite",
      created_at: new Date().toISOString().slice(0, 10)
    };
    players.push(player);
    accounts.push(account);
    invite.uses = (Number(invite.uses) || 0) + 1;
    if (!Array.isArray(invite.used_by)) invite.used_by = [];
    invite.used_by.push({
      account_id: account.account_id,
      player_id: player.player_id,
      login: account.login,
      player_name: player.player_name,
      display_name: player.display_name,
      used_at: new Date().toISOString()
    });
    writeCollection("players", players);
    writeCollection("accounts", accounts);
    writeCollection("invites", invites);

    const { token, expires } = createSession(account.account_id);
    return send(res, 201, { ok: true, token, expires_at: expires.toISOString(), ...mePayload(account) }, {
      "Set-Cookie": sessionCookie(req, token, SESSION_DAYS * 86400)
    });
  }

  return send(res, 404, { error: "Unknown auth action" });
}

const PHASES = ["Logistics", "Movement", "Battles"];

function normalizeController(sys) {
  if (sys.sys_controller) return sys.sys_controller;
  const d = Number(sys.sys_loyal || 0) - Number(sys.sys_traitor || 0);
  if (d > 0) return "Loyalist";
  if (d < 0) return "Traitor";
  return "Contested";
}

function recomputeControllers(systems) {
  return systems.map((s) => {
    const loyal = Number(s.sys_loyal || 0);
    const traitor = Number(s.sys_traitor || 0);
    const d = loyal - traitor;
    let controller;
    if (d > 0) controller = "Loyalist";
    else if (d < 0) controller = "Traitor";
    else if (loyal === 0 && traitor === 0) controller = s.sys_controller === "Neutral" ? "Neutral" : "Contested";
    else controller = "Contested";
    return { ...s, sys_controller: controller };
  });
}

/** Score = sum of power of systems controlled by each side. */
function scoreFromSystems(systems) {
  let loyal = 0;
  let traitor = 0;
  systems.forEach((s) => {
    const c = normalizeController(s);
    const power = Number(s.sys_power) || 0;
    if (c === "Loyalist") loyal += power;
    else if (c === "Traitor") traitor += power;
  });
  return { loyal, traitor };
}

/**
 * End-of-turn recovery: active forces that did not fight this turn and sit
 * in an allegiance-controlled system with no opposing forces regain 1 strength (max 3).
 */
function applyForceRecovery(forces, systems) {
  const bySys = {};
  forces.forEach((f) => {
    if (f.status !== "active") return;
    const sid = f.sys_id;
    if (sid == null) return;
    if (!bySys[sid]) bySys[sid] = [];
    bySys[sid].push(f);
  });
  const sysById = Object.fromEntries(systems.map((s) => [s.sys_id, s]));

  return forces.map((f) => {
    if (f.status !== "active") return f;
    if (f.fought_this_turn) return { ...f, fought_this_turn: false };
    const sys = sysById[f.sys_id];
    if (!sys) return { ...f, fought_this_turn: false };
    const controller = normalizeController(sys);
    if (controller !== f.allegiance) return { ...f, fought_this_turn: false };
    const present = bySys[f.sys_id] || [];
    const opposing = present.some(
      (o) => o.force_id !== f.force_id && o.status === "active" && o.allegiance !== f.allegiance
    );
    if (opposing) return { ...f, fought_this_turn: false };
    const strength = Math.min(3, (Number(f.strength) || 0) + 1);
    return { ...f, strength, fought_this_turn: false };
  });
}

/** Apply pending moves: dest_sys_id → sys_id when leaving Movement phase. */
function applyPendingMoves(forces) {
  return forces.map((f) => {
    if (f.status !== "active") return f;
    if (f.dest_sys_id == null || f.dest_sys_id === "") return f;
    return { ...f, sys_id: Number(f.dest_sys_id), dest_sys_id: null };
  });
}

const DECISIVE_RESULTS = [
  "attacker_win",
  "defender_win",
  "draw",
  "conceded",
  "unable_to_schedule",
  "no_show"
];
const GAME_RESULTS = DECISIVE_RESULTS.concat(["in_progress"]);

function isDecisive(result) {
  return DECISIVE_RESULTS.includes(result);
}

function cloneData(value) {
  return JSON.parse(JSON.stringify(value));
}

function battleState() {
  return {
    forces: readCollection("forces"),
    systems: readCollection("systems"),
    players: readCollection("players")
  };
}

function saveBattleState(state) {
  writeCollection("forces", state.forces);
  writeCollection("systems", state.systems);
}

function isParticipant(game, playerId) {
  const pid = Number(playerId);
  return Number(game.attacker_id) === pid || Number(game.defender_id) === pid;
}

function sanitizeGameBody(body) {
  if (!body || typeof body !== "object") return;
  delete body.resolution;
  delete body.result_state;
  delete body.proposed_by;
  delete body.proposed_at;
  delete body.disputed_by;
  delete body.disputed_at;
  delete body.dispute_note;
  delete body.applied_at;
  delete body.assigned;
  delete body.action_bonus;
}

function parsePositiveInteger(value) {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 1 || !Number.isSafeInteger(value)) return null;
    return value;
  }
  if (typeof value === "string" && /^[1-9]\d*$/.test(value.trim())) {
    const n = Number(value.trim());
    if (Number.isSafeInteger(n) && n >= 1) return n;
  }
  return null;
}

function parseVictoryPoints(value) {
  if (value == null || value === "") return { ok: true, value: null };
  if (typeof value === "boolean") return { ok: false };
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) return { ok: false };
    return { ok: true, value };
  }
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value.trim())) {
    const n = Number(value.trim());
    if (Number.isSafeInteger(n)) return { ok: true, value: n };
  }
  return { ok: false };
}

function victoryPointError(body) {
  if (!body || typeof body !== "object") return null;
  for (const [key, label] of [
    ["attacker_vp", "Attacker"],
    ["defender_vp", "Defender"]
  ]) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    const parsed = parseVictoryPoints(body[key]);
    if (!parsed.ok) {
      return { status: 400, error: label + " victory points must be a non-negative integer" };
    }
    body[key] = parsed.value;
  }
  return null;
}

function normalizeGameResult(body) {
  if (!body.result) body.result = "in_progress";
  ["attacker_id", "defender_id", "attacker_force_id", "defender_force_id", "sys_id", "turn", "no_show_id"].forEach((key) => {
    if (body[key] != null && body[key] !== "") body[key] = Number(body[key]);
  });
  if (body.result === "attacker_win") body.winner_id = Number(body.attacker_id);
  else if (body.result === "defender_win") body.winner_id = Number(body.defender_id);
  else if (body.result === "draw" || body.result === "in_progress" || body.result === "unable_to_schedule") {
    body.winner_id = null;
  } else if (body.result === "conceded" && body.winner_id != null && body.winner_id !== "") {
    body.winner_id = Number(body.winner_id);
  } else if (body.result === "no_show") {
    const offender = Number(body.no_show_id);
    if (offender && offender === Number(body.attacker_id)) body.winner_id = Number(body.defender_id);
    else if (offender && offender === Number(body.defender_id)) body.winner_id = Number(body.attacker_id);
    else body.winner_id = null;
    if (body.attacker_vp == null) body.attacker_vp = 0;
    if (body.defender_vp == null) body.defender_vp = 0;
  }
  if (body.result === "unable_to_schedule") {
    body.attacker_vp = null;
    body.defender_vp = null;
    body.no_show_id = null;
  }
  if (body.result !== "no_show") body.no_show_id = null;
}

function validateGameWrite(body, auth, existing) {
  const isAdmin = auth.account.role === "campaign_admin";
  if (!isAdmin) {
    const playerId = Number(auth.account.player_id);
    if (existing && !isParticipant(existing, playerId)) {
      return { status: 403, error: "You can only edit a battle you are taking part in" };
    }
    if (existing && existing.result_state === "applied") {
      return { status: 403, error: "A confirmed battle can only be changed by the campaign admin" };
    }
    if (existing && existing.result_state === "void") {
      return { status: 403, error: "A voided battle can only be changed by the campaign admin" };
    }
  }
  const attackerId = Number(body.attacker_id);
  const defenderId = Number(body.defender_id);
  if (!attackerId || !defenderId) return { status: 400, error: "attacker_id and defender_id are required" };
  if (attackerId === defenderId) return { status: 400, error: "Attacker and defender must be different players" };
  if (!Number(body.sys_id)) return { status: 400, error: "sys_id is required" };
  if (!GAME_RESULTS.includes(body.result)) {
    return { status: 400, error: "result is not valid" };
  }
  if (body.result === "no_show") {
    const offender = Number(body.no_show_id);
    if (offender !== attackerId && offender !== defenderId) {
      return { status: 400, error: "Say which player did not show up" };
    }
    if (!isAdmin && offender === Number(auth.account.player_id)) {
      return { status: 400, error: "You can only report the other player as a no show" };
    }
  }
  if (
    !isAdmin &&
    existing &&
    existing.result === "no_show" &&
    existing.result_state === "pending" &&
    Number(existing.proposed_by) !== Number(auth.account.player_id)
  ) {
    return { status: 403, error: "A no show is waiting for the campaign admin" };
  }
  if (body.result === "conceded") {
    const winner = Number(body.winner_id);
    if (winner !== attackerId && winner !== defenderId) {
      return { status: 400, error: "A conceded battle needs winner_id set to the attacker or the defender" };
    }
  }
  const vp = victoryPointError(body);
  if (vp) return vp;

  const systems = readCollection("systems");
  if (!systems.some((s) => Number(s.sys_id) === Number(body.sys_id))) {
    return { status: 404, error: "System not found" };
  }
  const forces = readCollection("forces");
  function forceById(id) {
    if (id == null || id === "") return null;
    return forces.find((f) => Number(f.force_id) === Number(id)) || null;
  }
  const attF = forceById(body.attacker_force_id);
  const defF = forceById(body.defender_force_id);
  if (body.attacker_force_id && !attF) return { status: 404, error: "Attacker force not found" };
  if (body.defender_force_id && !defF) return { status: 404, error: "Defender force not found" };

  if (isAdmin) return null;

  const playerId = Number(auth.account.player_id);
  if (!isParticipant(body, playerId)) {
    return { status: 403, error: "You can only record a battle you are taking part in" };
  }
  const meta = readCollection("meta");
  if ((meta.phase || "Logistics") !== "Battles") {
    return { status: 409, error: "Battles can only be recorded during the Battles phase" };
  }
  const turn = Number(meta.turn) || 1;
  if (existing && Number(existing.turn) !== turn) {
    return { status: 409, error: "You can only edit a battle from the current turn" };
  }
  body.turn = existing ? Number(existing.turn) : turn;
  if (!attF || !defF) return { status: 400, error: "Both forces are required" };
  if (Number(attF.force_id) === Number(defF.force_id)) return { status: 400, error: "A force cannot fight itself" };
  if (Number(attF.player_id) !== attackerId) {
    return { status: 403, error: "The attacker force must belong to the attacker" };
  }
  if (Number(defF.player_id) !== defenderId) {
    return { status: 403, error: "The defender force must belong to the defender" };
  }
  const ownForce = attackerId === playerId ? attF : defF;
  if (Number(ownForce.player_id) !== playerId) {
    return { status: 403, error: "You can only put your own force on your side" };
  }
  if (ownForce.status === "destroyed") {
    return { status: 400, error: "Destroyed forces cannot be assigned to a battle" };
  }
  if (attF.status === "destroyed" || defF.status === "destroyed") {
    return { status: 400, error: "Destroyed forces cannot be assigned to a battle" };
  }
  if (Number(attF.sys_id) !== Number(body.sys_id) || Number(defF.sys_id) !== Number(body.sys_id)) {
    return { status: 400, error: "Both forces must be in the battle's system" };
  }
  if (attF.allegiance && defF.allegiance && attF.allegiance === defF.allegiance) {
    return { status: 400, error: "The two forces must be on opposing sides" };
  }
  const games = readCollection("games");
  const paired = playerPairingError(
    forces,
    games,
    body.turn,
    body.sys_id,
    attF.force_id,
    defF.force_id,
    existing && existing.game_id
  );
  if (paired) return paired;
  return null;
}

function sameProposal(previous, game) {
  if (!previous) return false;
  return (
    previous.result === game.result &&
    String(previous.winner_id ?? "") === String(game.winner_id ?? "") &&
    String(previous.no_show_id ?? "") === String(game.no_show_id ?? "") &&
    Number(previous.attacker_force_id) === Number(game.attacker_force_id) &&
    Number(previous.defender_force_id) === Number(game.defender_force_id) &&
    Number(previous.sys_id) === Number(game.sys_id)
  );
}

function otherAppliedFought(games, forceId, exceptGameId) {
  return games.some((g) => {
    if (Number(g.game_id) === Number(exceptGameId)) return false;
    if (!g.resolution || !Array.isArray(g.resolution.forces)) return false;
    return g.resolution.forces.some((e) => Number(e.force_id) === Number(forceId) && e.fought);
  });
}

function reverseResolution(game, state, games) {
  const resolution = game && game.resolution;
  if (!resolution) return;
  const effect = resolution.system;
  if (effect && effect.sys_id != null) {
    const sys = state.systems.find((s) => Number(s.sys_id) === Number(effect.sys_id));
    if (sys) {
      sys.sys_durability = Math.max(0, (Number(sys.sys_durability) || 0) - Number(effect.durability_delta || 0));
      sys.sys_power = Math.max(0, (Number(sys.sys_power) || 0) - Number(effect.power_delta || 0));
      sys.sys_loyal = Math.max(0, (Number(sys.sys_loyal) || 0) - Number(effect.loyal_delta || 0));
      sys.sys_traitor = Math.max(0, (Number(sys.sys_traitor) || 0) - Number(effect.traitor_delta || 0));
      if (effect.prev_controller) sys.sys_controller = effect.prev_controller;
    }
  }
  (resolution.forces || []).forEach((entry) => {
    const force = state.forces.find((f) => Number(f.force_id) === Number(entry.force_id));
    if (!force) return;
    force.strength = Math.max(0, (Number(force.strength) || 0) - Number(entry.strength_delta || 0));
    if (entry.set_destroyed) force.status = entry.prev_status || "active";
    if (entry.fought && !otherAppliedFought(games, force.force_id, game.game_id)) {
      force.fought_this_turn = false;
    }
  });
  game.resolution = null;
  state.systems = recomputeControllers(state.systems);
}

function winnerAllegiance(game, state) {
  if (!game || game.result === "draw" || game.result === "in_progress") return null;
  let winnerPlayerId = null;
  let winnerForceId = null;
  if (game.result === "attacker_win") {
    winnerPlayerId = game.attacker_id;
    winnerForceId = game.attacker_force_id;
  } else if (game.result === "defender_win") {
    winnerPlayerId = game.defender_id;
    winnerForceId = game.defender_force_id;
  } else if (game.result === "conceded" || game.result === "no_show") {
    winnerPlayerId = game.winner_id;
    if (Number(winnerPlayerId) === Number(game.attacker_id)) winnerForceId = game.attacker_force_id;
    else if (Number(winnerPlayerId) === Number(game.defender_id)) winnerForceId = game.defender_force_id;
  } else return null;

  const force = state.forces.find((f) => Number(f.force_id) === Number(winnerForceId));
  if (force && force.allegiance) return force.allegiance;
  const player = state.players.find((p) => Number(p.player_id) === Number(winnerPlayerId));
  return player ? player.allegiance : null;
}

function loserForceIds(game) {
  if (game.result === "draw") {
    return [game.attacker_force_id, game.defender_force_id].filter((id) => id != null && id !== "");
  }
  if (game.result === "attacker_win") return [game.defender_force_id].filter((id) => id != null && id !== "");
  if (game.result === "defender_win") return [game.attacker_force_id].filter((id) => id != null && id !== "");
  if (game.result === "conceded" || game.result === "no_show") {
    if (Number(game.winner_id) === Number(game.attacker_id)) {
      return [game.defender_force_id].filter((id) => id != null && id !== "");
    }
    if (Number(game.winner_id) === Number(game.defender_id)) {
      return [game.attacker_force_id].filter((id) => id != null && id !== "");
    }
  }
  return [];
}

/**
 * Apply one confirmed battle to current forces and the system.
 * Durability drops by 1 while it is above 0. The battle that reaches 0 does
 * not also drop power; the next battle does. Power does not go below 0.
 * A draw reduces both strengths and does not change sys_loyal / sys_traitor.
 * Only a Loyalist or Traitor winner moves that side's system track.
 */
function applyResolution(game, state, games) {
  if (!game || !isDecisive(game.result) || game.result_state !== "applied") {
    game.resolution = null;
    return;
  }
  // Unable to schedule closes the battle so it no longer blocks the advance.
  // It is not a fight: no VP, strength, durability, power, or control change,
  // and neither force counts as having fought.
  if (game.result === "unable_to_schedule") {
    game.resolution = {
      system: null,
      forces: [],
      result: game.result,
      at: new Date().toISOString()
    };
    return;
  }
  const sys = state.systems.find((s) => Number(s.sys_id) === Number(game.sys_id));
  const systemEffect = {
    sys_id: Number(game.sys_id),
    durability_delta: 0,
    power_delta: 0,
    loyal_delta: 0,
    traitor_delta: 0,
    prev_controller: sys ? sys.sys_controller || null : null
  };
  if (sys) {
    const dur = systemDurability(sys);
    if (dur > 0) {
      systemEffect.durability_delta = -1;
      sys.sys_durability = dur - 1;
    } else {
      sys.sys_durability = 0;
      const power = Number(sys.sys_power) || 0;
      if (power > 0) {
        systemEffect.power_delta = -1;
        sys.sys_power = power - 1;
      }
    }
    const alleg = winnerAllegiance(game, state);
    if (alleg === "Loyalist") {
      systemEffect.loyal_delta = 1;
      sys.sys_loyal = (Number(sys.sys_loyal) || 0) + 1;
    } else if (alleg === "Traitor") {
      systemEffect.traitor_delta = 1;
      sys.sys_traitor = (Number(sys.sys_traitor) || 0) + 1;
    }
  }

  const foughtIds = [game.attacker_force_id, game.defender_force_id].filter((id) => id != null && id !== "");
  const loseIds = new Set(loserForceIds(game).map((id) => Number(id)));
  const forceEffects = [];
  foughtIds.forEach((id) => {
    const force = state.forces.find((f) => Number(f.force_id) === Number(id));
    if (!force) return;
    const effect = {
      force_id: force.force_id,
      strength_delta: 0,
      set_destroyed: false,
      prev_status: force.status || "active",
      fought: true
    };
    if (loseIds.has(Number(id))) {
      const before = Number(force.strength) || 0;
      const next = Math.max(0, before - 1);
      effect.strength_delta = next - before;
      force.strength = next;
      if (next <= 0 && force.status !== "destroyed") {
        effect.set_destroyed = true;
        force.status = "destroyed";
      }
    }
    force.fought_this_turn = true;
    forceEffects.push(effect);
  });

  // A force destroyed by this battle cannot fight its other open or pending
  // battles this phase. Void those. Do not touch this battle, and do not
  // invent a winner or reverse anything that was never applied.
  const destroyedIds = forceEffects.filter((entry) => entry.set_destroyed).map((entry) => entry.force_id);
  if (destroyedIds.length) {
    const meta = readCollection("meta");
    voidUnfoughtBattles(destroyedIds, {
      games,
      state,
      turn: Number(meta.turn) || Number(game.turn) || 1,
      exceptGameId: game.game_id,
      reason: "force_destroyed"
    });
  }

  game.resolution = {
    system: systemEffect,
    forces: forceEffects,
    result: game.result,
    at: new Date().toISOString()
  };
  state.systems = recomputeControllers(state.systems);
}

function settleGame(game, previous, state, games, actor) {
  // Same outcome saved again (a note tweak, a repeated submit) must not
  // apply the strength and system deltas a second time.
  if (
    previous &&
    previous.result_state === "applied" &&
    previous.resolution &&
    sameProposal(previous, game)
  ) {
    game.result_state = "applied";
    game.proposed_by = previous.proposed_by || null;
    game.resolution = previous.resolution;
    return;
  }
  if (previous && previous.resolution) reverseResolution(previous, state, games);
  if (!isDecisive(game.result)) {
    game.result_state = "open";
    game.proposed_by = null;
    game.resolution = null;
    return;
  }
  const isAdmin = actor.role === "campaign_admin";
  let apply = false;
  if (isAdmin && !actor.confirming) {
    apply = true;
    if (previous && previous.proposed_by) game.proposed_by = previous.proposed_by;
    else game.proposed_by = null;
  } else if (actor.confirming && previous) {
    apply = true;
    game.proposed_by = previous.proposed_by;
  } else if (
    previous &&
    previous.result_state === "pending" &&
    Number(previous.proposed_by) !== Number(actor.player_id) &&
    sameProposal(previous, game)
  ) {
    apply = true;
    game.proposed_by = previous.proposed_by;
  } else {
    const freshProposal =
      !previous ||
      previous.result_state !== "pending" ||
      !sameProposal(previous, game) ||
      Number(previous.proposed_by) !== Number(actor.player_id);
    game.proposed_by = Number(actor.player_id);
    game.proposed_at = freshProposal
      ? new Date().toISOString()
      : previous.proposed_at || new Date().toISOString();
    if (freshProposal) {
      game.disputed_by = null;
      game.disputed_at = null;
      game.dispute_note = null;
    }
  }
  if (apply) {
    game.result_state = "applied";
    applyResolution(game, state, games);
  } else {
    game.result_state = "pending";
    game.resolution = null;
  }
  syncNoShowBonus(previous, game);
}

function addActionBonus(meta, playerId, turn, delta) {
  if (!meta.action_bonuses || typeof meta.action_bonuses !== "object" || Array.isArray(meta.action_bonuses)) {
    meta.action_bonuses = {};
  }
  const key = String(playerId);
  const bag = meta.action_bonuses[key] && typeof meta.action_bonuses[key] === "object" ? { ...meta.action_bonuses[key] } : {};
  const turnKey = String(turn);
  const next = (Number(bag[turnKey]) || 0) + delta;
  if (next > 0) bag[turnKey] = next;
  else delete bag[turnKey];
  if (Object.keys(bag).length) meta.action_bonuses[key] = bag;
  else delete meta.action_bonuses[key];
}

/** A confirmed no show grants the winner +1 action on the battle's next turn. */
function syncNoShowBonus(previous, game) {
  const meta = readCollection("meta") || {};
  let changed = false;
  const prevBonus = previous && previous.action_bonus;
  const keep =
    prevBonus &&
    game.result === "no_show" &&
    game.result_state === "applied" &&
    previous.result_state === "applied" &&
    sameProposal(previous, game);
  if (prevBonus && !keep) {
    addActionBonus(meta, prevBonus.player_id, prevBonus.turn, -1);
    changed = true;
  }
  if (game.result === "no_show" && game.result_state === "applied" && !keep) {
    const playerId = Number(game.winner_id);
    const turn = (Number(game.turn) || 1) + 1;
    if (playerId) {
      addActionBonus(meta, playerId, turn, 1);
      game.action_bonus = { player_id: playerId, turn, extra: 1 };
      changed = true;
    }
  } else if (keep) {
    game.action_bonus = previous.action_bonus;
  } else if (game.result !== "no_show" || game.result_state !== "applied") {
    game.action_bonus = null;
  }
  if (changed) writeCollection("meta", meta);
}

function activeSideForces(forces, sysId, allegiance) {
  return forces
    .filter(
      (f) =>
        f.status === "active" &&
        Number(f.sys_id) === Number(sysId) &&
        f.allegiance === allegiance
    )
    .sort((a, b) => Number(a.force_id) - Number(b.force_id));
}

/**
 * Pair opposing forces in a system.
 * The smaller side is reused so every force on the larger side fights once.
 * Counts are split as evenly as possible: 2 vs 5 means one force fights three
 * times and the other twice (sorted by force_id, extras go to the lower ids).
 * Loyalist is the attacker and Traitor the defender so the pairing is stable.
 * Only Loyalist and Traitor forces are auto-paired. Any other allegiance,
 * including a force still marked Blackshield because its owner needs a side, is left out.
 */
function buildPairings(loyal, traitor) {
  if (!loyal.length || !traitor.length) return [];
  const loyalIsSmallerOrEqual = loyal.length <= traitor.length;
  const minority = loyalIsSmallerOrEqual ? loyal : traitor;
  const majority = loyalIsSmallerOrEqual ? traitor : loyal;
  const base = Math.floor(majority.length / minority.length);
  const extra = majority.length % minority.length;
  const pairs = [];
  let majorityIndex = 0;
  minority.forEach((minForce, i) => {
    const fights = base + (i < extra ? 1 : 0);
    for (let k = 0; k < fights; k++) {
      const majForce = majority[majorityIndex++];
      const attacker = minForce.allegiance === "Loyalist" ? minForce : majForce;
      const defender = attacker === minForce ? majForce : minForce;
      pairs.push({ attacker, defender });
    }
  });
  return pairs;
}

function pairingKey(a, b) {
  const x = Number(a);
  const y = Number(b);
  return x < y ? x + ":" + y : y + ":" + x;
}

function battleCountsTowardPairing(game) {
  if (!game || game.result_state === "void") return false;
  if (game.attacker_force_id == null || game.attacker_force_id === "") return false;
  if (game.defender_force_id == null || game.defender_force_id === "") return false;
  return true;
}

/**
 * A player may only create or update a battle whose forces are one of the
 * auto-paired matchups for this system and turn. Outnumbered pairings count
 * each specific matchup once (2 vs 5 pairs the smaller side with particular
 * opponents, not with every opposing force). Admin writes skip this.
 * A filled slot is 409. A matchup that was never paired is 400.
 */
function playerPairingError(forces, games, turn, sysId, forceA, forceB, exceptGameId) {
  const key = pairingKey(forceA, forceB);
  const slots = buildPairings(
    activeSideForces(forces, sysId, "Loyalist"),
    activeSideForces(forces, sysId, "Traitor")
  ).filter((pair) => pairingKey(pair.attacker.force_id, pair.defender.force_id) === key).length;
  if (!slots) {
    return { status: 400, error: "These forces are not paired against each other this turn" };
  }
  const used = games.filter((g) => {
    if (exceptGameId != null && Number(g.game_id) === Number(exceptGameId)) return false;
    if (Number(g.turn) !== Number(turn)) return false;
    if (!battleCountsTowardPairing(g)) return false;
    return pairingKey(g.attacker_force_id, g.defender_force_id) === key;
  }).length;
  if (used >= slots) {
    return { status: 409, error: "These two forces already have a battle this turn" };
  }
  return null;
}

function pairingAlreadyUsed(games, turn, forceA, forceB, exceptGameId) {
  if (forceA == null || forceA === "" || forceB == null || forceB === "") return false;
  const key = pairingKey(forceA, forceB);
  return games.some((g) => {
    if (exceptGameId != null && Number(g.game_id) === Number(exceptGameId)) return false;
    if (Number(g.turn) !== Number(turn)) return false;
    if (!battleCountsTowardPairing(g)) return false;
    return pairingKey(g.attacker_force_id, g.defender_force_id) === key;
  });
}

function assignBattles(turn) {
  const forces = readCollection("forces");
  const systems = readCollection("systems");
  const games = readCollection("games");
  const sysIds = new Set();
  forces.forEach((f) => {
    if (f.status === "active" && f.sys_id != null) sysIds.add(Number(f.sys_id));
  });
  let created = 0;
  sysIds.forEach((sysId) => {
    if (!systems.some((s) => Number(s.sys_id) === sysId)) return;
    const desired = buildPairings(
      activeSideForces(forces, sysId, "Loyalist"),
      activeSideForces(forces, sysId, "Traitor")
    );
    const have = new Map();
    games.forEach((g) => {
      if (Number(g.turn) !== Number(turn)) return;
      if (Number(g.sys_id) !== Number(sysId)) return;
      if (g.attacker_force_id == null || g.defender_force_id == null) return;
      const key = pairingKey(g.attacker_force_id, g.defender_force_id);
      have.set(key, (have.get(key) || 0) + 1);
    });
    desired.forEach((pair) => {
      const key = pairingKey(pair.attacker.force_id, pair.defender.force_id);
      const left = have.get(key) || 0;
      if (left > 0) {
        have.set(key, left - 1);
        return;
      }
      games.push({
        game_id: nextId(games, "game_id"),
        turn: Number(turn),
        played_on: null,
        sys_id: sysId,
        game_system: pair.attacker.game_system || pair.defender.game_system || "HH",
        mission: null,
        points: pair.attacker.points || pair.defender.points || null,
        attacker_id: Number(pair.attacker.player_id),
        defender_id: Number(pair.defender.player_id),
        attacker_force_id: Number(pair.attacker.force_id),
        defender_force_id: Number(pair.defender.force_id),
        attacker_vp: null,
        defender_vp: null,
        result: "in_progress",
        winner_id: null,
        attacker_list: null,
        defender_list: null,
        notes: "Assigned when the Battles phase began",
        result_state: "open",
        proposed_by: null,
        resolution: null,
        assigned: true
      });
      created += 1;
    });
  });
  if (created) writeCollection("games", games);
  return created;
}

async function createBattle(res, auth, body) {
  sanitizeGameBody(body);
  normalizeGameResult(body);
  if (auth.account.role !== "campaign_admin") {
    const meta = readCollection("meta");
    body.turn = Number(meta.turn) || 1;
  }
  const problem = validateGameWrite(body, auth, null);
  if (problem) return send(res, problem.status, { error: problem.error });
  const list = readCollection("games");
  if (body.game_id == null || body.game_id === "") body.game_id = nextId(list, "game_id");
  else body.game_id = Number(body.game_id);
  if (list.some((r) => Number(r.game_id) === Number(body.game_id))) {
    return send(res, 409, { error: "ID already exists" });
  }
  body.resolution = null;
  body.result_state = "open";
  body.proposed_by = null;
  const state = battleState();
  settleGame(body, null, state, list, auth.account);
  list.push(body);
  writeCollection("games", list);
  saveBattleState(state);
  announceBattleChange(null, body, auth.account);
  return send(res, 201, body);
}

async function updateBattle(res, auth, existing, list, idx, body) {
  sanitizeGameBody(body);
  const merged = { ...existing, ...body, game_id: existing.game_id };
  if (auth.account.role !== "campaign_admin") merged.turn = existing.turn;
  normalizeGameResult(merged);
  const problem = validateGameWrite(merged, auth, existing);
  if (problem) return send(res, problem.status, { error: problem.error });
  const previous = cloneData(existing);
  merged.resolution = null;
  const state = battleState();
  settleGame(merged, previous, state, list, auth.account);
  list[idx] = merged;
  writeCollection("games", list);
  saveBattleState(state);
  announceBattleChange(previous, merged, auth.account);
  return send(res, 200, merged);
}

function replaceBattles(res, body) {
  for (const raw of body) {
    if (!raw || typeof raw !== "object") return send(res, 400, { error: "Expected game objects" });
    const vp = victoryPointError(raw);
    if (vp) return send(res, vp.status, { error: vp.error });
  }
  const state = battleState();
  const old = readCollection("games");
  old.forEach((g) => {
    if (g.resolution) reverseResolution(g, state, old);
  });
  const next = [];
  for (const raw of body) {
    if (!raw || typeof raw !== "object") return send(res, 400, { error: "Expected game objects" });
    const game = { ...raw };
    sanitizeGameBody(game);
    normalizeGameResult(game);
    if (game.game_id == null || game.game_id === "") game.game_id = nextId(next, "game_id");
    else game.game_id = Number(game.game_id);
    game.resolution = null;
    if (isDecisive(game.result)) {
      game.result_state = "applied";
      game.proposed_by = null;
      applyResolution(game, state, next);
    } else {
      game.result_state = "open";
      game.proposed_by = null;
      game.resolution = null;
    }
    next.push(game);
  }
  writeCollection("games", next);
  saveBattleState(state);
  return send(res, 200, next);
}

async function confirmBattle(req, res, idPart) {
  const auth = getSession(req);
  const gate = requireRole(auth, ["player", "campaign_admin"]);
  if (!gate.ok) return send(res, gate.status, { error: gate.error });
  const list = readCollection("games");
  const idx = list.findIndex((g) => String(g.game_id) === String(idPart));
  if (idx < 0) return send(res, 404, { error: "Not found" });
  const existing = list[idx];
  const isAdmin = auth.account.role === "campaign_admin";
  const playerId = Number(auth.account.player_id);
  if (!isAdmin && !isParticipant(existing, playerId)) {
    return send(res, 403, { error: "You can only confirm a battle you are taking part in" });
  }
  if (existing.result_state === "applied" && existing.resolution) return send(res, 200, existing);
  const canApply =
    existing.result_state === "pending" || (isAdmin && existing.result_state === "disputed");
  if (!isDecisive(existing.result) || !canApply) {
    return send(res, 409, { error: "This battle has no result waiting to be applied" });
  }
  if (existing.result === "no_show" && !isAdmin) {
    if (Number(existing.proposed_by) === playerId) {
      return send(res, 403, { error: "Waiting for the campaign admin to confirm this no show" });
    }
    return send(res, 403, { error: "A no show must be confirmed by the campaign admin, not the opponent" });
  }
  if (!isAdmin && Number(existing.proposed_by) === playerId) {
    return send(res, 403, { error: "Waiting for your opponent to confirm this result" });
  }
  if (!isAdmin) {
    const paired = playerPairingError(
      readCollection("forces"),
      list,
      existing.turn,
      existing.sys_id,
      existing.attacker_force_id,
      existing.defender_force_id,
      existing.game_id
    );
    if (paired) return send(res, paired.status, { error: paired.error });
  }
  const previous = cloneData(existing);
  const game = cloneData(existing);
  const state = battleState();
  settleGame(game, previous, state, list, { ...auth.account, confirming: true });
  list[idx] = game;
  writeCollection("games", list);
  saveBattleState(state);
  announceBattleChange(previous, game, auth.account);
  return send(res, 200, game);
}

function playerLabel(playerId) {
  const players = readCollection("players");
  const player = players.find((p) => Number(p.player_id) === Number(playerId));
  if (!player) return "Player " + playerId;
  return player.display_name || "Player " + playerId;
}

function battlePlace(game) {
  const systems = readCollection("systems");
  const sys = systems.find((s) => Number(s.sys_id) === Number(game.sys_id));
  const where = sys && sys.sys_name ? sys.sys_name : "system " + game.sys_id;
  return "Battle #" + game.game_id + " at " + where;
}

function resultPhrase(result) {
  return (
    {
      attacker_win: "an attacker win",
      defender_win: "a defender win",
      draw: "a draw",
      conceded: "a concession",
      unable_to_schedule: "unable to schedule",
      no_show: "a no show"
    }[result] || "a result"
  );
}

function winnerPlayerId(game) {
  if (!game) return null;
  if (game.result === "attacker_win") return Number(game.attacker_id) || null;
  if (game.result === "defender_win") return Number(game.defender_id) || null;
  if ((game.result === "conceded" || game.result === "no_show") && game.winner_id != null && game.winner_id !== "") {
    return Number(game.winner_id) || null;
  }
  return null;
}

function otherParticipant(game, playerId) {
  if (Number(game.attacker_id) === Number(playerId)) return Number(game.defender_id);
  if (Number(game.defender_id) === Number(playerId)) return Number(game.attacker_id);
  return null;
}

function writeNotices(entries) {
  if (!entries || !entries.length) return;
  const list = readCollection("notifications");
  entries.forEach((entry) => {
    list.push({
      notification_id: nextId(list, "notification_id"),
      player_id: entry.player_id == null ? null : Number(entry.player_id),
      audience: entry.audience || "player",
      kind: entry.kind,
      text: entry.text,
      ref: entry.ref || null,
      read: false,
      created_at: new Date().toISOString()
    });
  });
  writeCollection("notifications", list.length > 500 ? list.slice(list.length - 500) : list);
}

function announceBattleChange(previous, game, actor) {
  if (!game) return;
  const notices = [];
  const ref = { type: "game", game_id: game.game_id };
  const title = battlePlace(game);
  const prevState = previous ? previous.result_state : null;
  if (previous && previous.result_state === "applied" && !sameProposal(previous, game)) {
    const winnerId = winnerPlayerId(previous);
    const targets = winnerId
      ? [winnerId]
      : [previous.attacker_id, previous.defender_id].filter(Boolean);
    const who = actor.role === "campaign_admin" ? "The campaign admin" : playerLabel(actor.player_id);
    targets.forEach((pid) => {
      notices.push({
        player_id: Number(pid),
        audience: "player",
        kind: "battle_result_reopened",
        text: who + " reopened your result for " + title + ". The previous outcome is no longer applied.",
        ref
      });
    });
  }
  const proposalChanged =
    !previous ||
    !sameProposal(previous, game) ||
    Number(previous.proposed_by) !== Number(game.proposed_by) ||
    prevState !== "pending";
  const special = game.result === "unable_to_schedule" || game.result === "no_show";

  if (special && game.result_state === "pending" && proposalChanged) {
    const players = [game.attacker_id, game.defender_id].filter(Boolean);
    const offender = game.result === "no_show" ? playerLabel(game.no_show_id) : "";
    const reporter = playerLabel(game.proposed_by);
    const text = game.result === "no_show"
      ? reporter + " reported " + offender + " as a no show for " + title + ". It is waiting for the campaign admin."
      : reporter + " reported " + title + " as unable to schedule. Neither player is penalized.";
    players.forEach((pid) => {
      notices.push({
        player_id: Number(pid),
        audience: "player",
        kind: "battle_result_submitted",
        text,
        ref
      });
    });
    if (game.result === "no_show") {
      notices.push({
        player_id: null,
        audience: "campaign_admin",
        kind: "battle_result_submitted",
        text,
        ref
      });
    }
  } else if (game.result_state === "pending" && proposalChanged && actor.role !== "campaign_admin") {
    const opponent = otherParticipant(game, game.proposed_by);
    if (opponent) {
      notices.push({
        player_id: opponent,
        audience: "player",
        kind: "battle_result_submitted",
        text: playerLabel(game.proposed_by) + " submitted " + resultPhrase(game.result) + " for " + title,
        ref
      });
    }
  }

  if (special && game.result_state === "applied" && prevState !== "applied") {
    const text = game.result === "no_show"
      ? "The campaign admin confirmed the no show for " + title + ". " + playerLabel(game.no_show_id) + "'s force loses, and " + playerLabel(game.winner_id) + " gains an extra logistics action next turn."
      : "Unable to schedule was confirmed for " + title + ". The battle is closed with no penalties.";
    [game.attacker_id, game.defender_id].filter(Boolean).forEach((pid) => {
      notices.push({
        player_id: Number(pid),
        audience: "player",
        kind: "battle_result_applied",
        text,
        ref
      });
    });
  } else if (game.result_state === "applied" && prevState !== "applied") {
    const adminDidIt = actor.role === "campaign_admin";
    const who = adminDidIt ? "The campaign admin" : playerLabel(actor.player_id);
    const targets = new Set();
    if (adminDidIt) {
      if (game.attacker_id) targets.add(Number(game.attacker_id));
      if (game.defender_id) targets.add(Number(game.defender_id));
    } else if (game.proposed_by) {
      targets.add(Number(game.proposed_by));
    }
    targets.forEach((pid) => {
      if (!pid || (!adminDidIt && Number(pid) === Number(actor.player_id))) return;
      notices.push({
        player_id: pid,
        audience: "player",
        kind: adminDidIt ? "battle_result_applied" : "battle_result_confirmed",
        text: adminDidIt
          ? who + " applied the result for " + title
          : who + " confirmed your result for " + title,
        ref
      });
    });
  }

  writeNotices(notices);
}

async function disputeBattle(req, res, idPart) {
  const auth = getSession(req);
  const gate = requireRole(auth, ["player", "campaign_admin"]);
  if (!gate.ok) return send(res, gate.status, { error: gate.error });
  const body = (await readBody(req)) || {};
  const note = clipText(body.note, 300);
  const list = readCollection("games");
  const idx = list.findIndex((g) => String(g.game_id) === String(idPart));
  if (idx < 0) return send(res, 404, { error: "Not found" });
  const existing = list[idx];
  const isAdmin = auth.account.role === "campaign_admin";
  const playerId = Number(auth.account.player_id);
  if (!isAdmin && !isParticipant(existing, playerId)) {
    return send(res, 403, { error: "You can only dispute a battle you are taking part in" });
  }
  if (existing.result === "no_show") {
    return send(res, 409, { error: "A no show is confirmed or rejected by the campaign admin" });
  }
  if (!isAdmin && Number(existing.proposed_by) === playerId) {
    return send(res, 403, { error: "You can't dispute your own result" });
  }
  if (existing.result_state !== "pending") {
    return send(res, 409, { error: "Only a result waiting for confirmation can be disputed" });
  }
  const game = cloneData(existing);
  if (game.resolution) {
    const state = battleState();
    reverseResolution(game, state, list);
    saveBattleState(state);
  }
  game.result_state = "disputed";
  game.resolution = null;
  game.disputed_by = playerId || null;
  game.disputed_at = new Date().toISOString();
  game.dispute_note = note || null;
  list[idx] = game;
  writeCollection("games", list);
  const title = battlePlace(game);
  const who = isAdmin ? "The campaign admin" : playerLabel(playerId);
  const ref = { type: "game", game_id: game.game_id };
  const notices = [
    {
      player_id: null,
      audience: "campaign_admin",
      kind: "battle_result_disputed",
      text: who + " disputed " + resultPhrase(game.result) + " for " + title,
      ref
    }
  ];
  if (game.proposed_by && Number(game.proposed_by) !== playerId) {
    notices.push({
      player_id: Number(game.proposed_by),
      audience: "player",
      kind: "battle_result_disputed",
      text: who + " disputed your result for " + title,
      ref
    });
  }
  writeNotices(notices);
  return send(res, 200, game);
}

async function rejectNoShow(req, res, idPart) {
  const auth = getSession(req);
  const gate = requireRole(auth, ["campaign_admin"]);
  if (!gate.ok) return send(res, gate.status, { error: gate.error });
  const list = readCollection("games");
  const idx = list.findIndex((g) => String(g.game_id) === String(idPart));
  if (idx < 0) return send(res, 404, { error: "Not found" });
  const existing = list[idx];
  if (existing.result !== "no_show" || existing.result_state !== "pending") {
    return send(res, 409, { error: "Only a no show waiting for admin confirmation can be rejected" });
  }
  const game = cloneData(existing);
  if (game.resolution) {
    const state = battleState();
    reverseResolution(game, state, list);
    saveBattleState(state);
  }
  game.result = "in_progress";
  game.winner_id = null;
  game.no_show_id = null;
  game.result_state = "open";
  game.proposed_by = null;
  game.proposed_at = null;
  game.disputed_by = null;
  game.disputed_at = null;
  game.dispute_note = null;
  game.resolution = null;
  game.action_bonus = null;
  game.attacker_vp = null;
  game.defender_vp = null;
  list[idx] = game;
  writeCollection("games", list);
  const title = battlePlace(game);
  const ref = { type: "game", game_id: game.game_id };
  const text = "The campaign admin rejected the no show for " + title + ". The battle is open again and nothing was applied.";
  const notices = [existing.attacker_id, existing.defender_id].filter(Boolean).map((pid) => ({
    player_id: Number(pid),
    audience: "player",
    kind: "battle_result_rejected",
    text,
    ref
  }));
  writeNotices(notices);
  return send(res, 200, game);
}

async function voidBattle(req, res, idPart) {
  const auth = getSession(req);
  const gate = requireRole(auth, ["campaign_admin"]);
  if (!gate.ok) return send(res, gate.status, { error: gate.error });
  const list = readCollection("games");
  const idx = list.findIndex((g) => String(g.game_id) === String(idPart));
  if (idx < 0) return send(res, 404, { error: "Not found" });
  const existing = list[idx];
  if (!["pending", "disputed", "applied"].includes(existing.result_state)) {
    return send(res, 409, { error: "This battle has no result to void" });
  }
  const game = cloneData(existing);
  if (game.resolution) {
    const state = battleState();
    reverseResolution(game, state, list);
    saveBattleState(state);
  }
  game.result = "in_progress";
  game.winner_id = null;
  game.result_state = "open";
  game.proposed_by = null;
  game.proposed_at = null;
  game.disputed_by = null;
  game.disputed_at = null;
  game.dispute_note = null;
  game.resolution = null;
  list[idx] = game;
  writeCollection("games", list);
  const title = battlePlace(game);
  const ref = { type: "game", game_id: game.game_id };
  const notices = [];
  const winnerId = winnerPlayerId(existing);
  [existing.attacker_id, existing.defender_id].forEach((pid) => {
    if (!pid) return;
    const won = winnerId != null && Number(pid) === Number(winnerId);
    notices.push({
      player_id: Number(pid),
      audience: "player",
      kind: "battle_result_voided",
      text: won
        ? "The campaign admin voided your win for " + title + "."
        : "The campaign admin voided the result for " + title + ".",
      ref
    });
  });
  writeNotices(notices);
  return send(res, 200, game);
}

function describeWaitingGame(game) {
  const players = readCollection("players");
  const forces = readCollection("forces");
  const systems = readCollection("systems");
  function pname(id) {
    if (id == null || id === "") return null;
    const player = players.find((p) => Number(p.player_id) === Number(id));
    return player ? player.display_name || "Player " + id : "Player " + id;
  }
  function fname(id) {
    if (id == null || id === "") return null;
    const force = forces.find((f) => Number(f.force_id) === Number(id));
    return force ? force.force_name : "Force " + id;
  }
  const sys = systems.find((s) => Number(s.sys_id) === Number(game.sys_id));
  return {
    type: "battle_result",
    game_id: game.game_id,
    result_state: game.result_state || "open",
    result: game.result,
    turn: game.turn || null,
    sys_id: game.sys_id,
    system_name: sys && sys.sys_name ? sys.sys_name : "System " + game.sys_id,
    mission: game.mission || null,
    attacker_id: game.attacker_id,
    defender_id: game.defender_id,
    attacker_name: pname(game.attacker_id),
    defender_name: pname(game.defender_id),
    attacker_force: fname(game.attacker_force_id),
    defender_force: fname(game.defender_force_id),
    attacker_vp: game.attacker_vp ?? null,
    defender_vp: game.defender_vp ?? null,
    proposed_by: game.proposed_by == null ? null : Number(game.proposed_by),
    proposed_by_name: pname(game.proposed_by),
    proposed_at: game.proposed_at || null,
    disputed_by: game.disputed_by == null ? null : Number(game.disputed_by),
    disputed_by_name: pname(game.disputed_by),
    disputed_at: game.disputed_at || null,
    dispute_note: game.dispute_note || null,
    notes: game.notes || null,
    no_show_id: game.no_show_id == null || game.no_show_id === "" ? null : Number(game.no_show_id),
    no_show_name: game.no_show_id == null || game.no_show_id === "" ? null : pname(game.no_show_id)
  };
}

function inboxFor(account) {
  const games = readCollection("games");
  const notes = readCollection("notifications");
  const isAdmin = account.role === "campaign_admin";
  const pid = account.player_id == null ? null : Number(account.player_id);
  const actions = [];
  const mine = [];
  games
    .slice()
    .sort((a, b) => Number(b.game_id) - Number(a.game_id))
    .forEach((game) => {
      const state = game.result_state;
      const card = describeWaitingGame(game);
      const proposedBy = game.proposed_by == null ? null : Number(game.proposed_by);
      const involved = pid != null && isParticipant(game, pid);
      if (game.result === "no_show" && state === "pending") {
        if (isAdmin) actions.push({ ...card, duty: "no_show" });
      } else if (state === "pending" && involved && proposedBy !== pid) {
        actions.push({ ...card, duty: "confirm" });
      } else if (isAdmin && (state === "pending" || state === "disputed")) {
        actions.push({ ...card, duty: "admin" });
      }
      if (pid != null && proposedBy === pid && (state === "pending" || state === "disputed" || state === "applied")) {
        mine.push({ ...card, duty: state === "applied" ? "done" : "waiting" });
      }
    });
  const visibleNotes = notes
    .filter((n) => {
      if (n.audience === "campaign_admin") return isAdmin;
      return pid != null && Number(n.player_id) === pid;
    })
    .slice()
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 40);
  return {
    actions,
    mine: mine.slice(0, 20),
    notifications: visibleNotes,
    action_count: actions.length,
    unread_count: visibleNotes.filter((n) => !n.read).length
  };
}

async function handleInbox(req, res, parts, method) {
  const auth = getSession(req);
  const gate = requireRole(auth, ["player", "campaign_admin"]);
  if (!gate.ok) return send(res, gate.status, { error: gate.error });
  if (method === "GET" && !parts[1]) return send(res, 200, inboxFor(auth.account));
  if (method === "POST" && parts[1] === "read") {
    const isAdmin = auth.account.role === "campaign_admin";
    const pid = auth.account.player_id == null ? null : Number(auth.account.player_id);
    const list = readCollection("notifications");
    list.forEach((n) => {
      if (n.audience === "campaign_admin" && isAdmin) n.read = true;
      else if ((!n.audience || n.audience === "player") && pid != null && Number(n.player_id) === pid) n.read = true;
    });
    writeCollection("notifications", list);
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: "Unknown inbox action" });
}

function checkVictory(meta, systems, forces, opts = {}) {
  const reasons = [];
  const scoredTurn = opts.scoredTurn == null ? null : Number(opts.scoredTurn);
  const loyalScore = Number(meta.loyal_score) || 0;
  const traitorScore = Number(meta.traitor_score) || 0;

  // Double score and 70% control count only for a turn that has just been
  // scored. The turn number is the one that finished, before it increments.
  if (scoredTurn != null && scoredTurn >= 3) {
    if (loyalScore > 0 && traitorScore > 0) {
      if (loyalScore >= traitorScore * 2) reasons.push({ winner: "Loyalist", reason: "Double campaign score" });
      if (traitorScore >= loyalScore * 2) reasons.push({ winner: "Traitor", reason: "Double campaign score" });
    }
    const total = systems.length || 1;
    const loyalSys = systems.filter((s) => normalizeController(s) === "Loyalist").length;
    const traitorSys = systems.filter((s) => normalizeController(s) === "Traitor").length;
    if (loyalSys / total > 0.7) reasons.push({ winner: "Loyalist", reason: "Over 70% systems controlled" });
    if (traitorSys / total > 0.7) reasons.push({ winner: "Traitor", reason: "Over 70% systems controlled" });
  }

  const active = forces.filter((f) => f.status === "active");
  const loyalForces = active.filter((f) => f.allegiance === "Loyalist");
  const traitorForces = active.filter((f) => f.allegiance === "Traitor");
  if (loyalForces.length > 0 && loyalForces.every((f) => Number(f.strength) <= 1)) {
    reasons.push({ winner: "Traitor", reason: "All Loyalist forces at strength 1 or less" });
  }
  if (traitorForces.length > 0 && traitorForces.every((f) => Number(f.strength) <= 1)) {
    reasons.push({ winner: "Loyalist", reason: "All Traitor forces at strength 1 or less" });
  }
  if (loyalForces.length === 0 && traitorForces.length > 0) {
    reasons.push({ winner: "Traitor", reason: "No active Loyalist forces" });
  }
  if (traitorForces.length === 0 && loyalForces.length > 0) {
    reasons.push({ winner: "Loyalist", reason: "No active Traitor forces" });
  }

  return reasons[0] || null;
}

const ACTIONS_PER_TURN = 2;

function parseLinks(sys) {
  if (!sys || sys.sys_links == null || sys.sys_links === "") return [];
  return String(sys.sys_links)
    .split(/[,;\s]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => !Number.isNaN(n) && n > 0);
}

function systemDurability(sys) {
  if (sys.sys_durability == null || sys.sys_durability === "") return 5;
  return Number(sys.sys_durability) || 0;
}

function ensurePlayerActions(meta, playerId, turn) {
  if (!meta.player_actions || typeof meta.player_actions !== "object") {
    meta.player_actions = {};
  }
  const key = String(playerId);
  let entry = meta.player_actions[key];
  if (!entry || Number(entry.turn) !== Number(turn)) {
    entry = { turn: Number(turn), used: 0, log: [] };
    meta.player_actions[key] = entry;
  }
  return entry;
}

function actionBonus(meta, playerId, turn) {
  const all = meta && meta.action_bonuses;
  if (!all || typeof all !== "object") return 0;
  const bag = all[String(playerId)];
  if (!bag || typeof bag !== "object") return 0;
  const extra = Number(bag[String(turn)]);
  if (!Number.isFinite(extra) || extra <= 0) return 0;
  return extra;
}

function actionsForTurn(meta, playerId, turn) {
  return ACTIONS_PER_TURN + actionBonus(meta, playerId, turn == null ? Number(meta && meta.turn) || 1 : turn);
}

function actionsRemaining(meta, playerId) {
  const turn = Number(meta.turn) || 1;
  const entry = ensurePlayerActions(meta, playerId, turn);
  return Math.max(0, actionsForTurn(meta, playerId, turn) - (Number(entry.used) || 0));
}

function actionsUsedThisTurn(meta, playerId) {
  const turn = Number(meta && meta.turn) || 1;
  const bag = meta && meta.player_actions && typeof meta.player_actions === "object" ? meta.player_actions : {};
  const entry = bag[String(playerId)];
  if (!entry || Number(entry.turn) !== turn) return 0;
  const used = Number(entry.used) || 0;
  return used > 0 ? used : 0;
}

function canSpendCampaignActions(player) {
  return sideOf(player) != null;
}

function rosterName(player) {
  return player.display_name || player.player_name || "Player " + player.player_id;
}

function playerActionRoster() {
  const meta = readCollection("meta") || {};
  const forces = readCollection("forces");
  const turn = Number(meta.turn) || 1;
  const everyone = readCollection("players");
  const needsSide = everyone
    .filter((player) => !sideOf(player))
    .map((player) => ({
      player_id: player.player_id,
      display_name: rosterName(player),
      status: player.status || "active",
      allegiance: player.allegiance || ""
    }))
    .sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)));
  const players = everyone
    .filter((player) => String(player.status || "active").toLowerCase() === "active" && sideOf(player))
    .map((player) => {
      const used = actionsUsedThisTurn(meta, player.player_id);
      const cap = actionsForTurn(meta, player.player_id, turn);
      const remaining = Math.max(0, cap - used);
      const activeForces = forces.filter(
        (force) => Number(force.player_id) === Number(player.player_id) && force.status === "active"
      ).length;
      return {
        player_id: player.player_id,
        display_name: rosterName(player),
        allegiance: player.allegiance,
        actions_used: Math.min(used, cap),
        actions_remaining: remaining,
        actions_per_turn: cap,
        active_forces: activeForces,
        finished: remaining === 0
      };
    })
    .sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)));
  const activePlayers = players.length;
  const finished = players.filter((player) => player.finished).length;
  return {
    turn,
    phase: meta.phase || "Logistics",
    actions_per_turn: ACTIONS_PER_TURN,
    active_players: activePlayers,
    finished,
    ready_to_advance: activePlayers > 0 && finished === activePlayers,
    needs_side: needsSide,
    players
  };
}

function spendAction(meta, playerId, note) {
  const turn = Number(meta.turn) || 1;
  const entry = ensurePlayerActions(meta, playerId, turn);
  const cap = actionsForTurn(meta, playerId, turn);
  if ((Number(entry.used) || 0) >= cap) {
    return { ok: false, error: "No actions remaining this turn (" + cap + " per turn)" };
  }
  entry.used = (Number(entry.used) || 0) + 1;
  entry.log = (entry.log || []).slice(-30);
  entry.log.push({
    at: new Date().toISOString(),
    note: note || "action",
    remaining: cap - entry.used
  });
  return { ok: true, entry };
}

function refundAction(meta, playerId, note) {
  const turn = Number(meta.turn) || 1;
  const entry = ensurePlayerActions(meta, playerId, turn);
  const used = Number(entry.used) || 0;
  if (used <= 0) return { ok: true, refunded: false, entry };
  entry.used = used - 1;
  entry.log = (entry.log || []).slice(-30);
  entry.log.push({
    at: new Date().toISOString(),
    note: note || "refund",
    remaining: actionsForTurn(meta, playerId, turn) - entry.used
  });
  return { ok: true, refunded: true, entry };
}

function playerOwnsForce(force, auth) {
  if (!force || !auth || !auth.account) return false;
  if (auth.account.role === "campaign_admin") return true;
  return (
    auth.account.role === "player" &&
    Number(force.player_id) === Number(auth.account.player_id)
  );
}

function opposingForcesInSystem(forces, sysId, allegiance) {
  const other = otherSide(allegiance);
  if (!other) return [];
  return forces.filter(
    (f) => f.status === "active" && Number(f.sys_id) === Number(sysId) && f.allegiance === other
  );
}

function controlledByAllegiance(sys, allegiance) {
  const c = normalizeController(sys);
  return c === allegiance;
}

function isUnresolvedBattle(game, turn) {
  const state = game.result_state || "open";
  if (!["open", "pending", "disputed"].includes(state)) return false;
  if (game.turn == null || game.turn === "") return true;
  return Number(game.turn) <= Number(turn);
}

function unresolvedBattles(turn) {
  return readCollection("games").filter((g) => isUnresolvedBattle(g, turn));
}

function unresolvedBattleSummary(game) {
  const systems = readCollection("systems");
  const sys = systems.find((s) => Number(s.sys_id) === Number(game.sys_id));
  const where = sys && sys.sys_name ? sys.sys_name : "system " + game.sys_id;
  const state = game.result_state || "open";
  return (
    "#" +
    game.game_id +
    " " +
    where +
    " (" +
    playerLabel(game.attacker_id) +
    " vs " +
    playerLabel(game.defender_id) +
    ", " +
    state +
    ")"
  );
}

function unresolvedBattlePayload(game) {
  return {
    game_id: game.game_id,
    turn: game.turn == null || game.turn === "" ? null : Number(game.turn),
    sys_id: game.sys_id,
    result_state: game.result_state || "open",
    result: game.result || null,
    attacker_id: game.attacker_id ?? null,
    defender_id: game.defender_id ?? null,
    summary: unresolvedBattleSummary(game)
  };
}

function unresolvedAdvanceError(games) {
  const listed = games.map((g) => unresolvedBattleSummary(g)).join("; ");
  const n = games.length;
  return (
    "Cannot advance while " +
    n +
    " battle" +
    (n === 1 ? " is" : "s are") +
    " still open: " +
    listed +
    '. Pass { "force": true } to void them and advance. Voided battles are not scored and do not change strength or influence.'
  );
}

function voidUnresolvedBattles(turn) {
  const games = readCollection("games");
  const state = battleState();
  const notices = [];
  let count = 0;
  games.forEach((game) => {
    if (!isUnresolvedBattle(game, turn)) return;
    if (game.resolution) reverseResolution(game, state, games);
    const title = battlePlace(game);
    game.result = "in_progress";
    game.winner_id = null;
    game.result_state = "void";
    game.proposed_by = null;
    game.proposed_at = null;
    game.disputed_by = null;
    game.disputed_at = null;
    game.dispute_note = null;
    game.resolution = null;
    game.voided_at = new Date().toISOString();
    game.void_reason = "Turn advanced with this battle unresolved";
    [game.attacker_id, game.defender_id].forEach((pid) => {
      if (!pid) return;
      notices.push({
        player_id: Number(pid),
        audience: "player",
        kind: "battle_result_voided",
        text: "The turn advanced and voided " + title + ". No result was applied.",
        ref: { type: "game", game_id: game.game_id }
      });
    });
    count += 1;
  });
  if (count) {
    saveBattleState(state);
    writeCollection("games", games);
    writeNotices(notices);
  }
  return count;
}

/**
 * Void open and pending battles that a force can no longer fight.
 * Applied battles stay as history. A battle with no resolution is left
 * unreversed. No winner is written.
 * options.turn limits the void to that campaign turn (the current phase).
 * options.exceptGameId skips the battle that just destroyed the force.
 * The caller saves games and battle state.
 */
function voidUnfoughtBattles(forceIds, options) {
  const wanted = new Set((forceIds || []).map((id) => Number(id)).filter((id) => id));
  if (!wanted.size) return 0;
  const games = options.games;
  const state = options.state;
  const turn = options.turn == null ? null : Number(options.turn);
  const exceptGameId = options.exceptGameId;
  const reason = options.reason || "force_destroyed";
  const notices = [];
  let count = 0;
  games.forEach((game) => {
    if (exceptGameId != null && Number(game.game_id) === Number(exceptGameId)) return;
    if (turn != null && Number(game.turn) !== turn) return;
    const stateName = game.result_state || "open";
    if (stateName !== "open" && stateName !== "pending") return;
    const involved =
      wanted.has(Number(game.attacker_force_id)) || wanted.has(Number(game.defender_force_id));
    if (!involved) return;
    if (game.resolution && state) reverseResolution(game, state, games);
    const title = battlePlace(game);
    game.result = "in_progress";
    game.winner_id = null;
    game.result_state = "void";
    game.proposed_by = null;
    game.proposed_at = null;
    game.disputed_by = null;
    game.disputed_at = null;
    game.dispute_note = null;
    game.resolution = null;
    game.voided_at = new Date().toISOString();
    game.void_reason = reason;
    const text =
      reason === "player_removed"
        ? title + " was voided because a player was removed. No result was applied."
        : title + " was voided because one of its forces was destroyed. No result was applied.";
    const seen = new Set();
    [game.attacker_id, game.defender_id].forEach((pid) => {
      if (!pid || seen.has(Number(pid))) return;
      seen.add(Number(pid));
      notices.push({
        player_id: Number(pid),
        audience: "player",
        kind: "battle_result_voided",
        text,
        ref: { type: "game", game_id: game.game_id }
      });
    });
    count += 1;
  });
  if (notices.length) writeNotices(notices);
  return count;
}

function advanceCampaign(meta, options = {}) {
  const log = [];
  let scoredTurn = null;
  let systems = recomputeControllers(readCollection("systems"));
  let forces = readCollection("forces");
  let phase = meta.phase || "Logistics";
  let turn = Number(meta.turn) || 1;
  if (!PHASES.includes(phase)) phase = "Logistics";

  const fromPhase = phase;
  const fromTurn = turn;

  // Optional: jump to a specific phase (admin override)
  if (options.set_phase && PHASES.includes(options.set_phase)) {
    // When jumping, still apply side effects for skipped transitions if requested
    phase = options.set_phase;
    log.push(`Phase set to ${phase}`);
  } else {
    // Normal advance: Logistics → Movement → Battles → next turn Logistics
    if (phase === "Logistics") {
      phase = "Movement";
      log.push("Advanced to Movement phase");
    } else if (phase === "Movement") {
      forces = applyPendingMoves(forces);
      writeCollection("forces", forces);
      const assigned = assignBattles(turn);
      phase = "Battles";
      log.push("Applied pending moves; advanced to Battles phase");
      if (assigned) log.push(`Assigned ${assigned} battle${assigned === 1 ? "" : "s"} between opposing forces`);
    } else {
      // End of Battles → void anything still unresolved, then score, recover, new turn.
      // Unresolved battles are not carried into the next turn. A normal advance
      // refuses while any remain. { force: true } voids them: no result is
      // applied, and strength and influence are left as they were.
      const open = unresolvedBattles(turn);
      if (open.length && !options.force) {
        return {
          ok: false,
          code: "unresolved_battles",
          error: unresolvedAdvanceError(open),
          battles: open.map(unresolvedBattlePayload)
        };
      }
      if (open.length) {
        const voided = voidUnresolvedBattles(turn);
        log.push(`Voided ${voided} unresolved battle${voided === 1 ? "" : "s"} (no result applied)`);
        systems = recomputeControllers(readCollection("systems"));
        forces = readCollection("forces");
      }
      const gained = scoreFromSystems(systems);
      meta.loyal_score = (Number(meta.loyal_score) || 0) + gained.loyal;
      meta.traitor_score = (Number(meta.traitor_score) || 0) + gained.traitor;
      log.push(`Turn ${turn} scoring: Loyalist +${gained.loyal}, Traitor +${gained.traitor}`);

      forces = applyForceRecovery(forces, systems);
      log.push("Applied end-of-turn force recovery");

      scoredTurn = turn;
      turn += 1;
      phase = "Logistics";
      // Reset action economy for the new turn
      meta.player_actions = {};
      log.push(`Started turn ${turn}, Logistics phase (actions reset)`);
    }
  }

  meta.turn = turn;
  meta.phase = phase;
  meta.last_advanced_at = new Date().toISOString();
  if (meta.phase_ends_at) log.push("Cleared the phase deadline");
  meta.phase_ends_at = null;
  meta.auto_advance_blocked = null;
  if (options.automatic) log.unshift(automaticAdvanceNote(options.reason));
  meta.phase_log = (meta.phase_log || []).slice(-20).concat([
    {
      at: meta.last_advanced_at,
      from: { turn: fromTurn, phase: fromPhase },
      to: { turn, phase },
      automatic: !!options.automatic,
      reason: options.automatic ? options.reason || null : null,
      notes: log
    }
  ]);

  const victory = checkVictory(meta, systems, forces, { scoredTurn });
  if (victory) {
    meta.victor = victory.winner;
    meta.victory_reason = victory.reason;
    log.push(`Victory: ${victory.winner} — ${victory.reason}`);
  }

  writeCollection("systems", systems);
  writeCollection("forces", forces);
  writeCollection("meta", meta);
  announcePhaseAdvance(
    { turn: fromTurn, phase: fromPhase },
    { turn, phase },
    options
  );

  return {
    ok: true,
    meta,
    log,
    from: { turn: fromTurn, phase: fromPhase },
    to: { turn, phase },
    victory
  };
}

const AUTO_ADVANCE_INTERVAL_MS = (() => {
  const raw = Number(process.env.AUTO_ADVANCE_INTERVAL_MS);
  if (Number.isFinite(raw) && raw >= 200) return Math.min(raw, 60000);
  return 30000;
})();
let advanceLock = false;

function withAdvanceLock(fn) {
  if (advanceLock) {
    return { ok: false, code: "advance_in_progress", error: "An advance is already in progress" };
  }
  advanceLock = true;
  try {
    return fn();
  } finally {
    advanceLock = false;
  }
}

function automaticAdvanceNote(reason) {
  if (reason === "deadline") return "Automatic advance: the phase deadline passed";
  if (reason === "all_actions_done") return "Automatic advance: every counted player is out of actions";
  return "Automatic advance";
}

function phaseAdvanceText(from, to, options) {
  const where =
    Number(from.turn) === Number(to.turn)
      ? "from " + from.phase + " to " + to.phase + " (turn " + to.turn + ")"
      : "from " + from.phase + " (turn " + from.turn + ") to " + to.phase + " (turn " + to.turn + ")";
  let because = "";
  if (options.automatic && options.reason === "deadline") because = " because the phase deadline passed";
  if (options.automatic && options.reason === "all_actions_done") {
    because = " because every counted player is out of actions";
  }
  return "The campaign advanced" + (options.automatic ? " automatically" : "") + " " + where + because + ".";
}

function announcePhaseAdvance(from, to, options) {
  const text = phaseAdvanceText(from, to, options || {});
  const notices = readCollection("players")
    .filter((player) => player && player.player_id != null)
    .map((player) => ({
      player_id: player.player_id,
      audience: "player",
      kind: "phase_advanced",
      text,
      ref: {
        type: "campaign",
        turn: to.turn,
        phase: to.phase,
        automatic: !!(options && options.automatic),
        reason: options && options.automatic ? options.reason || null : null
      }
    }));
  writeNotices(notices);
}

function autoAdvanceReason(meta, now) {
  if (!meta || meta.victor) return null;
  const deadlineMs = meta.phase_ends_at ? Date.parse(meta.phase_ends_at) : NaN;
  if (Number.isFinite(deadlineMs) && deadlineMs <= now) return "deadline";
  if (meta.auto_advance_when_done === false) return null;
  const phase = meta.phase || "Logistics";
  if (phase !== "Logistics") return null;
  const roster = playerActionRoster();
  if (roster.ready_to_advance) return "all_actions_done";
  return null;
}

function maybeAutoAdvance() {
  return withAdvanceLock(() => {
    const meta = readCollection("meta");
    const fromTurn = Number(meta.turn) || 1;
    const fromPhase = meta.phase || "Logistics";
    const reason = autoAdvanceReason(meta, Date.now());
    if (!reason) {
      if (meta.auto_advance_blocked) {
        meta.auto_advance_blocked = null;
        writeCollection("meta", meta);
      }
      return { ok: true, advanced: false };
    }
    const again = readCollection("meta");
    if ((Number(again.turn) || 1) !== fromTurn || (again.phase || "Logistics") !== fromPhase) {
      return { ok: true, advanced: false, skipped: "stale" };
    }
    const result = advanceCampaign(again, { automatic: true, reason, force: false });
    if (result && result.ok === false) {
      if (result.code === "unresolved_battles") {
        const count = (result.battles || []).length;
        again.auto_advance_blocked = {
          at: new Date().toISOString(),
          reason,
          battles: count,
          message: "Auto-advance blocked: " + count + " open battles"
        };
        writeCollection("meta", again);
      }
      return { ok: false, advanced: false, result };
    }
    return { ok: true, advanced: true, result };
  });
}

function runAutoAdvanceSafe() {
  try {
    return maybeAutoAdvance();
  } catch (err) {
    console.error("Auto-advance check failed", err);
    return { ok: false, error: err && err.message };
  }
}

async function handleCampaign(req, res, parts, method) {
  const action = parts[1]; // advance | status | set-phase
  const auth = getSession(req);

  if (method === "OPTIONS") return send(res, 204, "");

  if (action === "status" && method === "GET") {
    const meta = readCollection("meta");
    const systems = readCollection("systems");
    const forces = readCollection("forces");
    const snap = scoreFromSystems(systems);
    return send(res, 200, {
      turn: meta.turn,
      phase: meta.phase,
      loyal_score: meta.loyal_score,
      traitor_score: meta.traitor_score,
      control_power: snap,
      victor: meta.victor || null,
      victory_reason: meta.victory_reason || null,
      last_advanced_at: meta.last_advanced_at || null,
      phase_ends_at: meta.phase_ends_at || null,
      auto_advance_when_done: meta.auto_advance_when_done !== false,
      auto_advance_blocked: meta.auto_advance_blocked || null,
      phases: PHASES
    });
  }

  if (action === "phase-deadline" && method === "POST") {
    const gate = requireRole(auth, ["campaign_admin"]);
    if (!gate.ok) return send(res, gate.status, { error: gate.error });
    const body = (await readBody(req)) || {};
    if (!Object.prototype.hasOwnProperty.call(body, "phase_ends_at")) {
      return send(res, 400, { error: "phase_ends_at is required" });
    }
    const parsed = parsePhaseDeadline(body.phase_ends_at);
    if (!parsed.ok) return send(res, 400, { error: parsed.error });
    const meta = readCollection("meta");
    meta.phase_ends_at = parsed.phase_ends_at;
    writeCollection("meta", meta);
    const check = runAutoAdvanceSafe();
    const saved = readCollection("meta");
    return send(res, 200, {
      ok: true,
      phase_ends_at: saved.phase_ends_at || null,
      phase: saved.phase || null,
      turn: saved.turn || null,
      advanced: !!(check && check.advanced),
      auto_advance_blocked: saved.auto_advance_blocked || null
    });
  }

  if (action === "auto-advance" && method === "POST") {
    const gate = requireRole(auth, ["campaign_admin"]);
    if (!gate.ok) return send(res, gate.status, { error: gate.error });
    const body = (await readBody(req)) || {};
    if (typeof body.enabled !== "boolean") {
      return send(res, 400, { error: "enabled must be true or false" });
    }
    const meta = readCollection("meta");
    meta.auto_advance_when_done = body.enabled;
    writeCollection("meta", meta);
    const check = body.enabled ? runAutoAdvanceSafe() : { advanced: false };
    const saved = readCollection("meta");
    return send(res, 200, {
      ok: true,
      auto_advance_when_done: saved.auto_advance_when_done !== false,
      advanced: !!(check && check.advanced),
      phase: saved.phase || null,
      turn: saved.turn || null
    });
  }

  if (action === "advance" && method === "POST") {
    const gate = requireRole(auth, ["campaign_admin"]);
    if (!gate.ok) return send(res, gate.status, { error: gate.error });
    const body = (await readBody(req)) || {};
    const result = withAdvanceLock(() => {
      const current = readCollection("meta");
      if (current.victor && !body.force) {
        return {
          ok: false,
          code: "victor",
          status: 409,
          error: "Campaign already has a victor. Pass { force: true } to advance anyway.",
          victor: current.victor,
          victory_reason: current.victory_reason
        };
      }
      return advanceCampaign(current, { force: !!body.force });
    });
    if (result && result.ok === false) {
      return send(res, result.status || 409, {
        error: result.error,
        code: result.code,
        battles: result.battles,
        victor: result.victor,
        victory_reason: result.victory_reason
      });
    }
    return send(res, 200, result);
  }

  if (action === "set-phase" && method === "POST") {
    const gate = requireRole(auth, ["campaign_admin"]);
    if (!gate.ok) return send(res, gate.status, { error: gate.error });
    const body = (await readBody(req)) || {};
    if (!PHASES.includes(body.phase)) {
      return send(res, 400, { error: "phase must be one of: " + PHASES.join(", ") });
    }
    const meta = readCollection("meta");
    // Direct set without side effects (admin correction)
    const from = { turn: meta.turn, phase: meta.phase };
    if (body.turn != null && body.turn !== "") {
      const turn = parsePositiveInteger(body.turn);
      if (turn == null) return send(res, 400, { error: "turn must be a positive integer" });
      meta.turn = turn;
    }
    meta.phase = body.phase;
    meta.last_advanced_at = new Date().toISOString();
    writeCollection("meta", meta);
    return send(res, 200, { ok: true, from, to: { turn: meta.turn, phase: meta.phase }, meta });
  }

  if (action === "reset" && method === "POST") {
    const gate = requireRole(auth, ["campaign_admin"]);
    if (!gate.ok) return send(res, gate.status, { error: gate.error });
    const body = (await readBody(req)) || {};
    if (body.confirm !== "RESET") {
      return send(res, 400, { error: 'Send { "confirm": "RESET" } to reset the campaign' });
    }
    if (body.keep_systems) {
      return send(res, 400, {
        error: "keep_systems has been replaced by keep_map and keep_control."
      });
    }
    if (body.keep_control && !body.keep_map) {
      return send(res, 400, {
        error: "Keep current system control requires Keep current map."
      });
    }
    const result = resetCampaign({
      keep_map: !!body.keep_map,
      keep_control: !!body.keep_control,
      purge_accounts: !!body.purge_accounts
    });
    return send(res, 200, result);
  }

  return send(res, 404, { error: "Unknown campaign action. Use advance|status|set-phase|phase-deadline|auto-advance|reset" });
}

function parsePhaseDeadline(value) {
  if (value == null || value === "") return { ok: true, phase_ends_at: null };
  if (typeof value !== "string") return { ok: false, error: "Phase deadline must be a date and time" };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, phase_ends_at: null };
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed)) {
    return { ok: false, error: "Phase deadline must be a date and time" };
  }
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return { ok: false, error: "Phase deadline must be a date and time" };
  return { ok: true, phase_ends_at: new Date(ms).toISOString() };
}

/**
 * Player campaign actions (rules-enforced).
 *   GET  /api/actions/status
 *   GET  /api/actions/players   (campaign_admin) remaining actions this turn
 *   POST /api/actions/move      { force_id, dest_sys_id }
 *   POST /api/actions/hold      { force_id }  (free: clear pending move)
 *   POST /api/actions/reinforce { force_id }
 *   POST /api/actions/fortify   { sys_id }
 *   POST /api/actions/generate  { sys_id, force_name?, ...optional force fields }
 */
async function handleActions(req, res, parts, method) {
  const action = parts[1];
  const auth = getSession(req);

  if (method === "OPTIONS") return send(res, 204, "");

  if (action === "status" && method === "GET") {
    const meta = readCollection("meta");
    const payload = {
      turn: meta.turn,
      phase: meta.phase,
      actions_per_turn: ACTIONS_PER_TURN,
      authenticated: !!(auth && auth.account),
      role: auth && auth.account ? auth.account.role : "visitor"
    };
    if (auth && auth.account && auth.account.role === "player" && auth.account.player_id) {
      const entry = ensurePlayerActions(meta, auth.account.player_id, meta.turn);
      const cap = actionsForTurn(meta, auth.account.player_id, meta.turn);
      payload.player_id = auth.account.player_id;
      payload.actions_per_turn = cap;
      payload.actions_used = Number(entry.used) || 0;
      payload.actions_remaining = Math.max(0, cap - payload.actions_used);
      payload.log = entry.log || [];
    } else if (auth && auth.account && auth.account.role === "campaign_admin") {
      payload.actions_used = 0;
      payload.actions_remaining = ACTIONS_PER_TURN;
      payload.admin = true;
      payload.player_actions = meta.player_actions || {};
    }
    return send(res, 200, payload);
  }

  if (action === "players" && method === "GET") {
    const gate = requireRole(auth, ["campaign_admin"]);
    if (!gate.ok) return send(res, gate.status, { error: gate.error });
    return send(res, 200, playerActionRoster());
  }

  const gate = requireRole(auth, ["player", "campaign_admin"]);
  if (!gate.ok) return send(res, gate.status, { error: gate.error });

  if (method !== "POST") {
    return send(res, 405, { error: "Use POST for actions, GET for status" });
  }

  const body = (await readBody(req)) || {};
  const meta = readCollection("meta");
  const phase = meta.phase || "Logistics";
  const turn = Number(meta.turn) || 1;

  // Resolve acting player_id (admin may act for a player via body.player_id)
  let playerId = auth.account.player_id;
  if (auth.account.role === "campaign_admin") {
    if (body.player_id != null) playerId = Number(body.player_id);
    else if (playerId == null && ["move", "reinforce", "hold"].includes(action) && body.force_id != null) {
      const forcesPeek = readCollection("forces");
      const f = forcesPeek.find((x) => Number(x.force_id) === Number(body.force_id));
      if (f) playerId = f.player_id;
    }
  }
  if (playerId == null) {
    return send(res, 400, { error: "player_id required (admin must specify which player)" });
  }

  const players = readCollection("players");
  const player = players.find((p) => Number(p.player_id) === Number(playerId));
  if (!player) return send(res, 404, { error: "Player not found" });
  const allegiance = sideOf(player);
  if (!allegiance) {
    return send(res, 400, { error: "This player needs a Loyalist or Traitor side before they can take campaign actions" });
  }

  // Admin bypasses action economy only when explicitly requested
  const spendForPlayer = auth.account.role !== "campaign_admin" || body.spend !== false;

  function trySpend(note) {
    if (!spendForPlayer) return { ok: true, entry: ensurePlayerActions(meta, playerId, turn) };
    return spendAction(meta, playerId, note);
  }

  if (action === "move") {
    if (phase !== "Movement") {
      return send(res, 409, { error: "Move is only allowed during the Movement phase" });
    }
    const forceId = Number(body.force_id);
    const destId = Number(body.dest_sys_id);
    if (!forceId || !destId) return send(res, 400, { error: "force_id and dest_sys_id required" });

    let forces = readCollection("forces");
    const force = forces.find((f) => Number(f.force_id) === forceId);
    if (!force) return send(res, 404, { error: "Force not found" });
    if (!playerOwnsForce(force, { account: { role: auth.account.role, player_id: playerId } }) &&
        auth.account.role !== "campaign_admin") {
      return send(res, 403, { error: "Not your force" });
    }
    if (Number(force.player_id) !== Number(playerId) && auth.account.role !== "campaign_admin") {
      return send(res, 403, { error: "Not your force" });
    }
    if (force.status !== "active") return send(res, 400, { error: "Force is not active" });
    if (Number(force.sys_id) === destId) {
      return send(res, 400, { error: "Already in that system; use Hold to clear a pending move" });
    }

    const systems = readCollection("systems");
    const fromSys = systems.find((s) => Number(s.sys_id) === Number(force.sys_id));
    const toSys = systems.find((s) => Number(s.sys_id) === destId);
    if (!fromSys || !toSys) return send(res, 404, { error: "System not found" });
    const links = parseLinks(fromSys);
    if (!links.includes(destId)) {
      return send(res, 400, {
        error: `${fromSys.sys_name} is not connected to ${toSys.sys_name}`,
        links
      });
    }

    if (Number(force.dest_sys_id) === destId) {
      return send(res, 200, {
        ok: true,
        action: "move",
        force,
        actions_remaining: actionsRemaining(meta, playerId),
        message: `Already ordered ${force.force_name} to move to ${toSys.sys_name}`
      });
    }
    const alreadyOrdered = force.dest_sys_id != null && force.dest_sys_id !== "";
    if (!alreadyOrdered) {
      const spent = trySpend(`Move force ${forceId} → ${toSys.sys_name}`);
      if (!spent.ok) return send(res, 409, { error: spent.error });
      writeCollection("meta", meta);
    }

    force.dest_sys_id = destId;
    writeCollection("forces", forces);
    runAutoAdvanceSafe();
    return send(res, 200, {
      ok: true,
      action: "move",
      force,
      actions_remaining: actionsRemaining(meta, playerId),
      message: `Ordered ${force.force_name} to move to ${toSys.sys_name}`
    });
  }

  if (action === "hold") {
    // Hold costs nothing. Cancelling a Move that has not resolved refunds that action.
    if (phase !== "Movement") {
      return send(res, 409, { error: "Hold is only allowed during the Movement phase" });
    }
    const forceId = Number(body.force_id);
    if (!forceId) return send(res, 400, { error: "force_id required" });
    let forces = readCollection("forces");
    const force = forces.find((f) => Number(f.force_id) === forceId);
    if (!force) return send(res, 404, { error: "Force not found" });
    if (Number(force.player_id) !== Number(playerId) && auth.account.role !== "campaign_admin") {
      return send(res, 403, { error: "Not your force" });
    }
    const hadMove = force.dest_sys_id != null && force.dest_sys_id !== "";
    force.dest_sys_id = null;
    let refunded = false;
    if (hadMove && spendForPlayer) {
      refunded = refundAction(meta, playerId, `Hold refunds the move for force ${forceId}`).refunded;
      if (refunded) writeCollection("meta", meta);
    }
    writeCollection("forces", forces);
    return send(res, 200, {
      ok: true,
      action: "hold",
      force,
      actions_remaining: actionsRemaining(meta, playerId),
      message: refunded
        ? `${force.force_name} holds. The move action was refunded.`
        : `${force.force_name} holds position`
    });
  }

  if (action === "reinforce") {
    if (phase !== "Logistics") {
      return send(res, 409, { error: "Reinforce is only allowed during the Logistics phase" });
    }
    const forceId = Number(body.force_id);
    if (!forceId) return send(res, 400, { error: "force_id required" });

    let forces = readCollection("forces");
    const force = forces.find((f) => Number(f.force_id) === forceId);
    if (!force) return send(res, 404, { error: "Force not found" });
    if (Number(force.player_id) !== Number(playerId) && auth.account.role !== "campaign_admin") {
      return send(res, 403, { error: "Not your force" });
    }
    if (force.status !== "active") return send(res, 400, { error: "Force is not active" });
    const strength = Number(force.strength) || 0;
    if (strength >= 3) return send(res, 400, { error: "Force already at maximum strength (3)" });

    const systems = recomputeControllers(readCollection("systems"));
    const sys = systems.find((s) => Number(s.sys_id) === Number(force.sys_id));
    if (!sys) return send(res, 404, { error: "Force has no valid system" });
    if (!controlledByAllegiance(sys, allegiance)) {
      return send(res, 400, {
        error: `Can only Reinforce in a ${allegiance}-controlled system (current: ${normalizeController(sys)})`
      });
    }

    const spent = trySpend(`Reinforce force ${forceId} in ${sys.sys_name}`);
    if (!spent.ok) return send(res, 409, { error: spent.error });

    force.strength = strength + 1;
    writeCollection("forces", forces);
    writeCollection("meta", meta);
    runAutoAdvanceSafe();
    return send(res, 200, {
      ok: true,
      action: "reinforce",
      force,
      actions_remaining: actionsRemaining(meta, playerId),
      message: `${force.force_name} reinforced to strength ${force.strength}`
    });
  }

  if (action === "fortify") {
    if (phase !== "Logistics") {
      return send(res, 409, { error: "Fortify is only allowed during the Logistics phase" });
    }
    const sysId = Number(body.sys_id);
    if (!sysId) return send(res, 400, { error: "sys_id required" });

    let systems = recomputeControllers(readCollection("systems"));
    const idx = systems.findIndex((s) => Number(s.sys_id) === sysId);
    if (idx < 0) return send(res, 404, { error: "System not found" });
    const sys = systems[idx];
    if (!controlledByAllegiance(sys, allegiance)) {
      return send(res, 400, {
        error: `Can only Fortify a ${allegiance}-controlled system (current: ${normalizeController(sys)})`
      });
    }
    const dur = systemDurability(sys);
    if (dur >= 10) return send(res, 400, { error: "System already at maximum durability (10)" });

    // campaign_rules.md (Logistics): Fortify requires one of the acting player's own
    // active forces in the system (added as part of web app build). Campaign admin may
    // still fortify without that force.
    const forces = readCollection("forces");
    const present = forces.some(
      (f) =>
        f.status === "active" &&
        Number(f.sys_id) === sysId &&
        Number(f.player_id) === Number(playerId)
    );
    if (!present && auth.account.role !== "campaign_admin") {
      return send(res, 400, { error: "You need an active force in the system to Fortify it" });
    }

    const spent = trySpend(`Fortify ${sys.sys_name}`);
    if (!spent.ok) return send(res, 409, { error: spent.error });

    systems[idx] = { ...sys, sys_durability: dur + 1 };
    writeCollection("systems", systems);
    writeCollection("meta", meta);
    runAutoAdvanceSafe();
    return send(res, 200, {
      ok: true,
      action: "fortify",
      system: systems[idx],
      actions_remaining: actionsRemaining(meta, playerId),
      message: `${sys.sys_name} fortified to durability ${dur + 1}`
    });
  }

  if (action === "generate") {
    if (phase !== "Logistics") {
      return send(res, 409, { error: "Generate Force is only allowed during the Logistics phase" });
    }
    const sysId = Number(body.sys_id);
    if (!sysId) return send(res, 400, { error: "sys_id required" });

    const systems = recomputeControllers(readCollection("systems"));
    const sys = systems.find((s) => Number(s.sys_id) === sysId);
    if (!sys) return send(res, 404, { error: "System not found" });
    if (!controlledByAllegiance(sys, allegiance)) {
      return send(res, 400, {
        error: `Can only Generate Force in a ${allegiance}-controlled system (current: ${normalizeController(sys)})`
      });
    }

    let forces = readCollection("forces");
    const opposing = opposingForcesInSystem(forces, sysId, allegiance);
    if (opposing.length) {
      return send(res, 400, {
        error: "Cannot Generate Force: opposing forces are present in the system"
      });
    }

    // Costs 2 actions
    const remaining = actionsRemaining(meta, playerId);
    if (spendForPlayer && remaining < 2) {
      return send(res, 409, {
        error: `Generate Force costs 2 actions; you have ${remaining} remaining`
      });
    }
    if (spendForPlayer) {
      const s1 = spendAction(meta, playerId, `Generate Force (1/2) at ${sys.sys_name}`);
      if (!s1.ok) return send(res, 409, { error: s1.error });
      const s2 = spendAction(meta, playerId, `Generate Force (2/2) at ${sys.sys_name}`);
      if (!s2.ok) return send(res, 409, { error: s2.error });
    }

    const forceName =
      (body.force_name && String(body.force_name).trim()) ||
      `New ${allegiance} Force`;
    const newForce = {
      force_id: nextId(forces, "force_id"),
      player_id: Number(playerId),
      force_name: forceName,
      game_system: body.game_system || "HH",
      force_type: body.force_type || "Legion",
      allegiance,
      legion: body.legion || "",
      warlord_name: body.warlord_name || "",
      points: body.points != null ? Number(body.points) : 3000,
      home_sys_id: sysId,
      sys_id: sysId,
      dest_sys_id: null,
      strength: 3,
      status: "active",
      notes: body.notes || "Raised this turn",
      fought_this_turn: false
    };
    forces.push(newForce);
    writeCollection("forces", forces);
    writeCollection("meta", meta);
    runAutoAdvanceSafe();
    return send(res, 201, {
      ok: true,
      action: "generate",
      force: newForce,
      actions_remaining: actionsRemaining(meta, playerId),
      message: `Raised ${newForce.force_name} (strength 3) at ${sys.sys_name}`
    });
  }

  return send(res, 404, {
    error: "Unknown action. Use status|move|hold|reinforce|fortify|generate"
  });
}

function publicMeta(meta) {
  const hidden = new Set(["player_actions", "admin_pin", "next_player_id"]);
  const safe = {};
  Object.keys(meta || {}).forEach((key) => {
    if (hidden.has(key)) return;
    if (/password|secret|token|pin|hash/i.test(key)) return;
    safe[key] = meta[key];
  });
  return safe;
}

function publicAccount(account) {
  return {
    account_id: account.account_id,
    role: account.role,
    label: account.label,
    login: account.login || null,
    player_id: account.player_id,
    provider: account.provider || "local",
    created_at: account.created_at || null
  };
}

function baselineSystemsPath() {
  return path.join(ROOT, "data", "baseline", "systems.json");
}

function loadBaselineSystems() {
  const fp = baselineSystemsPath();
  if (!fs.existsSync(fp)) return null;
  const data = JSON.parse(fs.readFileSync(fp, "utf8"));
  if (!Array.isArray(data)) return null;
  return data;
}

function systemsControlledBy(systems, allegiance) {
  return systems
    .filter((s) => normalizeController(s) === allegiance)
    .sort((a, b) => Number(a.sys_id) - Number(b.sys_id));
}

function defaultHomeSystem(player, systems, allegianceIndex) {
  const ids = new Set(systems.map((s) => Number(s.sys_id)));
  const chosen = Number(player.start_sys_id);
  if (chosen && ids.has(chosen)) return chosen;
  let homes = systemsControlledBy(systems, player.allegiance);
  if (!homes.length) {
    homes = systems
      .filter((s) => {
        const controller = normalizeController(s);
        return controller === "Contested" || controller === "Neutral";
      })
      .sort((a, b) => Number(a.sys_id) - Number(b.sys_id));
  }
  if (homes.length) return Number(homes[allegianceIndex % homes.length].sys_id);
  return systems[0] ? Number(systems[0].sys_id) : 1;
}

function buildStartingForces(players, existingForces, systems) {
  const out = [];
  let next = 1;
  const allegianceCount = {};
  players.forEach((player) => {
    const owned = existingForces.filter((f) => Number(f.player_id) === Number(player.player_id));
    const alleg = sideOf(player) || "";
    const index = allegianceCount[alleg || "unassigned"] || 0;
    allegianceCount[alleg || "unassigned"] = index + 1;
    const home = defaultHomeSystem(player, systems, index);
    for (let n = 0; n < 2; n++) {
      const prev = owned[n];
      const fallback =
        (player.display_name || player.player_name || "Force") + (n === 0 ? " I" : " II");
      out.push({
        force_id: next++,
        player_id: player.player_id,
        force_name: (prev && prev.force_name) || fallback,
        game_system: (prev && prev.game_system) || "HH",
        force_type: (prev && prev.force_type) || "Legion",
        allegiance: alleg || (prev && isBlackshieldMark(prev.allegiance) ? "Blackshield" : ""),
        legion: (prev && prev.legion) || "",
        subfaction: (prev && prev.subfaction) || "",
        allies: (prev && prev.allies) || "",
        organisation: (prev && prev.organisation) || "",
        warlord_name: (prev && prev.warlord_name) || "",
        primarch_present: false,
        titan_support: false,
        points: prev && prev.points != null ? prev.points : 3000,
        home_sys_id: home,
        sys_id: home,
        dest_sys_id: null,
        strength: 3,
        status: "active",
        notes: n === 0 && prev && prev.notes ? prev.notes : "Starting force",
        fought_this_turn: false
      });
    }
  });
  return out;
}

function withStartingControl(system, baselineById) {
  const base = baselineById.get(Number(system.sys_id));
  if (base) {
    return {
      ...system,
      sys_loyal: Number(base.sys_loyal || 0),
      sys_traitor: Number(base.sys_traitor || 0),
      sys_neut: Number(base.sys_neut || 0),
      sys_controller: base.sys_controller
    };
  }
  return {
    ...system,
    sys_loyal: 0,
    sys_traitor: 0,
    sys_neut: 0,
    sys_controller: "Contested"
  };
}

function resetCampaign(options = {}) {
  const keepMap = !!options.keep_map;
  const keepControl = !!options.keep_control;
  if (keepControl && !keepMap) {
    throw httpError(400, "Keep current system control requires Keep current map.");
  }
  const previous = readCollection("meta") || {};
  const players = readCollection("players");
  const existingForces = readCollection("forces");
  let systems = readCollection("systems");
  const baseline = loadBaselineSystems();
  let systemsRestored = false;
  let controlReset = false;
  if (!keepMap) {
    if (baseline) {
      systems = baseline;
      systemsRestored = true;
      writeCollection("systems", systems);
    }
  } else if (!keepControl) {
    const byId = new Map((baseline || []).map((s) => [Number(s.sys_id), s]));
    systems = recomputeControllers(systems.map((s) => withStartingControl(s, byId)));
    controlReset = true;
    writeCollection("systems", systems);
  }
  const forces = buildStartingForces(players, existingForces, systems);
  const games = readCollection("games");
  const nextPlayerId = Math.max(Number(previous.next_player_id) || 1, highestPlayerId() + 1);
  const now = new Date().toISOString();
  let mapNote = "Baseline map restored";
  if (keepMap && keepControl) mapNote = "Current map and system control kept";
  else if (keepMap) mapNote = "Current map kept; system control reset to starting values";
  else if (!systemsRestored) mapNote = "Baseline map was missing, so the current map was left in place";
  const meta = {
    campaign_name: previous.campaign_name || "Sunset Heresy",
    subsector: previous.subsector || "",
    turn: 1,
    phase: "Logistics",
    loyal_score: 0,
    traitor_score: 0,
    last_advanced_at: now,
    phase_ends_at: null,
    auto_advance_when_done: true,
    auto_advance_blocked: null,
    player_actions: {},
    phase_log: [
      {
        at: now,
        from: { turn: previous.turn || null, phase: previous.phase || null },
        to: { turn: 1, phase: "Logistics" },
        notes: ["Campaign reset to turn 1, Logistics, with two starting forces per player. " + mapNote]
      }
    ],
    victor: null,
    victory_reason: null,
    next_player_id: nextPlayerId
  };
  writeCollection("meta", meta);
  writeCollection("forces", forces);
  writeCollection("games", []);
  writeCollection("notifications", []);

  let accountsRemoved = 0;
  const accounts = readCollection("accounts");
  if (options.purge_accounts) {
    const kept = accounts.filter((a) => a.role === "campaign_admin");
    accountsRemoved = accounts.length - kept.length;
    writeCollection("accounts", kept);
    clearAllSessions();
  }

  return {
    ok: true,
    turn: 1,
    phase: "Logistics",
    players: players.length,
    forces: forces.length,
    games_cleared: games.length,
    systems_restored: systemsRestored,
    map_kept: keepMap,
    control_kept: keepMap && keepControl,
    control_reset_to_start: controlReset,
    systems_kept: keepMap || !systemsRestored,
    accounts_kept: options.purge_accounts
      ? accounts.length - accountsRemoved
      : accounts.length,
    accounts_removed: accountsRemoved
  };
}

function feedbackWebhookUrl() {
  const url = String(process.env.DISCORD_FEEDBACK_WEBHOOK || "").trim();
  if (!url) return "";
  if (!/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/[^\s]+$/.test(url)) {
    console.warn("DISCORD_FEEDBACK_WEBHOOK is set but is not a Discord webhook URL. Feedback will be stored only.");
    return "";
  }
  return url;
}

async function notifyFeedbackWebhook(entry) {
  const url = feedbackWebhookUrl();
  if (!url) return false;
  const who = entry.label || entry.login || "player";
  const where = entry.page ? "\nPage: " + entry.page : "";
  const content = ("**Sunset Heresy feedback** from " + who + where + "\n" + entry.message).slice(0, 1900);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content })
    });
    if (!res.ok) {
      console.error("Discord feedback webhook returned " + res.status);
      return false;
    }
    return true;
  } catch (err) {
    console.error("Discord feedback webhook failed: " + (err && err.message ? err.message : "error"));
    return false;
  }
}

async function handleFeedback(req, res, method) {
  if (method === "GET") {
    const auth = getSession(req);
    const gate = requireRole(auth, ["campaign_admin"]);
    if (!gate.ok) return send(res, gate.status, { error: gate.error });
    const list = readCollection("feedback")
      .slice()
      .sort((a, b) => Number(b.feedback_id) - Number(a.feedback_id));
    return send(res, 200, { feedback: list });
  }
  if (method === "POST") {
    const limited = rateLimitAuth(req, "feedback");
    if (limited) return sendRateLimited(res, limited);
    const auth = getSession(req);
    const gate = requireRole(auth, ["player", "campaign_admin"]);
    if (!gate.ok) return send(res, gate.status, { error: gate.error });
    const body = (await readBody(req)) || {};
    const message = clipText(body.message, 2000);
    if (!message) return send(res, 400, { error: "Message is required" });
    const page = clipText(body.page, 200);
    const list = readCollection("feedback");
    const entry = {
      feedback_id: nextId(list, "feedback_id"),
      message,
      page: page || null,
      account_id: auth.account.account_id,
      player_id: auth.account.player_id || null,
      login: auth.account.login || null,
      label: auth.account.label || null,
      role: auth.account.role,
      created_at: new Date().toISOString(),
      webhook_delivered: false
    };
    entry.webhook_delivered = await notifyFeedbackWebhook(entry);
    list.push(entry);
    writeCollection("feedback", list);
    return send(res, 201, { ok: true, feedback: entry });
  }
  return send(res, 405, { error: "Method not allowed" });
}

function backupPayload() {
  const accounts = readCollection("accounts").map(publicAccount);
  return {
    exported_at: new Date().toISOString(),
    note: "Password hashes and sessions are omitted. Invite codes are included so a restore can keep player sign-up working. Treat this file as secret.",
    players: readCollection("players"),
    forces: readCollection("forces"),
    systems: readCollection("systems"),
    games: readCollection("games"),
    meta: readCollection("meta"),
    accounts,
    invites: readCollection("invites"),
    notifications: readCollection("notifications"),
    feedback: readCollection("feedback")
  };
}

function handleBackup(req, res) {
  const auth = getSession(req);
  const gate = requireRole(auth, ["campaign_admin"]);
  if (!gate.ok) return send(res, gate.status, { error: gate.error });
  const day = new Date().toISOString().slice(0, 10);
  return send(res, 200, backupPayload(), {
    "Content-Disposition": 'attachment; filename="sunset-heresy-backup-' + day + '.json"'
  });
}

async function handlePublic(req, res, parts, method) {
  if (method !== "GET") return send(res, 405, { error: "Method not allowed" });
  const collection = parts[1];

  if (collection === "meta") {
    return send(res, 200, publicMeta(readCollection("meta")));
  }
  if (collection === "players") {
    return send(res, 200, readCollection("players").map(publicPlayer));
  }
  if (collection === "forces") {
    const players = readCollection("players");
    const byId = Object.fromEntries(players.map((p) => [p.player_id, p]));
    return send(res, 200, readCollection("forces").map((f) => publicForce(f, byId)));
  }
  if (collection === "systems") {
    return send(res, 200, readCollection("systems"));
  }
  if (collection === "games") {
    // Games are public narrative; IDs only — names resolved client-side from public players
    return send(res, 200, readCollection("games"));
  }
  return send(res, 404, { error: "Unknown public collection" });
}

async function handleApi(req, res, pathname) {
  const parts = pathname.replace(/^\/api\//, "").split("/").filter(Boolean);
  const method = req.method;

  if (method === "OPTIONS") return send(res, 204, "");

  const csrf = assertCsrf(req);
  if (csrf) return send(res, 403, { error: csrf });

  // Auth routes
  if (parts[0] === "auth") return handleAuth(req, res, parts, method);

  // Campaign turn / phase control
  if (parts[0] === "campaign") return handleCampaign(req, res, parts, method);

  // Player campaign actions (move / reinforce / fortify / generate)
  if (parts[0] === "actions") return handleActions(req, res, parts, method);

  if (parts[0] === "games" && method === "POST" && parts[2] === "confirm") {
    return confirmBattle(req, res, parts[1]);
  }
  if (parts[0] === "games" && method === "POST" && parts[2] === "dispute") {
    return disputeBattle(req, res, parts[1]);
  }
  if (parts[0] === "games" && method === "POST" && parts[2] === "void") {
    return voidBattle(req, res, parts[1]);
  }
  if (parts[0] === "games" && method === "POST" && parts[2] === "reject") {
    return rejectNoShow(req, res, parts[1]);
  }
  if (parts[0] === "inbox") return handleInbox(req, res, parts, method);

  if (parts[0] === "feedback") return handleFeedback(req, res, method);

  if (parts[0] === "admin" && parts[1] === "backup" && method === "GET") {
    return handleBackup(req, res);
  }

  // Public sanitized routes
  if (parts[0] === "public") return handlePublic(req, res, parts, method);

  const collection = parts[0];
  const idPart = parts[1];

  if (!COLLECTIONS[collection] || collection === "accounts" || collection === "sessions" || collection === "invites" || collection === "notifications" || collection === "feedback") {
    return send(res, 404, { error: "Unknown collection" });
  }

  const spec = COLLECTIONS[collection];
  const auth = getSession(req);
  const role = auth ? auth.account.role : "visitor";

  // ----- GET -----
  if (method === "GET") {
    // Visitors must use /api/public/* for players/forces
    if (role === "visitor" && (collection === "players" || collection === "forces")) {
      return send(res, 401, { error: "Login required for full records. Use /api/public/" + collection });
    }
    // Players may only see full player records for self unless campaign_admin
    if (collection === "players" && role === "player") {
      const data = readCollection("players");
      if (idPart != null) {
        const row = data.find((r) => String(r[spec.idKey]) === String(idPart));
        if (!row) return send(res, 404, { error: "Not found" });
        if (row.player_id !== auth.account.player_id) {
          return send(res, 200, publicPlayer(row));
        }
        return send(res, 200, row);
      }
      return send(
        res,
        200,
        data.map((p) => (p.player_id === auth.account.player_id ? p : publicPlayer(p)))
      );
    }
    if (role === "campaign_admin" || collection === "systems" || collection === "games" || collection === "meta") {
      const data = readCollection(collection);
      if (collection === "meta") {
        return send(res, 200, role === "campaign_admin" ? data : publicMeta(data));
      }
      if (idPart != null) {
        const row = data.find((r) => String(r[spec.idKey]) === String(idPart));
        if (!row) return send(res, 404, { error: "Not found" });
        return send(res, 200, row);
      }
      return send(res, 200, data);
    }
    // player reading forces — full list ok (no PII on forces beyond player_id)
    if (collection === "forces") {
      const data = readCollection(collection);
      if (idPart != null) {
        const row = data.find((r) => String(r[spec.idKey]) === String(idPart));
        if (!row) return send(res, 404, { error: "Not found" });
        return send(res, 200, row);
      }
      return send(res, 200, data);
    }
    return send(res, 403, { error: "Forbidden" });
  }

  // ----- Writes -----
  const isAdmin = role === "campaign_admin";
  const isPlayer = role === "player";

  if (method === "PUT" && collection === "meta") {
    if (!isAdmin) return send(res, 403, { error: "Campaign admin only" });
    const body = (await readBody(req)) || {};
    const prev = readCollection("meta") || {};
    if (body.player_actions === undefined) body.player_actions = prev.player_actions || {};
    writeCollection("meta", body);
    return send(res, 200, body);
  }

  if (method === "PUT" && !idPart && collection !== "meta") {
    if (!isAdmin) return send(res, 403, { error: "Campaign admin only (bulk replace)" });
    const body = await readBody(req);
    if (!Array.isArray(body)) return send(res, 400, { error: "Expected JSON array" });
    if (collection === "games") return replaceBattles(res, body);
    writeCollection(collection, body);
    if (collection === "players" || collection === "forces") migrateBlackshieldAllegiance();
    return send(res, 200, readCollection(collection));
  }

  if (method === "POST" && collection !== "meta") {
    let body = await readBody(req);
    if (!body || typeof body !== "object") return send(res, 400, { error: "Expected object" });

    if (collection === "players" || collection === "systems") {
      if (!isAdmin) return send(res, 403, { error: "Campaign admin only" });
    } else if (collection === "forces") {
      // New forces for players must use POST /api/actions/generate (action cost + rules)
      if (!isAdmin) return send(res, 403, { error: "Use Generate Force action to raise new forces" });
    } else if (collection === "games") {
      if (!isAdmin && !isPlayer) return send(res, 403, { error: "Login required" });
      return createBattle(res, auth, body);
    } else {
      return send(res, 403, { error: "Forbidden" });
    }

    const list = readCollection(collection);
    if (collection === "players") {
      const side = requirePlayerSide(body.allegiance);
      if (!side.ok) return send(res, 400, { error: side.error });
      body.allegiance = side.allegiance;
      body.player_id = allocatePlayerId();
    } else if (collection === "forces") {
      if (body[spec.idKey] == null) body[spec.idKey] = nextId(list, spec.idKey);
      const assigned = forceWithOwnerSide(body);
      if (!assigned.ok) return send(res, 400, { error: assigned.error });
      body = assigned.force;
    } else if (body[spec.idKey] == null) body[spec.idKey] = nextId(list, spec.idKey);
    if (list.some((r) => r[spec.idKey] === body[spec.idKey])) {
      return send(res, 409, { error: "ID already exists" });
    }
    list.push(body);
    writeCollection(collection, list);
    return send(res, 201, body);
  }

  if (method === "PUT" && idPart != null && collection !== "meta") {
    const body = await readBody(req);
    if (!body || typeof body !== "object") return send(res, 400, { error: "Expected object" });
    const list = readCollection(collection);
    const idx = list.findIndex((r) => String(r[spec.idKey]) === String(idPart));
    if (idx < 0) return send(res, 404, { error: "Not found" });
    const existing = list[idx];

    if (collection === "players") {
      if (isAdmin) {
        const next = { ...existing, ...body, player_id: existing.player_id };
        if (body.allegiance !== undefined) {
          const side = requirePlayerSide(body.allegiance);
          if (!side.ok) return send(res, 400, { error: side.error });
          next.allegiance = side.allegiance;
        }
        list[idx] = next;
        writeCollection(collection, list);
        const side = sideOf(next);
        if (side) alignOwnerForces(next.player_id, side);
        return send(res, 200, list[idx]);
      } else if (isPlayer && existing.player_id === auth.account.player_id) {
        const safe = { ...existing };
        if (body.display_name !== undefined) {
          const name = clipText(body.display_name, 80);
          if (!name) return send(res, 400, { error: "Display name is required" });
          safe.display_name = name;
        }
        if (body.contact !== undefined) {
          const contact = clipText(body.contact, 120);
          safe.contact = contact || null;
        }
        if (body.notes !== undefined) {
          const notes = clipText(body.notes, 500);
          safe.notes = notes || null;
        }
        list[idx] = safe;
        writeCollection(collection, list);
        if (body.display_name !== undefined) {
          const accounts = readCollection("accounts");
          const acc = accounts.find((a) => a.account_id === auth.account.account_id);
          if (acc) {
            acc.label = safe.display_name;
            writeCollection("accounts", accounts);
          }
        }
        return send(res, 200, list[idx]);
      } else {
        return send(res, 403, { error: "Cannot edit this player" });
      }
    } else if (collection === "forces") {
      if (isAdmin) {
        const merged = { ...existing, ...body, force_id: existing.force_id };
        const assigned = forceWithOwnerSide(merged);
        if (!assigned.ok) return send(res, 400, { error: assigned.error });
        list[idx] = assigned.force;
        writeCollection(collection, list);
        return send(res, 200, list[idx]);
      } else if (isPlayer && existing.player_id === auth.account.player_id) {
        // Flavour / list fields only — campaign position & strength go through /api/actions
        const allowed = [
          "force_name", "notes", "warlord_name", "points", "game_system",
          "force_type", "legion", "subfaction", "organisation", "allies"
        ];
        const safe = { ...existing };
        allowed.forEach((k) => {
          if (body[k] !== undefined) safe[k] = body[k];
        });
        safe.player_id = existing.player_id;
        const assigned = forceWithOwnerSide(safe);
        if (!assigned.ok) return send(res, 400, { error: assigned.error });
        list[idx] = assigned.force;
        writeCollection(collection, list);
        return send(res, 200, list[idx]);
      } else {
        return send(res, 403, { error: "Cannot edit this force" });
      }
    } else if (collection === "systems") {
      if (!isAdmin) return send(res, 403, { error: "Forbidden" });
    } else if (collection === "games") {
      if (!isAdmin && !isPlayer) return send(res, 403, { error: "Forbidden" });
      return updateBattle(res, auth, existing, list, idx, body);
    } else {
      return send(res, 403, { error: "Forbidden" });
    }

    body[spec.idKey] = existing[spec.idKey];
    list[idx] = { ...existing, ...body };
    writeCollection(collection, list);
    return send(res, 200, list[idx]);
  }

  if (method === "DELETE" && idPart != null && collection !== "meta") {
    const list = readCollection(collection);
    const existing = list.find((r) => String(r[spec.idKey]) === String(idPart));
    if (!existing) return send(res, 404, { error: "Not found" });
    if (!isAdmin) {
      if (collection !== "games" || !isPlayer) return send(res, 403, { error: "Campaign admin only" });
      if (!isParticipant(existing, auth.account.player_id)) {
        return send(res, 403, { error: "You can only delete a battle you are taking part in" });
      }
      if (existing.result_state === "applied") {
        return send(res, 403, { error: "A confirmed battle can only be deleted by the campaign admin" });
      }
    }
    if (collection === "games" && existing.resolution) {
      const state = battleState();
      reverseResolution(existing, state, list);
      saveBattleState(state);
    }
    if (collection === "players") retireRemovedPlayer(existing.player_id);
    const next = list.filter((r) => String(r[spec.idKey]) !== String(idPart));
    writeCollection(collection, next);
    return send(res, 200, { ok: true, deleted: idPart });
  }

  return send(res, 405, { error: "Method not allowed" });
}

function logRequest(req, res, pathname, started) {
  res.on("finish", () => {
    const ms = Date.now() - started;
    console.log(
      new Date().toISOString() +
        " " +
        req.method +
        " " +
        pathname +
        " " +
        res.statusCode +
        " " +
        ms +
        "ms"
    );
  });
}

ensureDataDir();
seedBaselineSystems();
migrateBlackshieldAllegiance();

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let pathname = "/";
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    pathname = decodeURIComponent(url.pathname);
    logRequest(req, res, pathname, started);
    if (pathname === "/health" || pathname === "/api/health") {
      send(res, 200, { ok: true, service: "sunset-heresy" });
      return;
    }
    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, pathname);
      return;
    }
    serveStatic(req, res, pathname);
  } catch (err) {
    const status = Number(err && err.status) || 500;
    if (status >= 500) console.error(err);
    if (res.headersSent) return;
    try {
      send(res, status, { error: status >= 500 ? "Server error" : err.message || "Request failed" });
    } catch (_) {
      res.writeHead(500);
      res.end("Server error");
    }
  }
});

function startServer() {
  bootstrapAdmin();
  // Catch a deadline that passed while this process was down, then keep checking.
  // reset-campaign does not start this timer, so a CLI reset cannot advance first.
  runAutoAdvanceSafe();
  setInterval(runAutoAdvanceSafe, AUTO_ADVANCE_INTERVAL_MS);
  server.listen(PORT, HOST, () => {
    console.log(`Sunset Heresy server http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
    console.log(`Data directory: ${DATA}`);
    console.log(`Roles: visitor (public) · player · campaign_admin`);
    console.log(`Login: POST /api/auth/login  ·  Signup: POST /api/auth/signup  ·  Me: GET /api/auth/me`);
    console.log(`Public data: /api/public/{players|forces|systems|games|meta}`);
    console.log(`Health: /health`);
    if (feedbackWebhookUrl()) console.log("Discord feedback webhook: enabled");
    else console.log("Discord feedback webhook: off (set DISCORD_FEEDBACK_WEBHOOK to enable)");
  });
}

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === "reset-campaign") {
    if (process.argv.includes("--keep-systems")) {
      console.error("--keep-systems has been replaced. Use --keep-map, and add --keep-control to also keep loyal/traitor control.");
      process.exit(1);
    }
    const keepMap = process.argv.includes("--keep-map");
    const keepControl = process.argv.includes("--keep-control");
    if (keepControl && !keepMap) {
      console.error("--keep-control requires --keep-map. System control is restored with the baseline map unless you keep the current map.");
      process.exit(1);
    }
    try {
      const result = resetCampaign({
        keep_map: keepMap,
        keep_control: keepControl,
        purge_accounts: process.argv.includes("--purge-accounts")
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(err.message || "Reset failed");
      process.exit(1);
    }
  } else if (!cmd) {
    startServer();
  } else {
    console.error("Unknown command. Use: node server.js   or   node server.js reset-campaign [--keep-map] [--keep-control] [--purge-accounts]");
    process.exit(1);
  }
}
