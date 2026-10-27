"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const ADMIN_PW = "test-admin-pw-123";

function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-acts-"));
  const port = 29000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDir,
      CAMPAIGN_ADMIN_PASSWORD: ADMIN_PW,
      CAMPAIGN_ADMIN_FORCE_PASSWORD: "1",
      TRUST_PROXY: ""
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

async function signup(ctx, admin, name, allegiance, start) {
  const inv = await api(ctx, admin, "POST", "/api/auth/invites", { note: name });
  assert.equal(inv.status, 201, JSON.stringify(inv.json));
  const body = {
    invite_code: inv.json.invite.code,
    login: name,
    password: "botpass-xyz",
    player_name: name,
    display_name: name,
    allegiance
  };
  if (start != null) body.start_sys_id = start;
  const res = await api(ctx, null, "POST", "/api/auth/signup", body);
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { token: res.json.token, player_id: res.json.player_id };
}

function row(roster, playerId) {
  return roster.players.find((player) => player.player_id === playerId);
}

test("admin sees who has spent this turn's action budget", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const adminLogin = await api(ctx, null, "POST", "/api/auth/login", { login: "admin", password: ADMIN_PW });
    assert.equal(adminLogin.status, 200, JSON.stringify(adminLogin.json));
    const admin = adminLogin.json.token;
    const loyal = await signup(ctx, admin, "act_loyal", "Loyalist", 2);
    const traitor = await signup(ctx, admin, "act_traitor", "Traitor", 4);
    assert.equal((await api(ctx, admin, "POST", "/api/campaign/reset", { confirm: "RESET" })).status, 200);
    assert.equal((await api(ctx, admin, "POST", "/api/campaign/begin", {})).status, 200);

    const denied = await api(ctx, loyal.token, "GET", "/api/actions/players");
    assert.equal(denied.status, 403);
    assert.equal((await api(ctx, null, "GET", "/api/actions/players")).status, 401);

    const fresh = await api(ctx, admin, "GET", "/api/actions/players");
    assert.equal(fresh.status, 200, JSON.stringify(fresh.json));
    assert.equal(fresh.json.actions_per_turn, 2);
    assert.equal(fresh.json.turn, 1);
    assert.equal(fresh.json.phase, "Logistics");
    assert.equal(fresh.json.active_players, 2);
    assert.equal(fresh.json.finished, 0);
    assert.equal(fresh.json.ready_to_advance, false);
    assert.equal(row(fresh.json, loyal.player_id).actions_remaining, 2);
    assert.equal(row(fresh.json, loyal.player_id).active_forces, 2);
    assert.equal(row(fresh.json, loyal.player_id).finished, false);
    assert.equal(row(fresh.json, traitor.player_id).actions_remaining, 2);

    const first = await api(ctx, loyal.token, "POST", "/api/actions/fortify", { sys_id: 2 });
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(first.json.actions_remaining, 1);
    const second = await api(ctx, loyal.token, "POST", "/api/actions/fortify", { sys_id: 2 });
    assert.equal(second.status, 200, JSON.stringify(second.json));
    assert.equal(second.json.actions_remaining, 0);
    const own = await api(ctx, loyal.token, "GET", "/api/actions/status");
    assert.equal(own.json.actions_remaining, 0);
    assert.equal(own.json.actions_used, 2);

    const mixed = await api(ctx, admin, "GET", "/api/actions/players");
    assert.equal(mixed.json.finished, 1);
    assert.equal(mixed.json.active_players, 2);
    assert.equal(mixed.json.ready_to_advance, false);
    assert.equal(row(mixed.json, loyal.player_id).actions_remaining, 0);
    assert.equal(row(mixed.json, loyal.player_id).finished, true);
    assert.equal(row(mixed.json, traitor.player_id).actions_remaining, 2);
    assert.equal(row(mixed.json, traitor.player_id).finished, false);

    assert.equal((await api(ctx, traitor.token, "POST", "/api/actions/fortify", { sys_id: 4 })).status, 200);
    assert.equal((await api(ctx, traitor.token, "POST", "/api/actions/fortify", { sys_id: 4 })).status, 200);
    const done = await api(ctx, admin, "GET", "/api/actions/players");
    assert.equal(done.json.finished, 2);
    assert.equal(done.json.active_players, 2);
    assert.equal(done.json.ready_to_advance, true);

    const empty = await signup(ctx, admin, "act_empty", "Loyalist", 3);
    const withEmpty = await api(ctx, admin, "GET", "/api/actions/players");
    const emptyRow = row(withEmpty.json, empty.player_id);
    assert.equal(emptyRow.active_forces, 2);
    assert.equal(emptyRow.actions_remaining, 2);
    assert.equal(emptyRow.finished, false);
    assert.equal(emptyRow.can_act, undefined);
    assert.ok(Array.isArray(withEmpty.json.needs_side));
    assert.equal(withEmpty.json.needs_side.length, 0);
    assert.equal(withEmpty.json.finished, 2);
    assert.equal(withEmpty.json.active_players, 3);
    assert.equal(withEmpty.json.ready_to_advance, false);

    assert.equal((await api(ctx, admin, "PUT", "/api/players/" + empty.player_id, { status: "inactive" })).status, 200);
    const withoutEmpty = await api(ctx, admin, "GET", "/api/actions/players");
    assert.equal(row(withoutEmpty.json, empty.player_id), undefined);
    assert.equal(withoutEmpty.json.active_players, 2);
    assert.equal(withoutEmpty.json.finished, 2);
    assert.equal(withoutEmpty.json.ready_to_advance, true);

    const meta = (await api(ctx, admin, "GET", "/api/meta")).json;
    meta.turn = 2;
    assert.equal((await api(ctx, admin, "PUT", "/api/meta", meta)).status, 200);
    const nextTurn = await api(ctx, admin, "GET", "/api/actions/players");
    assert.equal(nextTurn.json.turn, 2);
    assert.equal(row(nextTurn.json, loyal.player_id).actions_remaining, 2);
    assert.equal(row(nextTurn.json, loyal.player_id).actions_used, 0);
    assert.equal(row(nextTurn.json, traitor.player_id).actions_remaining, 2);
    assert.equal(nextTurn.json.finished, 0);
    assert.equal(nextTurn.json.ready_to_advance, false);
  } finally {
    await ctx.stop();
  }
});

test("the admin dashboard is the only place that renders the action roster", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const rosterAt = html.indexOf('id="action-roster"');
  assert.ok(rosterAt > 0);
  const roster = html.slice(rosterAt, html.indexOf("turn-actions", rosterAt));
  assert.match(roster, /data-role="campaign_admin"/);
  assert.match(roster, /All players are done\. Ready to advance the turn\./);
  assert.match(roster, /Players who still need a side are listed separately/);
  assert.doesNotMatch(roster, /Can't act/);
  assert.doesNotMatch(roster, /Blackshields cannot spend/);
  assert.match(html, /SH\.playerActions\(\)/);
  const login = fs.readFileSync(path.join(ROOT, "login.html"), "utf8");
  assert.match(login, /<option value="Loyalist">Loyalist<\/option>/);
  assert.match(login, /<option value="Traitor">Traitor<\/option>/);
  assert.doesNotMatch(login, /value="Blackshield"/);
});
