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
 *   GET  /api/auth/invites        (campaign_admin) list tester invite codes
 *   POST /api/auth/invites        (campaign_admin) { note?, expires_in_days?, max_uses? }
 *   POST /api/auth/invites/revoke (campaign_admin) { invite_id }
 *   POST /api/auth/signup         { invite_code, login, password, player_name, display_name, ... }
 *   Login and signup are rate-limited per IP (see AUTH_MAX_ATTEMPTS).
 *
 * Public reads:
 *   GET /api/public/players|forces|systems|games|meta
 *
 * Protected writes use session cookie or Authorization: Bearer <token>
 *
 * Env:
 *   PORT, HOST
 *   CAMPAIGN_ADMIN_LOGIN (default admin)
 *   CAMPAIGN_ADMIN_PASSWORD (default change-me — set this in production)
 *   CAMPAIGN_ADMIN_FORCE_PASSWORD=1  (with PASSWORD set: re-hash admin on boot)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = Number(process.env.PORT) || 3847;
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const DATA = path.join(ROOT, "data");
const SESSION_DAYS = 14;

const COLLECTIONS = {
  players: { file: "players.json", idKey: "player_id" },
  forces: { file: "forces.json", idKey: "force_id" },
  systems: { file: "systems.json", idKey: "sys_id" },
  games: { file: "games.json", idKey: "game_id" },
  meta: { file: "meta.json", idKey: null },
  accounts: { file: "accounts.json", idKey: "account_id" },
  sessions: { file: "sessions.json", idKey: "token" },
  invites: { file: "invites.json", idKey: "invite_id" }
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8"
};

// Pages that require login (client still loads; API enforces). Listed for docs.
const ADMIN_PAGES = ["player_admin.html"];

function ensureDataDir() {
  if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
}

function readCollection(name) {
  const spec = COLLECTIONS[name];
  if (!spec) return null;
  const fp = path.join(DATA, spec.file);
  if (!fs.existsSync(fp)) {
    const empty = name === "meta" ? {} : [];
    fs.writeFileSync(fp, JSON.stringify(empty, null, 2));
    return empty;
  }
  return JSON.parse(fs.readFileSync(fp, "utf8"));
}

function writeCollection(name, data) {
  const spec = COLLECTIONS[name];
  if (!spec) throw new Error("Unknown collection");
  const fp = path.join(DATA, spec.file);
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
}

function nextId(list, idKey) {
  if (!list.length) return 1;
  return list.reduce((m, row) => Math.max(m, Number(row[idKey]) || 0), 0) + 1;
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
const ALLEGIANCES = ["Loyalist", "Traitor", "Blackshield"];
const INVITE_MAX_USES_CAP = 25;

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
const AUTH_MAX_ATTEMPTS = { login: 30, signup: 15 };
const authBuckets = new Map();

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.trim()) {
    const parts = fwd.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
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

/** Ensure campaign admin account exists with env/default password.
 *  Create when missing. Optional ops reset: set CAMPAIGN_ADMIN_PASSWORD and
 *  CAMPAIGN_ADMIN_FORCE_PASSWORD=1, then restart — that re-hashes the admin
 *  account without wiping other data. Remove FORCE after the reset so a later
 *  password change in the UI is not overwritten on the next deploy.
 */
function bootstrapAdmin() {
  const accounts = readCollection("accounts");
  let admin = accounts.find((a) => a.role === "campaign_admin");
  const login = process.env.CAMPAIGN_ADMIN_LOGIN || "admin";
  const envPassword = process.env.CAMPAIGN_ADMIN_PASSWORD;
  const password = envPassword || "change-me";
  const forceFlag = String(process.env.CAMPAIGN_ADMIN_FORCE_PASSWORD || "").toLowerCase();
  const forceFromEnv =
    !!envPassword &&
    (forceFlag === "1" || forceFlag === "true" || forceFlag === "yes");

  if (!admin) {
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
    console.log(`Created campaign admin login="${login}" (set CAMPAIGN_ADMIN_PASSWORD in production)`);
    return;
  }

  admin.login = admin.login || login;
  if (process.env.CAMPAIGN_ADMIN_LOGIN) admin.login = login;

  if (!admin.pass_hash || forceFromEnv) {
    const { salt, hash } = hashPassword(password);
    admin.pass_hash = hash;
    admin.pass_salt = salt;
    writeCollection("accounts", accounts);
    if (forceFromEnv) {
      console.log(`Applied CAMPAIGN_ADMIN_PASSWORD for login="${admin.login}" (FORCE env reset)`);
    } else {
      console.log(`Set campaign admin password for login="${admin.login}"`);
    }
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

function mePayload(account) {
  const base = {
    account_id: account.account_id,
    role: account.role,
    label: account.label,
    player_id: account.player_id,
    provider: account.provider || "local"
  };
  if (account.player_id) {
    const players = readCollection("players");
    const p = players.find((x) => x.player_id === account.player_id);
    if (p) base.player = p; // full profile for self
  }
  return base;
}

function send(res, status, body, extraHeaders = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": reqOrigin(res) || "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true",
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(payload);
}

// stash origin for CORS on credentialed requests
let _lastOrigin = "*";
function reqOrigin(res) {
  return _lastOrigin;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === "/" ? "/index.html" : pathname;
  rel = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const fp = path.join(ROOT, rel);
  if (!fp.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const ext = path.extname(fp).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=3600" });
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
  // Tester onboarding uses POST /api/auth/invites + POST /api/auth/signup instead.
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
    const playerName = String(body.player_name == null ? "" : body.player_name).trim();
    if (!playerName) return send(res, 400, { error: "Player name is required" });
    if (playerName.length > 80) return send(res, 400, { error: "Player name must be at most 80 characters" });
    const displayName = String(body.display_name == null ? "" : body.display_name).trim();
    if (!displayName) return send(res, 400, { error: "Display name is required" });
    if (displayName.length > 80) return send(res, 400, { error: "Display name must be at most 80 characters" });
    const allegiance = String(body.allegiance == null ? "" : body.allegiance).trim();
    if (!ALLEGIANCES.includes(allegiance)) {
      return send(res, 400, { error: "Allegiance must be Loyalist, Traitor, or Blackshield" });
    }
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
      player_id: nextId(players, "player_id"),
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

function markForcesFought(game) {
  if (!game || !game.result || game.result === "in_progress") return;
  const ids = [game.attacker_force_id, game.defender_force_id].filter((id) => id != null);
  if (!ids.length) return;
  const forces = readCollection("forces");
  let changed = false;
  ids.forEach((id) => {
    const f = forces.find((x) => x.force_id === Number(id));
    if (f && !f.fought_this_turn) {
      f.fought_this_turn = true;
      changed = true;
    }
  });
  if (changed) writeCollection("forces", forces);
}

function checkVictory(meta, systems, forces) {
  const reasons = [];
  const turn = Number(meta.turn) || 0;
  const loyalScore = Number(meta.loyal_score) || 0;
  const traitorScore = Number(meta.traitor_score) || 0;

  if (turn >= 3) {
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

function actionsRemaining(meta, playerId) {
  const turn = Number(meta.turn) || 1;
  const entry = ensurePlayerActions(meta, playerId, turn);
  return Math.max(0, ACTIONS_PER_TURN - (Number(entry.used) || 0));
}

function spendAction(meta, playerId, note) {
  const turn = Number(meta.turn) || 1;
  const entry = ensurePlayerActions(meta, playerId, turn);
  if ((Number(entry.used) || 0) >= ACTIONS_PER_TURN) {
    return { ok: false, error: "No actions remaining this turn (2 per turn)" };
  }
  entry.used = (Number(entry.used) || 0) + 1;
  entry.log = (entry.log || []).slice(-30);
  entry.log.push({
    at: new Date().toISOString(),
    note: note || "action",
    remaining: ACTIONS_PER_TURN - entry.used
  });
  return { ok: true, entry };
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
  return forces.filter(
    (f) =>
      f.status === "active" &&
      Number(f.sys_id) === Number(sysId) &&
      f.allegiance &&
      f.allegiance !== allegiance &&
      f.allegiance !== "Blackshield"
  );
}

function controlledByAllegiance(sys, allegiance) {
  const c = normalizeController(sys);
  return c === allegiance;
}

function advanceCampaign(meta, options = {}) {
  const log = [];
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
      phase = "Battles";
      log.push("Applied pending moves; advanced to Battles phase");
    } else {
      // End of Battles → score, recover, new turn
      const gained = scoreFromSystems(systems);
      meta.loyal_score = (Number(meta.loyal_score) || 0) + gained.loyal;
      meta.traitor_score = (Number(meta.traitor_score) || 0) + gained.traitor;
      log.push(`Turn ${turn} scoring: Loyalist +${gained.loyal}, Traitor +${gained.traitor}`);

      forces = applyForceRecovery(forces, systems);
      log.push("Applied end-of-turn force recovery");

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
  meta.phase_log = (meta.phase_log || []).slice(-20).concat([
    {
      at: meta.last_advanced_at,
      from: { turn: fromTurn, phase: fromPhase },
      to: { turn, phase },
      notes: log
    }
  ]);

  const victory = checkVictory(meta, systems, forces);
  if (victory) {
    meta.victor = victory.winner;
    meta.victory_reason = victory.reason;
    log.push(`Victory: ${victory.winner} — ${victory.reason}`);
  }

  writeCollection("systems", systems);
  writeCollection("forces", forces);
  writeCollection("meta", meta);

  return {
    ok: true,
    meta,
    log,
    from: { turn: fromTurn, phase: fromPhase },
    to: { turn, phase },
    victory
  };
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
      phases: PHASES
    });
  }

  if (action === "advance" && method === "POST") {
    const gate = requireRole(auth, ["campaign_admin"]);
    if (!gate.ok) return send(res, gate.status, { error: gate.error });
    const body = (await readBody(req)) || {};
    const meta = readCollection("meta");
    if (meta.victor && !body.force) {
      return send(res, 409, {
        error: "Campaign already has a victor. Pass { force: true } to advance anyway.",
        victor: meta.victor,
        victory_reason: meta.victory_reason
      });
    }
    const result = advanceCampaign(meta, {});
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
    meta.phase = body.phase;
    if (body.turn != null) meta.turn = Number(body.turn);
    meta.last_advanced_at = new Date().toISOString();
    writeCollection("meta", meta);
    return send(res, 200, { ok: true, from, to: { turn: meta.turn, phase: meta.phase }, meta });
  }

  return send(res, 404, { error: "Unknown campaign action. Use advance|status|set-phase" });
}

/**
 * Player campaign actions (rules-enforced).
 *   GET  /api/actions/status
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
      payload.player_id = auth.account.player_id;
      payload.actions_used = Number(entry.used) || 0;
      payload.actions_remaining = Math.max(0, ACTIONS_PER_TURN - payload.actions_used);
      payload.log = entry.log || [];
    } else if (auth && auth.account && auth.account.role === "campaign_admin") {
      payload.actions_used = 0;
      payload.actions_remaining = ACTIONS_PER_TURN;
      payload.admin = true;
      payload.player_actions = meta.player_actions || {};
    }
    return send(res, 200, payload);
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
  const allegiance = player.allegiance;
  if (!allegiance || allegiance === "Blackshield") {
    return send(res, 400, { error: "Player needs Loyalist or Traitor allegiance for campaign actions" });
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

    const spent = trySpend(`Move force ${forceId} → ${toSys.sys_name}`);
    if (!spent.ok) return send(res, 409, { error: spent.error });

    force.dest_sys_id = destId;
    writeCollection("forces", forces);
    writeCollection("meta", meta);
    return send(res, 200, {
      ok: true,
      action: "move",
      force,
      actions_remaining: actionsRemaining(meta, playerId),
      message: `Ordered ${force.force_name} to move to ${toSys.sys_name}`
    });
  }

  if (action === "hold") {
    // Free: clear pending destination
    const forceId = Number(body.force_id);
    if (!forceId) return send(res, 400, { error: "force_id required" });
    let forces = readCollection("forces");
    const force = forces.find((f) => Number(f.force_id) === forceId);
    if (!force) return send(res, 404, { error: "Force not found" });
    if (Number(force.player_id) !== Number(playerId) && auth.account.role !== "campaign_admin") {
      return send(res, 403, { error: "Not your force" });
    }
    force.dest_sys_id = null;
    writeCollection("forces", forces);
    return send(res, 200, {
      ok: true,
      action: "hold",
      force,
      actions_remaining: actionsRemaining(meta, playerId),
      message: `${force.force_name} holds position`
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

    // Must have at least one of your forces present (sensible; rules imply acting on owned presence)
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

async function handlePublic(req, res, parts, method) {
  if (method !== "GET") return send(res, 405, { error: "Method not allowed" });
  const collection = parts[1];

  if (collection === "meta") {
    const meta = readCollection("meta");
    // strip secrets if any ever stored on meta
    const { admin_pin, ...safe } = meta;
    return send(res, 200, safe);
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
  _lastOrigin = req.headers.origin || "*";

  if (method === "OPTIONS") return send(res, 204, "");

  // Auth routes
  if (parts[0] === "auth") return handleAuth(req, res, parts, method);

  // Campaign turn / phase control
  if (parts[0] === "campaign") return handleCampaign(req, res, parts, method);

  // Player campaign actions (move / reinforce / fortify / generate)
  if (parts[0] === "actions") return handleActions(req, res, parts, method);

  // Public sanitized routes
  if (parts[0] === "public") return handlePublic(req, res, parts, method);

  const collection = parts[0];
  const idPart = parts[1];

  if (!COLLECTIONS[collection] || collection === "accounts" || collection === "sessions" || collection === "invites") {
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
      if (collection === "meta") return send(res, 200, data);
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
    const body = await readBody(req);
    writeCollection("meta", body || {});
    return send(res, 200, body || {});
  }

  if (method === "PUT" && !idPart && collection !== "meta") {
    if (!isAdmin) return send(res, 403, { error: "Campaign admin only (bulk replace)" });
    const body = await readBody(req);
    if (!Array.isArray(body)) return send(res, 400, { error: "Expected JSON array" });
    writeCollection(collection, body);
    return send(res, 200, body);
  }

  if (method === "POST" && collection !== "meta") {
    const body = await readBody(req);
    if (!body || typeof body !== "object") return send(res, 400, { error: "Expected object" });

    if (collection === "players" || collection === "systems") {
      if (!isAdmin) return send(res, 403, { error: "Campaign admin only" });
    } else if (collection === "forces") {
      // New forces for players must use POST /api/actions/generate (action cost + rules)
      if (!isAdmin) return send(res, 403, { error: "Use Generate Force action to raise new forces" });
    } else if (collection === "games") {
      if (!isAdmin && !isPlayer) return send(res, 403, { error: "Login required" });
    } else {
      return send(res, 403, { error: "Forbidden" });
    }

    const list = readCollection(collection);
    if (body[spec.idKey] == null) body[spec.idKey] = nextId(list, spec.idKey);
    if (list.some((r) => r[spec.idKey] === body[spec.idKey])) {
      return send(res, 409, { error: "ID already exists" });
    }
    list.push(body);
    writeCollection(collection, list);
    if (collection === "games") markForcesFought(body);
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
        // full edit
      } else if (isPlayer && existing.player_id === auth.account.player_id) {
        // player may edit safe self fields only
        const allowed = ["display_name", "contact", "notes"];
        const safe = { ...existing };
        allowed.forEach((k) => {
          if (body[k] !== undefined) safe[k] = body[k];
        });
        list[idx] = safe;
        writeCollection(collection, list);
        return send(res, 200, list[idx]);
      } else {
        return send(res, 403, { error: "Cannot edit this player" });
      }
    } else if (collection === "forces") {
      if (isAdmin) {
        // full
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
        list[idx] = safe;
        writeCollection(collection, list);
        return send(res, 200, list[idx]);
      } else {
        return send(res, 403, { error: "Cannot edit this force" });
      }
    } else if (collection === "systems" || collection === "games") {
      if (!isAdmin && !(collection === "games" && isPlayer)) {
        return send(res, 403, { error: "Forbidden" });
      }
    } else {
      return send(res, 403, { error: "Forbidden" });
    }

    body[spec.idKey] = existing[spec.idKey];
    list[idx] = { ...existing, ...body };
    writeCollection(collection, list);
    if (collection === "games") markForcesFought(list[idx]);
    return send(res, 200, list[idx]);
  }

  if (method === "DELETE" && idPart != null && collection !== "meta") {
    if (!isAdmin) return send(res, 403, { error: "Campaign admin only" });
    const list = readCollection(collection);
    const next = list.filter((r) => String(r[spec.idKey]) !== String(idPart));
    if (next.length === list.length) return send(res, 404, { error: "Not found" });
    writeCollection(collection, next);
    return send(res, 200, { ok: true, deleted: idPart });
  }

  return send(res, 405, { error: "Method not allowed" });
}

ensureDataDir();
bootstrapAdmin();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, pathname);
      return;
    }
    serveStatic(req, res, pathname);
  } catch (err) {
    console.error(err);
    try {
      send(res, 500, { error: err.message || "Server error" });
    } catch (_) {
      res.writeHead(500);
      res.end("Server error");
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Sunset Heresy server http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  console.log(`Roles: visitor (public) · player · campaign_admin`);
  console.log(`Login: POST /api/auth/login  ·  Signup: POST /api/auth/signup  ·  Me: GET /api/auth/me`);
  console.log(`Public data: /api/public/{players|forces|systems|games|meta}`);
});
