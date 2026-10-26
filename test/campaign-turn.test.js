"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const ADMIN_PW = "test-admin-pw-123";
const PORT_MAW = 1;

function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-turn-"));
  const port = 33000 + Math.floor(Math.random() * 20000);
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
      AUTO_ADVANCE_INTERVAL_MS: "60000"
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

async function adminToken(ctx) {
  const login = await api(ctx, null, "POST", "/api/auth/login", { login: "admin", password: ADMIN_PW });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  return login.json.token;
}

async function pairAtPortMaw(ctx, admin, loyal, traitor) {
  assert.equal((await api(ctx, admin, "POST", "/api/campaign/reset", { confirm: "RESET" })).status, 200);
  const forces = (await api(ctx, admin, "GET", "/api/forces")).json;
  const loyalForce = forces.find((force) => force.player_id === loyal.player_id && force.status === "active");
  const traitorForce = forces.find((force) => force.player_id === traitor.player_id && force.status === "active");
  assert.ok(loyalForce && traitorForce);
  assert.equal((await api(ctx, admin, "PUT", "/api/forces/" + loyalForce.force_id, { sys_id: PORT_MAW })).status, 200);
  assert.equal((await api(ctx, admin, "PUT", "/api/forces/" + traitorForce.force_id, { sys_id: PORT_MAW })).status, 200);
  assert.equal((await api(ctx, admin, "POST", "/api/campaign/set-phase", { phase: "Battles" })).status, 200);
  return { loyalForce, traitorForce };
}

function battleBody(loyal, traitor, forces, extra) {
  return {
    attacker_id: loyal.player_id,
    defender_id: traitor.player_id,
    attacker_force_id: forces.loyalForce.force_id,
    defender_force_id: forces.traitorForce.force_id,
    sys_id: PORT_MAW,
    result: "in_progress",
    ...extra
  };
}

test("the battle form names campaign turn and game rounds", () => {
  const games = fs.readFileSync(path.join(ROOT, "games.html"), "utf8");
  const dashboard = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const actions = fs.readFileSync(path.join(ROOT, "actions.html"), "utf8");
  assert.match(games, /<label for="f-turn">Campaign turn<\/label>/);
  assert.doesNotMatch(games, /<label for="f-turn">Turn/);
  assert.match(games, /id="f-turn"/);
  assert.match(games, /input\.readOnly = SH\.role !== "campaign_admin"/);
  assert.match(games, /<label for="f-rounds">Game rounds played<\/label>/);
  assert.match(games, /id="f-rounds"[^>]*min="1"[^>]*max="10"/);
  assert.match(games, /function roundsBit/);
  assert.match(games, /Campaign turn \$\{g\.turn\}\$\{roundsBit\(g\)\}/);
  assert.match(games, /game rounds/);
  assert.match(dashboard, /Campaign turn \$\{escDash\(g\.turn\)\}/);
  assert.match(dashboard, /game rounds/);
  assert.match(actions, /Campaign turn \$\{esc\(item\.turn/);
  assert.match(actions, /game rounds/);
});

test("players cannot set another campaign turn, and game rounds are 1 to 10", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const admin = await adminToken(ctx);
    const loyal = await signup(ctx, admin, "turn_loyal", "Loyalist", 2);
    const traitor = await signup(ctx, admin, "turn_traitor", "Traitor", 4);
    const forces = await pairAtPortMaw(ctx, admin, loyal, traitor);

    const wrongTurn = await api(ctx, loyal.token, "POST", "/api/games", battleBody(loyal, traitor, forces, {
      turn: 4
    }));
    assert.equal(wrongTurn.status, 400, JSON.stringify(wrongTurn.json));
    assert.match(wrongTurn.json.error, /current turn/);

    for (const rounds of [0, 11, 1.5, true, "11", "4.5"]) {
      const bad = await api(ctx, loyal.token, "POST", "/api/games", battleBody(loyal, traitor, forces, {
        rounds_played: rounds
      }));
      assert.equal(bad.status, 400, JSON.stringify(rounds) + " " + JSON.stringify(bad.json));
      assert.match(bad.json.error, /1 to 10/);
    }

    const omitted = await api(ctx, loyal.token, "POST", "/api/games", battleBody(loyal, traitor, forces, {}));
    assert.equal(omitted.status, 201, JSON.stringify(omitted.json));
    assert.equal(omitted.json.turn, 1);
    assert.equal(omitted.json.rounds_played ?? null, null);
    const gameId = omitted.json.game_id;

    const editedTurn = await api(ctx, loyal.token, "PUT", "/api/games/" + gameId, { turn: 4 });
    assert.equal(editedTurn.status, 400, JSON.stringify(editedTurn.json));
    assert.match(editedTurn.json.error, /current turn/);
    const still = await api(ctx, loyal.token, "GET", "/api/games/" + gameId);
    assert.equal(still.json.turn, 1);
    assert.equal(still.json.rounds_played ?? null, null);

    const recorded = await api(ctx, loyal.token, "PUT", "/api/games/" + gameId, {
      turn: 1,
      rounds_played: "7"
    });
    assert.equal(recorded.status, 200, JSON.stringify(recorded.json));
    assert.equal(recorded.json.turn, 1);
    assert.equal(recorded.json.rounds_played, 7);

    const tooMany = await api(ctx, loyal.token, "PUT", "/api/games/" + gameId, { rounds_played: 11 });
    assert.equal(tooMany.status, 400, JSON.stringify(tooMany.json));
    assert.equal((await api(ctx, loyal.token, "GET", "/api/games/" + gameId)).json.rounds_played, 7);

    const cleared = await api(ctx, loyal.token, "PUT", "/api/games/" + gameId, { rounds_played: null });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
    assert.equal(cleared.json.rounds_played, null);
    assert.equal(cleared.json.turn, 1);

    const kept = await api(ctx, loyal.token, "PUT", "/api/games/" + gameId, { rounds_played: 4 });
    assert.equal(kept.status, 200, JSON.stringify(kept.json));
    assert.equal(kept.json.rounds_played, 4);

    const adminGame = await api(ctx, admin, "POST", "/api/games", battleBody(loyal, traitor, forces, {
      turn: 4,
      rounds_played: 1
    }));
    assert.equal(adminGame.status, 201, JSON.stringify(adminGame.json));
    assert.equal(adminGame.json.turn, 4);
    assert.equal(adminGame.json.rounds_played, 1);
    const adminBad = await api(ctx, admin, "PUT", "/api/games/" + adminGame.json.game_id, { rounds_played: 11 });
    assert.equal(adminBad.status, 400, JSON.stringify(adminBad.json));
    const adminTurn = await api(ctx, admin, "PUT", "/api/games/" + adminGame.json.game_id, { turn: 5 });
    assert.equal(adminTurn.status, 200, JSON.stringify(adminTurn.json));
    assert.equal(adminTurn.json.turn, 5);
    assert.equal(adminTurn.json.rounds_played, 1);

    assert.equal((await api(ctx, admin, "POST", "/api/campaign/set-phase", { phase: "Battles", turn: 2 })).status, 200);
    const next = await api(ctx, traitor.token, "POST", "/api/games", battleBody(loyal, traitor, forces, {
      rounds_played: 10
    }));
    assert.equal(next.status, 201, JSON.stringify(next.json));
    assert.equal(next.json.turn, 2);
    assert.equal(next.json.rounds_played, 10);
    const stale = await api(ctx, traitor.token, "POST", "/api/games", battleBody(loyal, traitor, forces, {
      turn: 1,
      rounds_played: 3
    }));
    assert.equal(stale.status, 400, JSON.stringify(stale.json));
    assert.match(stale.json.error, /current turn/);
  } finally {
    await ctx.stop();
  }
});
