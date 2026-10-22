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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-livefix-"));
  const port = 30000 + Math.floor(Math.random() * 20000);
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
    allegiance
  };
  if (start != null) body.start_sys_id = start;
  const res = await api(ctx, null, "POST", "/api/auth/signup", body);
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { token: res.json.token, player_id: res.json.player_id, name };
}

function pairKey(game) {
  const ids = [Number(game.attacker_force_id), Number(game.defender_force_id)].sort((a, b) => a - b);
  return ids.join(":");
}

async function toBattles(ctx, admin) {
  assert.equal((await api(ctx, admin, "POST", "/api/campaign/advance", {})).status, 200);
  const battles = await api(ctx, admin, "POST", "/api/campaign/advance", {});
  assert.equal(battles.status, 200, JSON.stringify(battles.json));
  assert.equal(battles.json.to.phase, "Battles");
}

test("destroying a force voids its other open and pending battles", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const admin = await adminToken(ctx);
    const loyal = await inviteAndSignup(ctx, admin, "void_loyal", "Loyalist", 2);
    const traitor = await inviteAndSignup(ctx, admin, "void_traitor", "Traitor", 4);
    assert.equal((await api(ctx, admin, "POST", "/api/campaign/reset", { confirm: "RESET" })).status, 200);
    const forces = (await api(ctx, admin, "GET", "/api/forces")).json;
    const loyalForces = forces.filter((f) => f.player_id === loyal.player_id).sort((a, b) => a.force_id - b.force_id);
    const traitorForces = forces.filter((f) => f.player_id === traitor.player_id).sort((a, b) => a.force_id - b.force_id);
    assert.equal(
      (await api(ctx, admin, "PUT", "/api/forces/" + loyalForces[0].force_id, { sys_id: 1, strength: 1 })).status,
      200
    );
    assert.equal((await api(ctx, admin, "PUT", "/api/forces/" + traitorForces[0].force_id, { sys_id: 1 })).status, 200);
    assert.equal((await api(ctx, admin, "PUT", "/api/forces/" + traitorForces[1].force_id, { sys_id: 1 })).status, 200);
    await toBattles(ctx, admin);

    const games = (await api(ctx, admin, "GET", "/api/games")).json
      .filter((g) => Number(g.sys_id) === 1 && Number(g.turn) === 1)
      .sort((a, b) => a.game_id - b.game_id);
    assert.equal(games.length, 2, JSON.stringify(games));
    assert.ok(games.every((g) => Number(g.attacker_force_id) === loyalForces[0].force_id));
    const [first, second] = games;

    const pending = await api(ctx, loyal.token, "PUT", "/api/games/" + second.game_id, {
      result: "attacker_win",
      attacker_vp: 1,
      defender_vp: 0
    });
    assert.equal(pending.status, 200, JSON.stringify(pending.json));
    assert.equal(pending.json.result_state, "pending");

    const proposed = await api(ctx, traitor.token, "PUT", "/api/games/" + first.game_id, {
      result: "defender_win",
      attacker_vp: 0,
      defender_vp: 1
    });
    assert.equal(proposed.status, 200, JSON.stringify(proposed.json));
    const applied = await api(ctx, loyal.token, "POST", "/api/games/" + first.game_id + "/confirm", {});
    assert.equal(applied.status, 200, JSON.stringify(applied.json));
    assert.equal(applied.json.result_state, "applied");

    const after = await api(ctx, admin, "GET", "/api/games/" + second.game_id);
    assert.equal(after.status, 200);
    assert.equal(after.json.result_state, "void");
    assert.equal(after.json.result, "in_progress");
    assert.equal(after.json.winner_id, null);
    assert.equal(after.json.resolution, null);
    assert.match(String(after.json.void_reason), /force_destroyed/);

    const kept = await api(ctx, admin, "GET", "/api/games/" + first.game_id);
    assert.equal(kept.json.result_state, "applied");
    assert.ok(kept.json.resolution);

    const port = (await api(ctx, admin, "GET", "/api/systems/1")).json;
    assert.equal(port.sys_loyal, 3);
    assert.equal(port.sys_traitor, 4);
    assert.equal(port.sys_durability, 4);
    const dead = (await api(ctx, admin, "GET", "/api/forces/" + loyalForces[0].force_id)).json;
    assert.equal(dead.status, "destroyed");
    assert.equal(dead.strength, 0);
    const spared = (await api(ctx, admin, "GET", "/api/forces/" + traitorForces[1].force_id)).json;
    assert.equal(spared.strength, 3);
    assert.equal(spared.status, "active");

    for (const player of [loyal, traitor]) {
      const inbox = await api(ctx, player.token, "GET", "/api/inbox");
      const note = inbox.json.notifications.find(
        (n) => n.kind === "battle_result_voided" && n.ref && Number(n.ref.game_id) === second.game_id
      );
      assert.ok(note, JSON.stringify(inbox.json.notifications));
      assert.match(note.text, new RegExp("Battle #" + second.game_id));
      assert.match(note.text, /destroyed/);
      assert.match(note.text, /No result was applied/);
    }

    const stuck = await api(ctx, loyal.token, "PUT", "/api/games/" + second.game_id, { result: "draw" });
    assert.equal(stuck.status, 403);
    const advance = await api(ctx, admin, "POST", "/api/campaign/advance", {});
    assert.equal(advance.status, 200, JSON.stringify(advance.json));
  } finally {
    await ctx.stop();
  }
});

test("a player battle must be an auto-paired matchup, including outnumbered pairings", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const admin = await adminToken(ctx);
    const loyal = await inviteAndSignup(ctx, admin, "pair_loyal", "Loyalist", 2);
    const traitorA = await inviteAndSignup(ctx, admin, "pair_traitor_a", "Traitor", 4);
    const traitorB = await inviteAndSignup(ctx, admin, "pair_traitor_b", "Traitor", 6);
    assert.equal((await api(ctx, admin, "POST", "/api/campaign/reset", { confirm: "RESET" })).status, 200);
    const forces = (await api(ctx, admin, "GET", "/api/forces")).json;
    const loyalForces = forces.filter((f) => f.player_id === loyal.player_id).sort((a, b) => a.force_id - b.force_id);
    const aForces = forces.filter((f) => f.player_id === traitorA.player_id).sort((a, b) => a.force_id - b.force_id);
    const bForces = forces.filter((f) => f.player_id === traitorB.player_id).sort((a, b) => a.force_id - b.force_id);
    const inSystem = [loyalForces[0], loyalForces[1], aForces[0], aForces[1], bForces[0]];
    for (const force of inSystem) {
      assert.equal((await api(ctx, admin, "PUT", "/api/forces/" + force.force_id, { sys_id: 1 })).status, 200);
    }
    await toBattles(ctx, admin);

    const games = (await api(ctx, admin, "GET", "/api/games")).json.filter((g) => Number(g.sys_id) === 1);
    const keys = games.map(pairKey).sort();
    const expected = [
      [loyalForces[0].force_id, aForces[0].force_id],
      [loyalForces[0].force_id, aForces[1].force_id],
      [loyalForces[1].force_id, bForces[0].force_id]
    ]
      .map((ids) => ids.sort((a, b) => a - b).join(":"))
      .sort();
    assert.deepEqual(keys, expected, JSON.stringify(games));

    const cross = await api(ctx, loyal.token, "POST", "/api/games", {
      attacker_id: loyal.player_id,
      defender_id: traitorB.player_id,
      attacker_force_id: loyalForces[0].force_id,
      defender_force_id: bForces[0].force_id,
      sys_id: 1,
      result: "attacker_win"
    });
    assert.equal(cross.status, 400, JSON.stringify(cross.json));
    assert.match(cross.json.error, /not paired/);

    const otherCross = await api(ctx, loyal.token, "POST", "/api/games", {
      attacker_id: loyal.player_id,
      defender_id: traitorA.player_id,
      attacker_force_id: loyalForces[1].force_id,
      defender_force_id: aForces[0].force_id,
      sys_id: 1,
      result: "attacker_win"
    });
    assert.equal(otherCross.status, 400, JSON.stringify(otherCross.json));

    const assignedKey = [loyalForces[0].force_id, aForces[0].force_id].sort((a, b) => a - b).join(":");
    const assigned = games.find((g) => pairKey(g) === assignedKey);
    const updated = await api(ctx, loyal.token, "PUT", "/api/games/" + assigned.game_id, {
      result: "attacker_win",
      attacker_vp: 2,
      defender_vp: 1
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.json));
    assert.equal(updated.json.result_state, "pending");
    assert.equal(Number(updated.json.attacker_force_id), loyalForces[0].force_id);

    const adminFree = await api(ctx, admin, "POST", "/api/games", {
      attacker_id: loyal.player_id,
      defender_id: traitorA.player_id,
      attacker_force_id: loyalForces[1].force_id,
      defender_force_id: aForces[0].force_id,
      sys_id: 1,
      result: "in_progress"
    });
    assert.equal(adminFree.status, 201, JSON.stringify(adminFree.json));
  } finally {
    await ctx.stop();
  }
});

test("player ids are never reused and removed players do not leave their forces behind", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const admin = await adminToken(ctx);
    const first = await inviteAndSignup(ctx, admin, "id_first", "Loyalist", 2);
    const second = await inviteAndSignup(ctx, admin, "id_second", "Traitor", 4);
    assert.equal(second.player_id, first.player_id + 1);
    assert.equal((await api(ctx, admin, "POST", "/api/campaign/reset", { confirm: "RESET" })).status, 200);

    const forces = (await api(ctx, admin, "GET", "/api/forces")).json;
    const secondForces = forces.filter((f) => f.player_id === second.player_id);
    assert.equal(secondForces.length, 2);
    const battle = await api(ctx, admin, "POST", "/api/games", {
      attacker_id: first.player_id,
      defender_id: second.player_id,
      attacker_force_id: forces.find((f) => f.player_id === first.player_id).force_id,
      defender_force_id: secondForces[0].force_id,
      sys_id: 1,
      result: "attacker_win"
    });
    assert.equal(battle.status, 201, JSON.stringify(battle.json));
    const gameId = battle.json.game_id;

    const removed = await api(ctx, admin, "DELETE", "/api/players/" + second.player_id);
    assert.equal(removed.status, 200, JSON.stringify(removed.json));
    assert.equal((await api(ctx, admin, "GET", "/api/players/" + second.player_id)).status, 404);
    const keptGame = await api(ctx, admin, "GET", "/api/games/" + gameId);
    assert.equal(keptGame.status, 200);
    assert.equal(keptGame.json.result_state, "applied");
    const retired = (await api(ctx, admin, "GET", "/api/forces")).json.filter((f) => f.player_id === second.player_id);
    assert.equal(retired.length, 2);
    assert.ok(retired.every((f) => f.status === "removed"));
    const signedOut = await api(ctx, second.token, "GET", "/api/auth/me");
    assert.equal(signedOut.json.authenticated, false);
    assert.equal((await api(ctx, second.token, "GET", "/api/inbox")).status, 401);

    const third = await inviteAndSignup(ctx, admin, "id_third", "Traitor", 4);
    assert.notEqual(third.player_id, second.player_id);
    assert.ok(third.player_id > second.player_id);
    const inherited = (await api(ctx, admin, "GET", "/api/forces")).json.filter((f) => f.player_id === third.player_id);
    assert.equal(inherited.length, 0);

    const stamped = await api(ctx, admin, "POST", "/api/games", {
      attacker_id: 80,
      defender_id: first.player_id,
      sys_id: 1,
      result: "in_progress"
    });
    assert.equal(stamped.status, 201, JSON.stringify(stamped.json));
    const fourth = await inviteAndSignup(ctx, admin, "id_fourth", "Loyalist", 3);
    assert.ok(fourth.player_id > 80, "id was " + fourth.player_id);

    const meta = await api(ctx, admin, "GET", "/api/meta");
    assert.equal(meta.json.next_player_id, fourth.player_id + 1);
    const pub = await api(ctx, null, "GET", "/api/public/meta");
    assert.equal(pub.json.next_player_id, undefined);

    assert.equal((await api(ctx, admin, "POST", "/api/campaign/reset", { confirm: "RESET" })).status, 200);
    const afterReset = await inviteAndSignup(ctx, admin, "id_fifth", "Loyalist", 2);
    assert.ok(afterReset.player_id > fourth.player_id);
    assert.notEqual(afterReset.player_id, 1);
  } finally {
    await ctx.stop();
  }
});
