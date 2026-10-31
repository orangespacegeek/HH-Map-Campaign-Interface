"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const ADMIN_PW = "test-admin-pw-123";
const ESCAPE_NAME = "sh-escape-c2e4.json";

function startServer(extraEnv = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-restore-"));
  const port = 34000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDir,
      CAMPAIGN_ADMIN_PASSWORD: ADMIN_PW,
      CAMPAIGN_ADMIN_FORCE_PASSWORD: "1",
      TRUST_PROXY: "",
      AUTO_ADVANCE_INTERVAL_MS: "60000",
      DISCORD_CAMPAIGN_WEBHOOK: "",
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let log = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start\n" + log)), 8000);
    const onData = (chunk) => {
      log += chunk;
      if (log.includes("Health:")) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("server exited " + code + "\n" + log));
    });
  });
  return {
    dataDir,
    base: "http://127.0.0.1:" + port,
    log() {
      return log;
    },
    ready,
    stop() {
      return new Promise((resolve) => {
        child.removeAllListeners("exit");
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
        setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 2000);
      });
    }
  };
}

function startWebhook() {
  const posts = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        body = { raw: Buffer.concat(chunks).toString("utf8") };
      }
      posts.push(body);
      res.writeHead(204);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        posts,
        url: "http://127.0.0.1:" + addr.port + "/api/webhooks/test/hook",
        stop() {
          return new Promise((done) => server.close(() => done()));
        }
      });
    });
  });
}

async function api(ctx, token, method, pathname, body, headers = {}) {
  const reqHeaders = { "Content-Type": "application/json", "X-SH-Request": "1", ...headers };
  if (token) reqHeaders.Authorization = "Bearer " + token;
  const res = await fetch(ctx.base + pathname, {
    method,
    headers: reqHeaders,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, headers: res.headers };
}

async function adminToken(ctx) {
  const login = await api(ctx, null, "POST", "/api/auth/login", { login: "admin", password: ADMIN_PW });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  return login.json.token;
}

async function signup(ctx, admin, name, notes) {
  const inv = await api(ctx, admin, "POST", "/api/auth/invites", { note: name });
  assert.equal(inv.status, 201, JSON.stringify(inv.json));
  const res = await api(ctx, null, "POST", "/api/auth/signup", {
    invite_code: inv.json.invite.code,
    login: name,
    password: "botpass-xyz",
    player_name: name,
    display_name: name,
    allegiance: "Loyalist",
    notes: notes || ""
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { token: res.json.token, player_id: res.json.player_id };
}

function comparable(backup) {
  const copy = JSON.parse(JSON.stringify(backup));
  delete copy.exported_at;
  return copy;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function preRestoreFiles(dataDir) {
  const folder = path.join(dataDir, "backups");
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).filter((name) => name.startsWith("pre-restore-") && name.endsWith(".json"));
}

function assertNoEscape(dataDir) {
  assert.equal(fs.existsSync(path.join(os.tmpdir(), ESCAPE_NAME)), false);
  assert.equal(fs.existsSync(path.join(path.dirname(dataDir), ESCAPE_NAME)), false);
  const root = fs.realpathSync(dataDir);
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      assert.equal(name.includes(".."), false);
      const full = path.join(dir, name);
      const real = fs.realpathSync(full);
      const rel = path.relative(root, real);
      assert.equal(rel.startsWith("..") || path.isAbsolute(rel), false, real);
      if (fs.statSync(real).isDirectory()) walk(real);
    }
  };
  walk(dataDir);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("download then restore round-trips, keeps the admin, and writes a pre-restore backup", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const admin = await adminToken(ctx);
    const loyal = await signup(ctx, admin, "restore_loyal", "../../" + ESCAPE_NAME);
    const original = (await api(ctx, admin, "GET", "/api/admin/backup")).json;
    assert.equal(original.format, "sunset-heresy-backup");
    assert.equal(original.version, 1);
    assert.equal(original.players.some((player) => player.notes === "../../" + ESCAPE_NAME), true);

    const extra = await signup(ctx, admin, "restore_extra");
    const moved = await api(ctx, admin, "POST", "/api/campaign/set-phase", { phase: "Movement", turn: 4 });
    assert.equal(moved.status, 200, JSON.stringify(moved.json));
    const changed = (await api(ctx, admin, "GET", "/api/admin/backup")).json;
    assert.notDeepEqual(comparable(changed), comparable(original));
    assert.equal(changed.meta.phase, "Movement");
    assert.equal(preRestoreFiles(ctx.dataDir).length, 0);

    const badConfirm = await api(ctx, admin, "POST", "/api/admin/backup/restore", {
      confirm: "RESET",
      restore_token: "not-a-preview"
    });
    assert.equal(badConfirm.status, 400);
    assert.match(badConfirm.json.error, /RESTORE/);
    assert.equal((await api(ctx, admin, "GET", "/api/meta")).json.phase, "Movement");
    assert.equal(preRestoreFiles(ctx.dataDir).length, 0);

    const preview = await api(ctx, admin, "POST", "/api/admin/backup/preview", original);
    assert.equal(preview.status, 200, JSON.stringify(preview.json));
    assert.equal(preview.json.preview.players, original.players.length);
    assert.equal(preview.json.preview.forces, original.forces.length);
    assert.equal(preview.json.preview.systems, original.systems.length);
    assert.equal(preview.json.preview.battles, original.games.length);
    assert.equal(preview.json.preview.turn, original.meta.turn == null ? null : Number(original.meta.turn));
    assert.equal(preview.json.preview.phase, original.meta.phase || null);
    assert.equal(preview.json.preview.exported_at, original.exported_at);
    assert.equal(typeof preview.json.restore_token, "string");
    assert.equal(preRestoreFiles(ctx.dataDir).length, 0);
    assert.equal((await api(ctx, admin, "GET", "/api/meta")).json.phase, "Movement");

    const rejected = await api(ctx, admin, "POST", "/api/admin/backup/restore", {
      confirm: "restore",
      restore_token: preview.json.restore_token
    });
    assert.equal(rejected.status, 400);
    assert.equal((await api(ctx, admin, "GET", "/api/meta")).json.phase, "Movement");
    assert.equal(preRestoreFiles(ctx.dataDir).length, 0);

    const restored = await api(ctx, admin, "POST", "/api/admin/backup/restore", {
      confirm: "RESTORE",
      restore_token: preview.json.restore_token
    });
    assert.equal(restored.status, 200, JSON.stringify(restored.json));
    assert.match(restored.json.pre_restore, /^pre-restore-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-[a-f0-9]+)?\.json$/);
    assert.equal(restored.json.preview.players, original.players.length);
    assert.equal(restored.json.preview.battles, original.games.length);

    const again = (await api(ctx, admin, "GET", "/api/admin/backup")).json;
    assert.deepEqual(comparable(again), comparable(original));
    const me = await api(ctx, admin, "GET", "/api/auth/me");
    assert.equal(me.status, 200);
    assert.equal(me.json.authenticated, true);
    assert.equal(me.json.role, "campaign_admin");
    const relog = await api(ctx, null, "POST", "/api/auth/login", { login: "admin", password: ADMIN_PW });
    assert.equal(relog.status, 200);
    const playerBack = await api(ctx, null, "POST", "/api/auth/login", { login: "restore_loyal", password: "botpass-xyz" });
    assert.equal(playerBack.status, 200, JSON.stringify(playerBack.json));
    const dropped = await api(ctx, null, "POST", "/api/auth/login", { login: "restore_extra", password: "botpass-xyz" });
    assert.equal(dropped.status, 401);
    assert.equal((await api(ctx, extra.token, "GET", "/api/auth/me")).json.authenticated, false);
    assert.equal((await api(ctx, loyal.token, "GET", "/api/auth/me")).json.authenticated, true);

    const accounts = readJson(path.join(ctx.dataDir, "accounts.json"));
    const adminAccount = accounts.find((account) => account.role === "campaign_admin");
    assert.equal(typeof adminAccount.pass_hash, "string");
    assert.ok(adminAccount.pass_hash.length > 10);
    const loyalAccount = accounts.find((account) => account.login === "restore_loyal");
    assert.equal(typeof loyalAccount.pass_hash, "string");
    const players = readJson(path.join(ctx.dataDir, "players.json"));
    assert.equal(players.find((player) => player.player_id === loyal.player_id).notes, "../../" + ESCAPE_NAME);

    const copies = preRestoreFiles(ctx.dataDir);
    assert.equal(copies.length, 1);
    assert.equal(copies[0], restored.json.pre_restore);
    const safety = readJson(path.join(ctx.dataDir, "backups", copies[0]));
    assert.equal(typeof safety.taken_at, "string");
    assert.match(safety.reason, /Before restoring a campaign backup/);
    assert.equal(safety.meta.phase, "Movement");
    assert.equal(safety.meta.turn, 4);
    assert.equal(safety.players.some((player) => player.player_name === "restore_extra"), true);
    assert.equal(typeof safety.accounts.find((account) => account.role === "campaign_admin").pass_hash, "string");
    assert.ok(Array.isArray(safety.sessions));
    const safetyPath = path.join(ctx.dataDir, "backups", copies[0]);
    const rel = path.relative(ctx.dataDir, fs.realpathSync(safetyPath));
    assert.equal(rel.startsWith("backups" + path.sep), true);
    assertNoEscape(ctx.dataDir);

    const legacy = JSON.parse(JSON.stringify(original));
    delete legacy.format;
    delete legacy.version;
    await api(ctx, admin, "POST", "/api/campaign/set-phase", { phase: "Battles", turn: 9 });
    const legacyPreview = await api(ctx, admin, "POST", "/api/admin/backup/preview", legacy);
    assert.equal(legacyPreview.status, 200, JSON.stringify(legacyPreview.json));
    const legacyRestore = await api(ctx, admin, "POST", "/api/admin/backup/restore", {
      confirm: "RESTORE",
      restore_token: legacyPreview.json.restore_token
    });
    assert.equal(legacyRestore.status, 200, JSON.stringify(legacyRestore.json));
    const afterLegacy = (await api(ctx, admin, "GET", "/api/admin/backup")).json;
    assert.deepEqual(comparable(afterLegacy), comparable(original));
  } finally {
    await ctx.stop();
  }
});

test("rejects malformed backups without writing a pre-restore file", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const admin = await adminToken(ctx);
    await signup(ctx, admin, "malformed_loyal");
    const backup = (await api(ctx, admin, "GET", "/api/admin/backup")).json;
    const before = fs.readFileSync(path.join(ctx.dataDir, "players.json"), "utf8");

    async function reject(body, pattern, status = 400) {
      const res = await api(ctx, admin, "POST", "/api/admin/backup/preview", body);
      assert.equal(res.status, status, JSON.stringify(res.json));
      assert.match(res.json.error, pattern);
      assert.equal(fs.readFileSync(path.join(ctx.dataDir, "players.json"), "utf8"), before);
      assert.equal(preRestoreFiles(ctx.dataDir).length, 0);
    }

    await reject({ hello: 1 }, /not a Sunset Heresy backup/);
    await reject([], /JSON object/);
    await reject({ ...backup, path: "../evil.json" }, /not a Sunset Heresy backup/);
    await reject({ ...backup, version: 2 }, /version is not supported/);
    await reject({ ...backup, version: "1" }, /version is not supported/);
    await reject({ ...backup, format: "other-backup" }, /not a Sunset Heresy backup/);
    await reject({ ...backup, note: "edited" }, /not a Sunset Heresy backup/);
    await reject({ ...backup, players: "nope" }, /players must be a list/);
    await reject({ ...backup, players: [null] }, /players entry must be an object/);
    await reject({ ...backup, meta: [] }, /meta must be an object/);
    await reject({ ...backup, games: [{ game_id: 1 }, ["nested"]] }, /games entry must be an object/);
    const poisoned = JSON.stringify(backup).replace('{"player_id":', '{"__proto__":{"admin":true},"player_id":');
    await reject(poisoned, /does not accept/);
    const hashed = JSON.parse(JSON.stringify(backup));
    hashed.accounts[0].pass_hash = "injected";
    await reject(hashed, /Password hashes/);
    const dup = JSON.parse(JSON.stringify(backup));
    dup.accounts.push({ ...dup.accounts[0] });
    await reject(dup, /same id/);
    await reject("{not json", /Invalid JSON/);

    const preview = await api(ctx, admin, "POST", "/api/admin/backup/preview", backup);
    assert.equal(preview.status, 200);
    const missing = await api(ctx, admin, "POST", "/api/admin/backup/restore", { confirm: "RESTORE" });
    assert.equal(missing.status, 400);
    assert.match(missing.json.error, /preview is no longer available|Upload the backup again/);
    assert.equal(fs.readFileSync(path.join(ctx.dataDir, "players.json"), "utf8"), before);
    assert.equal(preRestoreFiles(ctx.dataDir).length, 0);
  } finally {
    await ctx.stop();
  }
});

test("rejects an oversized backup upload", async () => {
  const ctx = startServer({ RESTORE_MAX_BYTES: "2048" });
  try {
    await ctx.ready;
    const admin = await adminToken(ctx);
    const body = JSON.stringify({ pad: "x".repeat(4000) });
    assert.ok(Buffer.byteLength(body) > 2048);
    const res = await api(ctx, admin, "POST", "/api/admin/backup/preview", body);
    assert.equal(res.status, 413, JSON.stringify(res.json));
    assert.match(res.json.error, /too large/);
    assert.equal(preRestoreFiles(ctx.dataDir).length, 0);
    const restore = await api(ctx, admin, "POST", "/api/admin/backup/restore", body);
    assert.equal(restore.status, 413, JSON.stringify(restore.json));
    assert.match(restore.json.error, /too large/);
  } finally {
    await ctx.stop();
  }
});

test("non-admins cannot preview or restore, and cookie writes need the CSRF header", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const admin = await adminToken(ctx);
    const player = await signup(ctx, admin, "restore_player");
    const backup = (await api(ctx, admin, "GET", "/api/admin/backup")).json;

    const anon = await api(ctx, null, "POST", "/api/admin/backup/preview", backup);
    assert.equal(anon.status, 401);
    const asPlayer = await api(ctx, player.token, "POST", "/api/admin/backup/preview", backup);
    assert.equal(asPlayer.status, 403);
    assert.match(asPlayer.json.error, /Insufficient role/);
    const asPlayerRestore = await api(ctx, player.token, "POST", "/api/admin/backup/restore", {
      confirm: "RESTORE",
      restore_token: "x"
    });
    assert.equal(asPlayerRestore.status, 403);

    const login = await fetch(ctx.base + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: "admin", password: ADMIN_PW })
    });
    assert.equal(login.status, 200);
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    assert.match(cookie, /^sh_session=/);
    const blocked = await fetch(ctx.base + "/api/admin/backup/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(backup)
    });
    const blockedBody = await blocked.json();
    assert.equal(blocked.status, 403);
    assert.match(blockedBody.error, /Write blocked/);
    assert.equal(preRestoreFiles(ctx.dataDir).length, 0);
    const players = readJson(path.join(ctx.dataDir, "players.json"));
    assert.equal(players.some((row) => row.player_name === "restore_player"), true);
  } finally {
    await ctx.stop();
  }
});

test("restoring keeps the current admin signed in when the file has no matching account", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const admin = await adminToken(ctx);
    await signup(ctx, admin, "kept_loyal");
    const backup = (await api(ctx, admin, "GET", "/api/admin/backup")).json;
    backup.accounts = backup.accounts.filter((account) => account.role !== "campaign_admin");
    const preview = await api(ctx, admin, "POST", "/api/admin/backup/preview", backup);
    assert.equal(preview.status, 200, JSON.stringify(preview.json));
    const restored = await api(ctx, admin, "POST", "/api/admin/backup/restore", {
      confirm: "RESTORE",
      restore_token: preview.json.restore_token
    });
    assert.equal(restored.status, 200, JSON.stringify(restored.json));
    const me = await api(ctx, admin, "GET", "/api/auth/me");
    assert.equal(me.json.authenticated, true);
    assert.equal(me.json.role, "campaign_admin");
    const accounts = readJson(path.join(ctx.dataDir, "accounts.json"));
    const adminAccount = accounts.find((account) => account.role === "campaign_admin");
    assert.ok(adminAccount);
    assert.equal(typeof adminAccount.pass_hash, "string");
    const relog = await api(ctx, null, "POST", "/api/auth/login", { login: "admin", password: ADMIN_PW });
    assert.equal(relog.status, 200);
  } finally {
    await ctx.stop();
  }
});

test("a restored deadline does not auto-advance or post to Discord", async () => {
  const hook = await startWebhook();
  const ctx = startServer({
    DISCORD_CAMPAIGN_WEBHOOK: hook.url,
    AUTO_ADVANCE_INTERVAL_MS: "250"
  });
  try {
    await ctx.ready;
    const admin = await adminToken(ctx);
    await signup(ctx, admin, "quiet_loyal");
    await signup(ctx, admin, "quiet_traitor");
    const backup = (await api(ctx, admin, "GET", "/api/admin/backup")).json;
    backup.meta.turn = 2;
    backup.meta.phase = "Movement";
    backup.meta.phase_ends_at = "2020-01-01T00:00:00.000Z";
    delete backup.meta.discord_deadline_reminder_key;
    const preview = await api(ctx, admin, "POST", "/api/admin/backup/preview", backup);
    assert.equal(preview.status, 200, JSON.stringify(preview.json));
    const restored = await api(ctx, admin, "POST", "/api/admin/backup/restore", {
      confirm: "RESTORE",
      restore_token: preview.json.restore_token
    });
    assert.equal(restored.status, 200, JSON.stringify(restored.json));
    await sleep(900);
    const meta = (await api(ctx, admin, "GET", "/api/meta")).json;
    assert.equal(meta.phase, "Movement");
    assert.equal(meta.turn, 2);
    assert.equal(meta.phase_ends_at, "2020-01-01T00:00:00.000Z");
    assert.equal(hook.posts.length, 0, JSON.stringify(hook.posts));

    const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    backup.meta.turn = 1;
    backup.meta.phase = "Logistics";
    backup.meta.phase_ends_at = soon;
    delete backup.meta.discord_deadline_reminder_key;
    const again = await api(ctx, admin, "POST", "/api/admin/backup/preview", backup);
    assert.equal(again.status, 200, JSON.stringify(again.json));
    const second = await api(ctx, admin, "POST", "/api/admin/backup/restore", {
      confirm: "RESTORE",
      restore_token: again.json.restore_token
    });
    assert.equal(second.status, 200, JSON.stringify(second.json));
    await sleep(900);
    const later = (await api(ctx, admin, "GET", "/api/meta")).json;
    assert.equal(later.phase, "Logistics");
    assert.equal(later.turn, 1);
    assert.equal(later.phase_ends_at, soon);
    assert.equal(hook.posts.length, 0, JSON.stringify(hook.posts));
    assert.equal(later.discord_deadline_reminder_key || null, null);
  } finally {
    await ctx.stop();
    await hook.stop();
  }
});
