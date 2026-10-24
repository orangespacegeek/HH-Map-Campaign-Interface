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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-outcome-"));
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
    ...extra
  };
}

async function snapshot(ctx, admin, forces) {
  const systems = (await api(ctx, admin, "GET", "/api/systems")).json;
  const sys = systems.find((row) => Number(row.sys_id) === PORT_MAW);
  const all = (await api(ctx, admin, "GET", "/api/forces")).json;
  const loyal = all.find((force) => Number(force.force_id) === Number(forces.loyalForce.force_id));
  const traitor = all.find((force) => Number(force.force_id) === Number(forces.traitorForce.force_id));
  return {
    durability: Number(sys.sys_durability),
    loyalScore: Number(sys.sys_loyal),
    traitorScore: Number(sys.sys_traitor),
    controller: sys.sys_controller,
    loyalStrength: Number(loyal.strength),
    traitorStrength: Number(traitor.strength),
    loyalFought: loyal.fought_this_turn,
    traitorFought: traitor.fought_this_turn
  };
}

test("unable to schedule closes the battle with no campaign effects", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const admin = await adminToken(ctx);
    const loyal = await signup(ctx, admin, "sched_loyal", "Loyalist", 2);
    const traitor = await signup(ctx, admin, "sched_traitor", "Traitor", 4);
    const forces = await pairAtPortMaw(ctx, admin, loyal, traitor);
    const before = await snapshot(ctx, admin, forces);

    const reported = await api(ctx, loyal.token, "POST", "/api/games", battleBody(loyal, traitor, forces, {
      result: "unable_to_schedule"
    }));
    assert.equal(reported.status, 201, JSON.stringify(reported.json));
    assert.equal(reported.json.result_state, "pending");
    assert.equal(reported.json.winner_id, null);
    assert.equal(reported.json.attacker_vp, null);
    assert.equal(reported.json.defender_vp, null);
    const pendingSnap = await snapshot(ctx, admin, forces);
    assert.deepEqual(pendingSnap, before);

    const own = await api(ctx, loyal.token, "POST", "/api/games/" + reported.json.game_id + "/confirm", {});
    assert.equal(own.status, 403);

    const confirmed = await api(ctx, traitor.token, "POST", "/api/games/" + reported.json.game_id + "/confirm", {});
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));
    assert.equal(confirmed.json.result_state, "applied");
    assert.equal(confirmed.json.result, "unable_to_schedule");
    assert.equal(confirmed.json.resolution.system, null);
    assert.deepEqual(confirmed.json.resolution.forces, []);
    assert.deepEqual(await snapshot(ctx, admin, forces), before);

    for (const player of [loyal, traitor]) {
      const inbox = await api(ctx, player.token, "GET", "/api/inbox");
      const note = inbox.json.notifications.find((row) => row.kind === "battle_result_applied" && /unable to schedule/i.test(row.text));
      assert.ok(note, JSON.stringify(inbox.json.notifications));
      assert.match(note.text, /no penalties/);
    }

    const advance = await api(ctx, admin, "POST", "/api/campaign/advance", {});
    assert.equal(advance.status, 200, JSON.stringify(advance.json));
    assert.equal(advance.json.to.phase, "Logistics");
    assert.equal(advance.json.to.turn, 2);
    const kept = await api(ctx, admin, "GET", "/api/games/" + reported.json.game_id);
    assert.equal(kept.json.result, "unable_to_schedule");
    assert.equal(kept.json.result_state, "applied");
    assert.equal(kept.json.voided_at, undefined);
  } finally {
    await ctx.stop();
  }
});

test("a no show waits for the admin, rejects cleanly, and grants one action next turn", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const admin = await adminToken(ctx);
    const loyal = await signup(ctx, admin, "show_loyal", "Loyalist", 2);
    const traitor = await signup(ctx, admin, "show_traitor", "Traitor", 4);
    const forces = await pairAtPortMaw(ctx, admin, loyal, traitor);
    const before = await snapshot(ctx, admin, forces);

    const namedSelf = await api(ctx, loyal.token, "POST", "/api/games", battleBody(loyal, traitor, forces, {
      result: "no_show",
      no_show_id: loyal.player_id
    }));
    assert.equal(namedSelf.status, 400, JSON.stringify(namedSelf.json));
    assert.match(namedSelf.json.error, /other player/);

    const reported = await api(ctx, loyal.token, "POST", "/api/games", battleBody(loyal, traitor, forces, {
      result: "no_show",
      no_show_id: traitor.player_id
    }));
    assert.equal(reported.status, 201, JSON.stringify(reported.json));
    assert.equal(reported.json.result_state, "pending");
    assert.equal(reported.json.no_show_id, traitor.player_id);
    assert.equal(reported.json.winner_id, loyal.player_id);
    assert.equal(reported.json.attacker_vp, 0);
    assert.equal(reported.json.defender_vp, 0);
    assert.deepEqual(await snapshot(ctx, admin, forces), before);

    const own = await api(ctx, loyal.token, "POST", "/api/games/" + reported.json.game_id + "/confirm", {});
    assert.equal(own.status, 403, JSON.stringify(own.json));
    assert.match(own.json.error, /campaign admin/);
    const opponent = await api(ctx, traitor.token, "POST", "/api/games/" + reported.json.game_id + "/confirm", {});
    assert.equal(opponent.status, 403, JSON.stringify(opponent.json));
    assert.match(opponent.json.error, /not the opponent/);
    assert.deepEqual(await snapshot(ctx, admin, forces), before);

    const adminInbox = await api(ctx, admin, "GET", "/api/inbox");
    const queued = adminInbox.json.actions.find((item) => item.game_id === reported.json.game_id);
    assert.ok(queued, JSON.stringify(adminInbox.json.actions));
    assert.equal(queued.duty, "no_show");
    assert.equal(queued.no_show_name, "show_traitor");
    const opponentInbox = await api(ctx, traitor.token, "GET", "/api/inbox");
    assert.equal(opponentInbox.json.actions.some((item) => item.game_id === reported.json.game_id), false);
    for (const player of [loyal, traitor]) {
      const inbox = await api(ctx, player.token, "GET", "/api/inbox");
      const note = inbox.json.notifications.find((row) => row.kind === "battle_result_submitted" && /no show/i.test(row.text));
      assert.ok(note, JSON.stringify(inbox.json.notifications));
    }

    const rejected = await api(ctx, admin, "POST", "/api/games/" + reported.json.game_id + "/reject", {});
    assert.equal(rejected.status, 200, JSON.stringify(rejected.json));
    assert.equal(rejected.json.result, "in_progress");
    assert.equal(rejected.json.result_state, "open");
    assert.equal(rejected.json.no_show_id, null);
    assert.equal(rejected.json.resolution, null);
    assert.deepEqual(await snapshot(ctx, admin, forces), before);
    for (const player of [loyal, traitor]) {
      const inbox = await api(ctx, player.token, "GET", "/api/inbox");
      const note = inbox.json.notifications.find((row) => row.kind === "battle_result_rejected");
      assert.ok(note, JSON.stringify(inbox.json.notifications));
      assert.match(note.text, /nothing was applied/);
    }

    const again = await api(ctx, loyal.token, "PUT", "/api/games/" + reported.json.game_id, battleBody(loyal, traitor, forces, {
      result: "no_show",
      no_show_id: traitor.player_id
    }));
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(again.json.result_state, "pending");

    const confirmed = await api(ctx, admin, "POST", "/api/games/" + reported.json.game_id + "/confirm", {});
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));
    assert.equal(confirmed.json.result_state, "applied");
    assert.equal(confirmed.json.winner_id, loyal.player_id);
    const after = await snapshot(ctx, admin, forces);
    assert.equal(after.loyalStrength, before.loyalStrength);
    assert.equal(after.traitorStrength, before.traitorStrength - 1);
    assert.equal(after.durability, before.durability - 1);
    assert.equal(after.loyalScore, before.loyalScore + 1);
    assert.equal(after.traitorScore, before.traitorScore);
    assert.equal(after.controller, "Loyalist");
    assert.equal(after.loyalFought, true);
    assert.equal(after.traitorFought, true);

    const meta = (await api(ctx, admin, "GET", "/api/meta")).json;
    assert.equal(meta.action_bonuses[String(loyal.player_id)]["2"], 1);
    assert.equal(meta.action_bonuses[String(traitor.player_id)], undefined);

    assert.equal((await api(ctx, admin, "POST", "/api/campaign/set-phase", { phase: "Logistics", turn: 2 })).status, 200);
    const roster = await api(ctx, admin, "GET", "/api/actions/players");
    const row = roster.json.players.find((player) => player.player_id === loyal.player_id);
    assert.equal(row.actions_per_turn, 3);
    assert.equal(row.actions_remaining, 3);
    assert.equal(row.finished, false);
    const ownStatus = await api(ctx, loyal.token, "GET", "/api/actions/status");
    assert.equal(ownStatus.json.actions_per_turn, 3);
    assert.equal(ownStatus.json.actions_remaining, 3);

    for (let i = 0; i < 2; i++) {
      const spent = await api(ctx, loyal.token, "POST", "/api/actions/fortify", { sys_id: PORT_MAW });
      assert.equal(spent.status, 200, JSON.stringify(spent.json));
    }
    const mid = await api(ctx, admin, "GET", "/api/actions/players");
    const midRow = mid.json.players.find((player) => player.player_id === loyal.player_id);
    assert.equal(midRow.actions_remaining, 1);
    assert.equal(midRow.finished, false);
    assert.equal(mid.json.ready_to_advance, false);
    const third = await api(ctx, loyal.token, "POST", "/api/actions/fortify", { sys_id: PORT_MAW });
    assert.equal(third.status, 200, JSON.stringify(third.json));
    assert.equal(third.json.actions_remaining, 0);
    const fourth = await api(ctx, loyal.token, "POST", "/api/actions/fortify", { sys_id: PORT_MAW });
    assert.equal(fourth.status, 409, JSON.stringify(fourth.json));
    assert.match(fourth.json.error, /3 per turn/);

    assert.equal((await api(ctx, admin, "POST", "/api/campaign/set-phase", { phase: "Logistics", turn: 3 })).status, 200);
    const later = await api(ctx, loyal.token, "GET", "/api/actions/status");
    assert.equal(later.json.actions_per_turn, 2);
    assert.equal(later.json.actions_remaining, 2);
    assert.equal((await api(ctx, loyal.token, "POST", "/api/actions/fortify", { sys_id: PORT_MAW })).status, 200);
    assert.equal((await api(ctx, loyal.token, "POST", "/api/actions/fortify", { sys_id: PORT_MAW })).status, 200);
    const expired = await api(ctx, loyal.token, "POST", "/api/actions/fortify", { sys_id: PORT_MAW });
    assert.equal(expired.status, 409, JSON.stringify(expired.json));
    assert.match(expired.json.error, /2 per turn/);

    for (const player of [loyal, traitor]) {
      const inbox = await api(ctx, player.token, "GET", "/api/inbox");
      const note = inbox.json.notifications.find((row) => row.kind === "battle_result_applied" && /confirmed the no show/i.test(row.text));
      assert.ok(note, JSON.stringify(inbox.json.notifications));
      assert.match(note.text, /extra logistics action next turn/);
    }
  } finally {
    await ctx.stop();
  }
});

test("the rules and report form name both outcomes", () => {
  const rulesMd = fs.readFileSync(path.join(ROOT, "campaign_rules.md"), "utf8");
  const rulesHtml = fs.readFileSync(path.join(ROOT, "rules.html"), "utf8");
  const games = fs.readFileSync(path.join(ROOT, "games.html"), "utf8");
  const actions = fs.readFileSync(path.join(ROOT, "actions.html"), "utf8");
  assert.match(rulesMd, /Unable to schedule: the players are unable to mutually find the time to play this game\. Neither player is penalized or gains a boon\. \(added as part of web app build\)/);
  assert.match(rulesMd, /No Show: one of the players did not respond to their opponent's attempts to schedule the game, or did not show up to, or attempt to reschedule, their scheduled game\. The offending player's force loses the battle\. The reporting player gains an additional logistics point next turn\. This battle must be confirmed by the campaign admin\. \(added as part of web app build\)/);
  assert.match(rulesHtml, /id="battle-outcomes"/);
  assert.match(rulesHtml, /Unable to schedule:<\/strong> the players are unable to mutually find the time to play this game\. Neither player is penalized or gains a boon\./);
  assert.match(rulesHtml, /No Show:<\/strong> one of the players did not respond to their opponent's attempts to schedule the game/);
  assert.doesNotMatch(rulesHtml, /added as part of web app build/);
  assert.match(games, /value="played"/);
  assert.match(games, /value="unable_to_schedule"/);
  assert.match(games, /value="no_show"/);
  assert.match(games, /Requires campaign admin confirmation/);
  assert.match(games, /rules\.html#battle-outcomes/);
  assert.match(actions, /data-act="reject"/);
  assert.match(actions, />Confirm</);
  assert.match(actions, />Reject</);
  assert.match(actions, /a\.duty === "admin" \|\| a\.duty === "no_show"/);
});
