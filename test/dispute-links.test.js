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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-dispute-"));
  const port = 26000 + Math.floor(Math.random() * 20000);
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

test("a dispute carries the battle summary and a game ref", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const login = await api(ctx, null, "POST", "/api/auth/login", { login: "admin", password: ADMIN_PW });
    assert.equal(login.status, 200);
    const admin = login.json.token;
    async function signup(name, allegiance, start) {
      const inv = await api(ctx, admin, "POST", "/api/auth/invites", { note: name });
      assert.equal(inv.status, 201, JSON.stringify(inv.json));
      const res = await api(ctx, null, "POST", "/api/auth/signup", {
        invite_code: inv.json.invite.code,
        login: name,
        password: "botpass-xyz",
        player_name: name,
        display_name: name,
        allegiance,
        start_sys_id: start
      });
      assert.equal(res.status, 201, JSON.stringify(res.json));
      return { token: res.json.token, player_id: res.json.player_id };
    }
    const loyal = await signup("link_loyal", "Loyalist", 2);
    const traitor = await signup("link_traitor", "Traitor", 4);
    assert.equal((await api(ctx, admin, "POST", "/api/campaign/reset", { confirm: "RESET" })).status, 200);
    const forces = (await api(ctx, admin, "GET", "/api/forces")).json;
    const lForce = forces.find((f) => f.player_id === loyal.player_id);
    const tForce = forces.find((f) => f.player_id === traitor.player_id);
    await api(ctx, admin, "PUT", "/api/forces/" + lForce.force_id, { sys_id: 1 });
    await api(ctx, admin, "PUT", "/api/forces/" + tForce.force_id, { sys_id: 1 });
    assert.equal((await api(ctx, admin, "POST", "/api/campaign/set-phase", { phase: "Battles", turn: 1 })).status, 200);
    const proposed = await api(ctx, loyal.token, "POST", "/api/games", {
      attacker_id: loyal.player_id,
      defender_id: traitor.player_id,
      attacker_force_id: lForce.force_id,
      defender_force_id: tForce.force_id,
      sys_id: 1,
      mission: "Onslaught",
      result: "attacker_win",
      attacker_vp: 8,
      defender_vp: 3
    });
    assert.equal(proposed.status, 201, JSON.stringify(proposed.json));
    const gameId = proposed.json.game_id;
    const disputed = await api(ctx, traitor.token, "POST", "/api/games/" + gameId + "/dispute", {
      note: "The score is wrong"
    });
    assert.equal(disputed.status, 200, JSON.stringify(disputed.json));

    const inbox = await api(ctx, admin, "GET", "/api/inbox");
    assert.equal(inbox.status, 200);
    const card = inbox.json.actions.find((item) => item.game_id === gameId && item.result_state === "disputed");
    assert.ok(card, JSON.stringify(inbox.json.actions));
    assert.equal(card.duty, "admin");
    assert.equal(card.system_name, "Port Maw");
    assert.equal(card.attacker_name, "link_loyal");
    assert.equal(card.defender_name, "link_traitor");
    assert.equal(card.attacker_force, lForce.force_name);
    assert.equal(card.defender_force, tForce.force_name);
    assert.equal(card.result, "attacker_win");
    assert.equal(card.dispute_note, "The score is wrong");
    assert.equal(card.disputed_by_name, "link_traitor");
    assert.equal(typeof card.disputed_at, "string");
    const notice = inbox.json.notifications.find((n) => n.kind === "battle_result_disputed");
    assert.ok(notice, JSON.stringify(inbox.json.notifications));
    assert.equal(notice.ref.type, "game");
    assert.equal(notice.ref.game_id, gameId);
    assert.match(notice.text, new RegExp("Battle #" + gameId));

    const proposer = await api(ctx, loyal.token, "GET", "/api/inbox");
    const mine = proposer.json.mine.find((item) => item.game_id === gameId);
    assert.equal(mine.result_state, "disputed");
    assert.equal(mine.system_name, "Port Maw");
    assert.equal(mine.attacker_force, lForce.force_name);
    const playerNote = proposer.json.notifications.find((n) => n.kind === "battle_result_disputed");
    assert.equal(playerNote.ref.game_id, gameId);
  } finally {
    await ctx.stop();
  }
});

test("dispute surfaces link to games.html#game-<id>", () => {
  const actions = fs.readFileSync(path.join(ROOT, "actions.html"), "utf8");
  const dashboard = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const battles = fs.readFileSync(path.join(ROOT, "games.html"), "utf8");
  assert.match(actions, /games\.html#game-\$\{encodeURIComponent\(item\.game_id\)\}/);
  assert.match(actions, /n\.ref && n\.ref\.game_id/);
  assert.match(actions, /attacker_force/);
  assert.match(actions, /defender_force/);
  assert.match(dashboard, /games\.html#game-/);
  assert.match(dashboard, /attacker_force/);
  assert.match(dashboard, /resultLabelDash/);
  assert.match(battles, /#game-\(\\d\+\)/);
  assert.match(battles, /game-" \+ g\.game_id/);
  assert.match(battles, /dispute_note/);
  assert.match(battles, /data-apply/);
  assert.match(battles, /data-void/);
  assert.match(battles, /openLinkedBattle/);
  assert.match(battles, /Battle #\$\{esc\(g\.game_id\)\}/);
  assert.match(actions, /Battle #\$\{esc\(item\.game_id\)\}/);
  assert.match(actions, /games\.html#game-/);
  assert.match(dashboard, /Battle #/);
  const systemsPage = fs.readFileSync(path.join(ROOT, "systems.html"), "utf8");
  assert.match(systemsPage, /<th class="hide-sm">Durability<\/th>/);
  assert.doesNotMatch(systemsPage, />Dur</);
});
