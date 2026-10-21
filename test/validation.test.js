"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const ADMIN_PW = "test-admin-pw-123";

function startServer(extraEnv = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-valid-"));
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
      TRUST_PROXY: "",
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

async function api(ctx, token, method, pathname, body, headers = {}) {
  const reqHeaders = { "Content-Type": "application/json", "X-SH-Request": "1", ...headers };
  if (token) reqHeaders.Authorization = "Bearer " + token;
  const res = await fetch(ctx.base + pathname, {
    method,
    headers: reqHeaders,
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
  const res = await api(ctx, null, "POST", "/api/auth/login", { login: "admin", password: ADMIN_PW });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json.token;
}

async function inviteAndSignup(ctx, admin, name, allegiance, start) {
  const inv = await api(ctx, admin, "POST", "/api/auth/invites", { note: name });
  assert.equal(inv.status, 201, JSON.stringify(inv.json));
  const body = {
    invite_code: inv.json.invite.code,
    login: name,
    password: "botpass-xyz",
    player_name: name,
    display_name: name,
    allegiance,
    start_sys_id: start
  };
  const res = await api(ctx, null, "POST", "/api/auth/signup", body);
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { token: res.json.token, player_id: res.json.player_id };
}

test("phase, victory timing, proxy, victory points, notices, and hold", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const admin = await adminToken(ctx);
    const loyal = await inviteAndSignup(ctx, admin, "val_loyal", "Loyalist", 2);
    const traitor = await inviteAndSignup(ctx, admin, "val_traitor", "Traitor", 4);
    assert.equal((await api(ctx, admin, "POST", "/api/campaign/reset", { confirm: "RESET" })).status, 200);
    const balance = await api(ctx, admin, "GET", "/api/campaign/status");
    assert.equal(balance.json.control_power.loyal, 12);
    assert.equal(balance.json.control_power.traitor, 10);

    const before = await api(ctx, admin, "GET", "/api/campaign/status");
    for (const turn of ["abc", 0, -3, 1.5, "1.5", true]) {
      const bad = await api(ctx, admin, "POST", "/api/campaign/set-phase", { phase: "Logistics", turn });
      assert.equal(bad.status, 400, JSON.stringify(turn));
      assert.match(bad.json.error, /positive integer/);
    }
    const unchanged = await api(ctx, admin, "GET", "/api/campaign/status");
    assert.equal(unchanged.json.turn, before.json.turn);
    const okTurn = await api(ctx, admin, "POST", "/api/campaign/set-phase", { phase: "Battles", turn: 4 });
    assert.equal(okTurn.status, 200);
    assert.equal(okTurn.json.to.turn, 4);
    const okString = await api(ctx, admin, "POST", "/api/campaign/set-phase", { phase: "Logistics", turn: "6" });
    assert.equal(okString.status, 200);
    assert.equal((await api(ctx, admin, "GET", "/api/campaign/status")).json.turn, 6);

    const forces = (await api(ctx, admin, "GET", "/api/forces")).json;
    const lForces = forces.filter((f) => f.player_id === loyal.player_id).sort((a, b) => a.force_id - b.force_id);
    const tForces = forces.filter((f) => f.player_id === traitor.player_id).sort((a, b) => a.force_id - b.force_id);
    await api(ctx, admin, "PUT", "/api/forces/" + lForces[0].force_id, { sys_id: 1 });
    await api(ctx, admin, "PUT", "/api/forces/" + tForces[0].force_id, { sys_id: 1 });
    await api(ctx, admin, "POST", "/api/campaign/set-phase", { phase: "Battles", turn: 1 });

    const conceded = await api(ctx, loyal.token, "POST", "/api/games", {
      attacker_id: loyal.player_id,
      defender_id: traitor.player_id,
      attacker_force_id: lForces[0].force_id,
      defender_force_id: tForces[0].force_id,
      sys_id: 1,
      result: "conceded",
      winner_id: loyal.player_id,
      attacker_vp: -5,
      defender_vp: "lots"
    });
    assert.equal(conceded.status, 400);
    assert.match(conceded.json.error, /victory points/);
    assert.equal((await api(ctx, admin, "GET", "/api/games")).json.length, 0);

    const proposed = await api(ctx, loyal.token, "POST", "/api/games", {
      attacker_id: loyal.player_id,
      defender_id: traitor.player_id,
      attacker_force_id: lForces[0].force_id,
      defender_force_id: tForces[0].force_id,
      sys_id: 1,
      result: "attacker_win",
      attacker_vp: 0,
      defender_vp: 12
    });
    assert.equal(proposed.status, 201, JSON.stringify(proposed.json));
    const gameId = proposed.json.game_id;
    assert.equal((await api(ctx, traitor.token, "POST", "/api/games/" + gameId + "/confirm", {})).status, 200);

    const reopened = await api(ctx, admin, "PUT", "/api/games/" + gameId, { result: "defender_win" });
    assert.equal(reopened.status, 200, JSON.stringify(reopened.json));
    const winnerInbox = await api(ctx, loyal.token, "GET", "/api/inbox");
    assert.equal(
      winnerInbox.json.notifications.some((n) => n.kind === "battle_result_reopened" && /reopened your result/.test(n.text)),
      true,
      JSON.stringify(winnerInbox.json.notifications)
    );

    const voided = await api(ctx, admin, "POST", "/api/games/" + gameId + "/void", {});
    assert.equal(voided.status, 200, JSON.stringify(voided.json));
    const defenderInbox = await api(ctx, traitor.token, "GET", "/api/inbox");
    assert.equal(
      defenderInbox.json.notifications.some((n) => n.kind === "battle_result_voided" && /voided your win/.test(n.text)),
      true,
      JSON.stringify(defenderInbox.json.notifications)
    );
    assert.equal((await api(ctx, admin, "DELETE", "/api/games/" + gameId)).status, 200);

    await api(ctx, admin, "PUT", "/api/meta", {
      campaign_name: "Sunset Heresy",
      subsector: "Port Maw",
      turn: 2,
      phase: "Battles",
      loyal_score: 100,
      traitor_score: 10,
      player_actions: {}
    });
    const early = await api(ctx, admin, "POST", "/api/campaign/advance", {});
    assert.equal(early.status, 200, JSON.stringify(early.json));
    assert.equal(early.json.to.turn, 3);
    assert.equal(early.json.victory, null);
    assert.equal(early.json.meta.victor || null, null);

    await api(ctx, admin, "PUT", "/api/meta", {
      campaign_name: "Sunset Heresy",
      subsector: "Port Maw",
      turn: 3,
      phase: "Battles",
      loyal_score: 112,
      traitor_score: 20,
      player_actions: {}
    });
    const onTime = await api(ctx, admin, "POST", "/api/campaign/advance", {});
    assert.equal(onTime.status, 200, JSON.stringify(onTime.json));
    assert.equal(onTime.json.to.turn, 4);
    assert.equal(onTime.json.victory.winner, "Loyalist");
    assert.match(onTime.json.victory.reason, /Double campaign score/);

    await api(ctx, admin, "POST", "/api/campaign/set-phase", { phase: "Movement", turn: 1 });
    await api(ctx, admin, "PUT", "/api/meta", {
      campaign_name: "Sunset Heresy",
      turn: 1,
      phase: "Movement",
      loyal_score: 0,
      traitor_score: 0,
      victor: null,
      victory_reason: null,
      player_actions: {}
    });
    const firstMove = await api(ctx, loyal.token, "POST", "/api/actions/move", {
      force_id: lForces[1].force_id,
      dest_sys_id: 1
    });
    assert.equal(firstMove.status, 200, JSON.stringify(firstMove.json));
    assert.equal(firstMove.json.actions_remaining, 1);
    const retarget = await api(ctx, loyal.token, "POST", "/api/actions/move", {
      force_id: lForces[1].force_id,
      dest_sys_id: 5
    });
    assert.equal(retarget.status, 200, JSON.stringify(retarget.json));
    assert.equal(retarget.json.actions_remaining, 1);
    assert.equal(retarget.json.force.dest_sys_id, 5);
    const held = await api(ctx, loyal.token, "POST", "/api/actions/hold", { force_id: lForces[1].force_id });
    assert.equal(held.status, 200, JSON.stringify(held.json));
    assert.equal(held.json.actions_remaining, 2);
    assert.equal(held.json.force.dest_sys_id, null);
    assert.match(held.json.message, /refunded/);
    const holdAgain = await api(ctx, loyal.token, "POST", "/api/actions/hold", { force_id: lForces[1].force_id });
    assert.equal(holdAgain.status, 200);
    assert.equal(holdAgain.json.actions_remaining, 2);
    await api(ctx, admin, "POST", "/api/campaign/set-phase", { phase: "Logistics" });
    const wrongPhase = await api(ctx, loyal.token, "POST", "/api/actions/hold", { force_id: lForces[1].force_id });
    assert.equal(wrongPhase.status, 409);
    assert.match(wrongPhase.json.error, /Movement phase/);

    let limited = 0;
    for (let i = 0; i < 35; i++) {
      const res = await api(ctx, null, "POST", "/api/auth/login", { login: "nobody", password: "x" }, {
        "X-Forwarded-For": "10.9.0." + i
      });
      if (res.status === 429) limited += 1;
    }
    assert.ok(limited > 0, "rotating X-Forwarded-For must not bypass the limiter");
  } finally {
    await ctx.stop();
  }

  const trusted = startServer({ TRUST_PROXY: "1" });
  try {
    await trusted.ready;
    let limited = 0;
    for (let i = 0; i < 35; i++) {
      const res = await api(trusted, null, "POST", "/api/auth/login", { login: "nobody", password: "x" }, {
        "X-Forwarded-For": "10.8.0." + i
      });
      if (res.status === 429) limited += 1;
    }
    assert.equal(limited, 0);
  } finally {
    await trusted.stop();
  }
});
