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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-guard-"));
  const port = 22000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDir,
      CAMPAIGN_ADMIN_PASSWORD: ADMIN_PW,
      CAMPAIGN_ADMIN_FORCE_PASSWORD: "1"
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

async function signup(ctx, code, name, allegiance, startSysId) {
  const body = {
    invite_code: code,
    login: name,
    password: "botpass-xyz",
    player_name: name,
    display_name: name,
    allegiance
  };
  if (startSysId != null) body.start_sys_id = startSysId;
  const res = await api(ctx, null, "POST", "/api/auth/signup", body);
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return {
    name,
    token: res.json.token,
    player_id: res.json.player_id,
    allegiance
  };
}

test("battle guards and fresh-map seeding", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "baseline", "systems.json"), "utf8"));
    const seeded = JSON.parse(fs.readFileSync(path.join(ctx.dataDir, "systems.json"), "utf8"));
    assert.equal(seeded.length, baseline.length);
    assert.equal(seeded[0].sys_name, "Port Maw");

    const pub = await api(ctx, null, "GET", "/api/public/systems");
    assert.equal(pub.status, 200);
    assert.equal(pub.json.length, baseline.length);

    const adminLogin = await api(ctx, null, "POST", "/api/auth/login", {
      login: "admin",
      password: ADMIN_PW
    });
    assert.equal(adminLogin.status, 200, JSON.stringify(adminLogin.json));
    const admin = adminLogin.json.token;

    const early = await signup(
      ctx,
      (await api(ctx, admin, "POST", "/api/auth/invites", { note: "early" })).json.invite.code,
      "early_loyal",
      "Loyalist",
      2
    );
    assert.equal(early.player_id > 0, true);

    async function invite(note) {
      const res = await api(ctx, admin, "POST", "/api/auth/invites", { note });
      assert.equal(res.status, 201, JSON.stringify(res.json));
      return res.json.invite.code;
    }

    const loyal = await signup(ctx, await invite("L"), "guard_loyal", "Loyalist", null);
    const traitor = await signup(ctx, await invite("T"), "guard_traitor", "Traitor", null);
    const loyalHome = await signup(ctx, await invite("L2"), "guard_loyal_home", "Loyalist", 9);
    const traitorNext = await signup(ctx, await invite("T2"), "guard_traitor_next", "Traitor", null);

    const reset = await api(ctx, admin, "POST", "/api/campaign/reset", { confirm: "RESET" });
    assert.equal(reset.status, 200, JSON.stringify(reset.json));
    const forces = (await api(ctx, admin, "GET", "/api/forces")).json;
    function homes(playerId) {
      return forces.filter((f) => f.player_id === playerId).map((f) => f.sys_id);
    }
    const loyalHomes = homes(loyal.player_id);
    const traitorHomes = homes(traitor.player_id);
    const loyalChosen = homes(loyalHome.player_id);
    const traitorNextHomes = homes(traitorNext.player_id);
    assert.deepEqual(loyalChosen, [9, 9]);
    assert.equal(loyalHomes.every((id) => id !== 1), true, "loyalist forces must not start in Port Maw");
    assert.equal(traitorHomes.every((id) => id !== 1), true, "traitor forces must not start in Port Maw");
    assert.notDeepEqual(loyalHomes[0], traitorHomes[0]);
    assert.notEqual(traitorHomes[0], traitorNextHomes[0]);
    const systems = (await api(ctx, admin, "GET", "/api/systems")).json;
    function controller(id) {
      return systems.find((s) => s.sys_id === id).sys_controller;
    }
    assert.equal(controller(loyalHomes[0]), "Loyalist");
    assert.equal(controller(traitorHomes[0]), "Traitor");
    assert.equal(controller(traitorNextHomes[0]), "Traitor");

    const lForces = forces.filter((f) => f.player_id === loyal.player_id).sort((a, b) => a.force_id - b.force_id);
    const tForces = forces.filter((f) => f.player_id === traitor.player_id).sort((a, b) => a.force_id - b.force_id);
    async function moveForce(force, sysId) {
      const res = await api(ctx, admin, "PUT", "/api/forces/" + force.force_id, { sys_id: sysId });
      assert.equal(res.status, 200, JSON.stringify(res.json));
    }
    await moveForce(lForces[0], 1);
    await moveForce(tForces[0], 1);
    await moveForce(tForces[1], loyalHomes[0]);

    const phase = await api(ctx, admin, "POST", "/api/campaign/set-phase", { phase: "Battles" });
    assert.equal(phase.status, 200);

    const proposed = await api(ctx, loyal.token, "POST", "/api/games", {
      attacker_id: loyal.player_id,
      defender_id: traitor.player_id,
      attacker_force_id: lForces[0].force_id,
      defender_force_id: tForces[0].force_id,
      sys_id: 1,
      result: "attacker_win",
      attacker_vp: 12,
      defender_vp: 7
    });
    assert.equal(proposed.status, 201, JSON.stringify(proposed.json));
    assert.equal(proposed.json.result_state, "pending");
    const gameId = proposed.json.game_id;

    const confirmed = await api(ctx, traitor.token, "POST", "/api/games/" + gameId + "/confirm", {});
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));
    assert.equal(confirmed.json.result_state, "applied");
    const portAfterWin = (await api(ctx, admin, "GET", "/api/systems/1")).json;
    const loserEdit = await api(ctx, traitor.token, "PUT", "/api/games/" + gameId, { result: "defender_win" });
    assert.equal(loserEdit.status, 403);
    assert.match(loserEdit.json.error, /confirmed battle/i);
    const portStill = (await api(ctx, admin, "GET", "/api/systems/1")).json;
    assert.equal(portStill.sys_loyal, portAfterWin.sys_loyal);
    assert.equal(portStill.sys_traitor, portAfterWin.sys_traitor);
    const stillApplied = (await api(ctx, admin, "GET", "/api/games/" + gameId)).json;
    assert.equal(stillApplied.result_state, "applied");
    assert.equal(stillApplied.result, "attacker_win");

    const adminEdit = await api(ctx, admin, "PUT", "/api/games/" + gameId, { result: "defender_win" });
    assert.equal(adminEdit.status, 200, JSON.stringify(adminEdit.json));
    assert.equal(adminEdit.json.result_state, "applied");
    assert.equal(adminEdit.json.result, "defender_win");
    const portAfterAdmin = (await api(ctx, admin, "GET", "/api/systems/1")).json;
    assert.equal(portAfterAdmin.sys_loyal, portAfterWin.sys_loyal - 1);
    assert.equal(portAfterAdmin.sys_traitor, portAfterWin.sys_traitor + 1);
    const attackerAfter = (await api(ctx, admin, "GET", "/api/forces/" + lForces[0].force_id)).json;
    const defenderAfter = (await api(ctx, admin, "GET", "/api/forces/" + tForces[0].force_id)).json;
    assert.equal(attackerAfter.strength, 2);
    assert.equal(defenderAfter.strength, 3);

    const repeat = await api(ctx, loyal.token, "POST", "/api/games", {
      attacker_id: loyal.player_id,
      defender_id: traitor.player_id,
      attacker_force_id: lForces[0].force_id,
      defender_force_id: tForces[0].force_id,
      sys_id: 1,
      result: "attacker_win"
    });
    assert.equal(repeat.status, 409);
    assert.match(repeat.json.error, /already have a battle/i);

    const other = await api(ctx, loyal.token, "POST", "/api/games", {
      attacker_id: loyal.player_id,
      defender_id: traitor.player_id,
      attacker_force_id: lForces[1].force_id,
      defender_force_id: tForces[1].force_id,
      sys_id: loyalHomes[0],
      result: "in_progress"
    });
    assert.equal(other.status, 201, JSON.stringify(other.json));
    assert.equal(other.json.result_state, "open");
    const swapped = await api(ctx, loyal.token, "PUT", "/api/games/" + other.json.game_id, {
      attacker_force_id: lForces[0].force_id
    });
    assert.equal(swapped.status, 400);
    assert.match(swapped.json.error, /battle's system/);
    const openStill = (await api(ctx, admin, "GET", "/api/games/" + other.json.game_id)).json;
    assert.equal(openStill.attacker_force_id, lForces[1].force_id);

    await api(ctx, admin, "PUT", "/api/forces/" + lForces[1].force_id, { status: "destroyed", strength: 0 });
    const destroyed = await api(ctx, loyal.token, "PUT", "/api/games/" + other.json.game_id, {
      result: "attacker_win"
    });
    assert.equal(destroyed.status, 400);
    assert.match(destroyed.json.error, /Destroyed/);
    await api(ctx, admin, "PUT", "/api/forces/" + lForces[1].force_id, { status: "active", strength: 3 });

    const logistics = await api(ctx, admin, "POST", "/api/campaign/set-phase", { phase: "Logistics" });
    assert.equal(logistics.status, 200);
    const wrongPhase = await api(ctx, loyal.token, "PUT", "/api/games/" + other.json.game_id, {
      notes: "edited off phase"
    });
    assert.equal(wrongPhase.status, 409);
    assert.match(wrongPhase.json.error, /Battles phase/);
    assert.equal((await api(ctx, admin, "POST", "/api/campaign/set-phase", { phase: "Battles" })).status, 200);

    const gamesPath = path.join(ctx.dataDir, "games.json");
    const games = JSON.parse(fs.readFileSync(gamesPath, "utf8"));
    const dupId = Math.max(...games.map((g) => g.game_id)) + 1;
    games.push({
      ...stillApplied,
      game_id: dupId,
      result: "attacker_win",
      result_state: "pending",
      proposed_by: loyal.player_id,
      resolution: null,
      winner_id: loyal.player_id
    });
    fs.writeFileSync(gamesPath, JSON.stringify(games, null, 2));
    const dupConfirm = await api(ctx, traitor.token, "POST", "/api/games/" + dupId + "/confirm", {});
    assert.equal(dupConfirm.status, 409);
    assert.match(dupConfirm.json.error, /already have a battle/i);

    const blocked = await api(ctx, admin, "POST", "/api/campaign/advance", {});
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.code, "unresolved_battles");
    assert.match(blocked.json.error, new RegExp("#" + other.json.game_id));
    assert.match(blocked.json.error, /force/);
    assert.equal((await api(ctx, admin, "GET", "/api/games/" + other.json.game_id)).json.result_state, "open");
    const portBeforeForce = (await api(ctx, admin, "GET", "/api/systems/1")).json;
    assert.equal(portBeforeForce.sys_loyal, portAfterAdmin.sys_loyal);

    const forced = await api(ctx, admin, "POST", "/api/campaign/advance", { force: true });
    assert.equal(forced.status, 200, JSON.stringify(forced.json));
    assert.match(forced.json.log.join(" "), /Voided/);
    assert.equal(forced.json.to.turn, 2);
    assert.equal(forced.json.to.phase, "Logistics");
    const voided = (await api(ctx, admin, "GET", "/api/games/" + other.json.game_id)).json;
    assert.equal(voided.result_state, "void");
    const dupAfter = (await api(ctx, admin, "GET", "/api/games/" + dupId)).json;
    assert.equal(dupAfter.result_state, "void");
    const appliedAfter = (await api(ctx, admin, "GET", "/api/games/" + gameId)).json;
    assert.equal(appliedAfter.result_state, "applied");
    assert.equal(appliedAfter.result, "defender_win");
    const portAfterForce = (await api(ctx, admin, "GET", "/api/systems/1")).json;
    assert.equal(portAfterForce.sys_loyal, portAfterAdmin.sys_loyal);
    assert.equal(portAfterForce.sys_traitor, portAfterAdmin.sys_traitor);
    const reopenVoid = await api(ctx, loyal.token, "PUT", "/api/games/" + other.json.game_id, {
      result: "attacker_win"
    });
    assert.equal(reopenVoid.status, 403);
  } finally {
    await ctx.stop();
  }
});
