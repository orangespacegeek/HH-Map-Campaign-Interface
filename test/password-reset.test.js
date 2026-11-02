"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const ADMIN_PW = "test-admin-pw-123";
const DISCORD_ID = "111111111111111111";

function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-pwreset-"));
  const port = 36000 + Math.floor(Math.random() * 20000);
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
      DISCORD_CAMPAIGN_WEBHOOK: ""
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

async function api(ctx, token, method, pathname, body) {
  const headers = { "Content-Type": "application/json", "X-SH-Request": "1" };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(ctx.base + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

async function adminToken(ctx) {
  const login = await api(ctx, null, "POST", "/api/auth/login", { login: "admin", password: ADMIN_PW });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  return login.json.token;
}

async function signup(ctx, admin, name) {
  const inv = await api(ctx, admin, "POST", "/api/auth/invites", { note: name });
  assert.equal(inv.status, 201, JSON.stringify(inv.json));
  const res = await api(ctx, null, "POST", "/api/auth/signup", {
    invite_code: inv.json.invite.code,
    login: name,
    password: "botpass-xyz",
    player_name: name,
    display_name: name,
    allegiance: "Loyalist"
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { token: res.json.token, player_id: res.json.player_id };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("a restored account with no hash cannot log in until a one-time code sets a password", async () => {
  const source = startServer();
  let fresh = null;
  try {
    await source.ready;
    const adminA = await adminToken(source);
    const loyal = await signup(source, adminA, "hashless_loyal");
    const player = (await api(source, adminA, "GET", "/api/players/" + loyal.player_id)).json;
    const saved = await api(source, adminA, "PUT", "/api/players/" + loyal.player_id, {
      ...player,
      discord_user_id: DISCORD_ID
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    const forcesBefore = (await api(source, adminA, "GET", "/api/forces")).json
      .filter((force) => Number(force.player_id) === loyal.player_id)
      .map((force) => force.force_id)
      .sort((a, b) => a - b);
    assert.ok(forcesBefore.length >= 1);
    const backup = (await api(source, adminA, "GET", "/api/admin/backup")).json;
    assert.equal(backup.accounts.some((account) => account.pass_hash), false);

    fresh = startServer();
    await fresh.ready;
    const adminB = await adminToken(fresh);
    const preview = await api(fresh, adminB, "POST", "/api/admin/backup/preview", backup);
    assert.equal(preview.status, 200, JSON.stringify(preview.json));
    assert.equal(preview.json.preview.needs_password, 1);
    const restored = await api(fresh, adminB, "POST", "/api/admin/backup/restore", {
      confirm: "RESTORE",
      restore_token: preview.json.restore_token
    });
    assert.equal(restored.status, 200, JSON.stringify(restored.json));
    assert.equal(restored.json.preview.needs_password, 1);

    const stored = readJson(path.join(fresh.dataDir, "accounts.json"));
    const row = stored.find((account) => account.login === "hashless_loyal");
    assert.equal(row.needs_password, true);
    assert.equal(row.pass_hash, undefined);
    assert.equal(row.pass_salt, undefined);

    const empty = await api(fresh, null, "POST", "/api/auth/login", { login: "hashless_loyal", password: "" });
    assert.equal(empty.status, 401);
    assert.match(empty.json.error, /Invalid login or password/);
    const missing = await api(fresh, null, "POST", "/api/auth/login", { login: "hashless_loyal" });
    assert.equal(missing.status, 401);
    const old = await api(fresh, null, "POST", "/api/auth/login", { login: "hashless_loyal", password: "botpass-xyz" });
    assert.equal(old.status, 401);
    const adminStill = await api(fresh, null, "POST", "/api/auth/login", { login: "admin", password: ADMIN_PW });
    assert.equal(adminStill.status, 200);

    const outsider = await signup(fresh, adminB, "local_player");
    const denied = await api(fresh, outsider.token, "POST", "/api/auth/password-resets", { player_id: loyal.player_id });
    assert.equal(denied.status, 403);
    const anon = await api(fresh, null, "POST", "/api/auth/password-resets", { player_id: loyal.player_id });
    assert.equal(anon.status, 401);

    const first = await api(fresh, adminB, "POST", "/api/auth/password-resets", { player_id: loyal.player_id });
    assert.equal(first.status, 201, JSON.stringify(first.json));
    const second = await api(fresh, adminB, "POST", "/api/auth/password-resets", { player_id: loyal.player_id });
    assert.equal(second.status, 201, JSON.stringify(second.json));
    const plain = second.json.code.replace(/-/g, "");
    const resetFile = path.join(fresh.dataDir, "password_resets.json");
    const resetText = fs.readFileSync(resetFile, "utf8");
    assert.equal(resetText.includes(plain), false);
    assert.equal(resetText.includes(second.json.code), false);
    const resets = JSON.parse(resetText);
    assert.equal(resets.filter((item) => item.used_at).length, 1);
    assert.ok(resets.every((item) => /^[a-f0-9]{64}$/.test(item.code_hash)));

    const reused = await api(fresh, null, "POST", "/api/auth/password-resets/redeem", {
      code: first.json.code,
      password: "fresh-pass-1"
    });
    assert.equal(reused.status, 400);
    assert.match(reused.json.error, /already been used/);

    const live = resets.find((item) => !item.used_at);
    live.expires_at = "2020-01-01T00:00:00.000Z";
    fs.writeFileSync(resetFile, JSON.stringify(resets, null, 2));
    const expired = await api(fresh, null, "POST", "/api/auth/password-resets/redeem", {
      code: second.json.code,
      password: "fresh-pass-1"
    });
    assert.equal(expired.status, 400);
    assert.match(expired.json.error, /expired/);

    const third = await api(fresh, adminB, "POST", "/api/auth/password-resets", { player_id: loyal.player_id });
    assert.equal(third.status, 201, JSON.stringify(third.json));
    assert.match(third.json.path, /^\/login\.html\?reset=/);
    const redeemed = await api(fresh, null, "POST", "/api/auth/password-resets/redeem", {
      code: third.json.code,
      password: "fresh-pass-1"
    });
    assert.equal(redeemed.status, 200, JSON.stringify(redeemed.json));
    assert.equal(redeemed.json.role, "player");
    assert.equal(redeemed.json.player_id, loyal.player_id);
    const again = await api(fresh, null, "POST", "/api/auth/password-resets/redeem", {
      code: third.json.code,
      password: "another-pass-2"
    });
    assert.equal(again.status, 400);
    assert.match(again.json.error, /already been used/);

    const loggedIn = await api(fresh, null, "POST", "/api/auth/login", {
      login: "hashless_loyal",
      password: "fresh-pass-1"
    });
    assert.equal(loggedIn.status, 200, JSON.stringify(loggedIn.json));
    const stillOld = await api(fresh, null, "POST", "/api/auth/login", {
      login: "hashless_loyal",
      password: "botpass-xyz"
    });
    assert.equal(stillOld.status, 401);
    const self = await api(fresh, loggedIn.json.token, "GET", "/api/players/" + loyal.player_id);
    assert.equal(self.json.discord_user_id, DISCORD_ID);
    const forcesAfter = (await api(fresh, loggedIn.json.token, "GET", "/api/forces")).json
      .filter((force) => Number(force.player_id) === loyal.player_id)
      .map((force) => force.force_id)
      .sort((a, b) => a - b);
    assert.deepEqual(forcesAfter, forcesBefore);
    const after = readJson(path.join(fresh.dataDir, "accounts.json")).find((account) => account.login === "hashless_loyal");
    assert.equal(after.needs_password, false);
    assert.equal(typeof after.pass_hash, "string");
    assert.ok(after.pass_hash.length > 10);
  } finally {
    await source.stop();
    if (fresh) await fresh.stop();
  }
});
