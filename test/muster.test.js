"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const ADMIN_PW = "test-admin-pw-123";

function startServer(options = {}) {
  const dataDir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), "hh-muster-"));
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
        resolve(log);
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

async function signup(ctx, admin, name, allegiance, extra) {
  const inv = await api(ctx, admin, "POST", "/api/auth/invites", { note: name });
  assert.equal(inv.status, 201, JSON.stringify(inv.json));
  const res = await api(ctx, null, "POST", "/api/auth/signup", {
    invite_code: inv.json.invite.code,
    login: name,
    password: "botpass-xyz",
    player_name: name,
    display_name: name,
    allegiance,
    ...(extra || {})
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { token: res.json.token, player_id: res.json.player_id };
}

function owned(forces, playerId) {
  return forces.filter((force) => force.player_id === playerId).sort((a, b) => a.force_id - b.force_id);
}

function musterBackups(dir) {
  const folder = path.join(dir, "backups");
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).filter((name) => name.startsWith("pre-muster-forces-")).sort();
}

test("Muster is sign-up only, Begin campaign locks the roster, and reset returns there", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const admin = await adminToken(ctx);
    const loyal = await signup(ctx, admin, "muster_loyal", "Loyalist", {
      starting_forces: [
        { force_name: "First Company", sys_id: 2 },
        { force_name: "Second Company", sys_id: 4 }
      ]
    });
    const named = owned((await api(ctx, loyal.token, "GET", "/api/forces")).json, loyal.player_id);
    assert.equal(named.length, 2);
    assert.deepEqual(named.map((force) => force.force_name), ["First Company", "Second Company"]);
    assert.deepEqual(named.map((force) => force.sys_id), [2, 4]);
    assert.deepEqual(named.map((force) => force.home_sys_id), [2, 4]);
    assert.ok(named.every((force) => force.strength === 3 && force.status === "active"));

    const traitor = await signup(ctx, admin, "muster_traitor", "Traitor", { start_sys_id: 4 });
    assert.equal((await api(ctx, admin, "POST", "/api/campaign/reset", { confirm: "RESET" })).status, 200);
    const status = await api(ctx, null, "GET", "/api/campaign/status");
    assert.equal(status.json.phase, "Muster");
    assert.equal(status.json.turn, 1);
    assert.equal(status.json.roster_locked, false);
    assert.equal(status.json.auto_advance_muster, false);
    assert.ok(status.json.phases.includes("Muster"));
    const afterReset = owned((await api(ctx, loyal.token, "GET", "/api/forces")).json, loyal.player_id);
    assert.equal(afterReset.length, 2);
    named[0] = afterReset[0];

    const visitor = await api(ctx, null, "GET", "/api/campaign/muster");
    assert.equal(visitor.status, 401);
    const playerRoster = await api(ctx, loyal.token, "GET", "/api/campaign/muster");
    assert.equal(playerRoster.status, 403);
    const roster = await api(ctx, admin, "GET", "/api/campaign/muster");
    assert.equal(roster.status, 200, JSON.stringify(roster.json));
    assert.equal(roster.json.loyalists, 1);
    assert.equal(roster.json.traitors, 1);
    const loyalRow = roster.json.players.find((player) => player.player_id === loyal.player_id);
    assert.equal(loyalRow.allegiance, "Loyalist");
    assert.equal(loyalRow.forces.length, 2);
    assert.equal((await api(ctx, admin, "PUT", "/api/players/" + traitor.player_id, { status: "inactive" })).status, 200);
    const quieter = await api(ctx, admin, "GET", "/api/campaign/muster");
    assert.equal(quieter.json.traitors, 0);
    assert.equal(quieter.json.loyalists, 1);
    assert.equal((await api(ctx, admin, "PUT", "/api/players/" + traitor.player_id, { status: "active" })).status, 200);

    const moved = await api(ctx, loyal.token, "PUT", "/api/forces/" + named[0].force_id, { sys_id: 9 });
    assert.equal(moved.status, 200, JSON.stringify(moved.json));
    assert.equal(moved.json.sys_id, 9);
    assert.equal(moved.json.home_sys_id, 9);

    const battle = await api(ctx, admin, "POST", "/api/games", {
      attacker_id: loyal.player_id,
      defender_id: traitor.player_id,
      sys_id: 1,
      result: "in_progress"
    });
    assert.equal(battle.status, 409, JSON.stringify(battle.json));
    assert.match(battle.json.error, /Battles are not available during Muster/);
    const fortify = await api(ctx, loyal.token, "POST", "/api/actions/fortify", { sys_id: 2 });
    assert.equal(fortify.status, 409, JSON.stringify(fortify.json));
    assert.match(fortify.json.error, /Campaign actions are not available during Muster/);
    const adminFortify = await api(ctx, admin, "POST", "/api/actions/fortify", {
      player_id: loyal.player_id,
      sys_id: 2
    });
    assert.equal(adminFortify.status, 409);
    assert.match(adminFortify.json.error, /Campaign actions are not available during Muster/);
    const advance = await api(ctx, admin, "POST", "/api/campaign/advance", {});
    assert.equal(advance.status, 409);
    assert.match(advance.json.error, /Use Begin campaign to leave Muster/);
    assert.equal((await api(ctx, loyal.token, "POST", "/api/campaign/begin", {})).status, 403);

    const begun = await api(ctx, admin, "POST", "/api/campaign/begin", {});
    assert.equal(begun.status, 200, JSON.stringify(begun.json));
    assert.equal(begun.json.to.phase, "Logistics");
    assert.equal(begun.json.to.turn, 1);
    const locked = await api(ctx, admin, "GET", "/api/campaign/muster");
    assert.equal(locked.json.roster_locked, true);
    assert.equal(locked.json.phase, "Logistics");
    const homeLocked = await api(ctx, loyal.token, "PUT", "/api/forces/" + named[0].force_id, { sys_id: 2 });
    assert.equal(homeLocked.status, 409);
    assert.match(homeLocked.json.error, /Home systems can only be chosen during Muster/);
    const again = await api(ctx, admin, "POST", "/api/campaign/begin", {});
    assert.equal(again.status, 409);
    assert.match(again.json.error, /The campaign has already begun/);

    const late = await signup(ctx, admin, "muster_late", "Loyalist", { start_sys_id: 2 });
    const lateForces = owned((await api(ctx, admin, "GET", "/api/forces")).json, late.player_id);
    assert.equal(lateForces.length, 2);
    assert.ok(lateForces.every((force) => force.strength === 3 && Number(force.sys_id) === 2));
    const balanced = await api(ctx, admin, "GET", "/api/campaign/muster");
    assert.equal(balanced.json.loyalists, 2);
    assert.equal(balanced.json.traitors, 1);

    const reset = await api(ctx, admin, "POST", "/api/campaign/reset", { confirm: "RESET" });
    assert.equal(reset.status, 200, JSON.stringify(reset.json));
    assert.equal(reset.json.phase, "Muster");
    const after = await api(ctx, null, "GET", "/api/campaign/status");
    assert.equal(after.json.phase, "Muster");
    assert.equal(after.json.turn, 1);
    assert.equal(after.json.roster_locked, false);
    assert.equal(after.json.auto_advance_muster, false);
    const rebuilt = owned((await api(ctx, admin, "GET", "/api/forces")).json, late.player_id);
    assert.equal(rebuilt.length, 2);
  } finally {
    await ctx.stop();
  }
});

test("a Muster deadline does nothing until the admin allows that one step", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const admin = await adminToken(ctx);
    await signup(ctx, admin, "dead_muster_loyal", "Loyalist", { start_sys_id: 2 });
    await signup(ctx, admin, "dead_muster_traitor", "Traitor", { start_sys_id: 4 });
    assert.equal((await api(ctx, admin, "POST", "/api/campaign/reset", { confirm: "RESET" })).status, 200);

    const held = await api(ctx, admin, "POST", "/api/campaign/phase-deadline", {
      phase_ends_at: "2020-01-01T00:00:00.000Z"
    });
    assert.equal(held.status, 200, JSON.stringify(held.json));
    assert.equal(held.json.advanced, false);
    assert.equal(held.json.phase, "Muster");
    assert.ok(held.json.phase_ends_at);

    const on = await api(ctx, admin, "POST", "/api/campaign/auto-advance", { muster: true });
    assert.equal(on.status, 200, JSON.stringify(on.json));
    assert.equal(on.json.advanced, true);
    assert.equal(on.json.phase, "Logistics");
    assert.equal(on.json.turn, 1);
    assert.equal(on.json.auto_advance_muster, true);
    const meta = (await api(ctx, admin, "GET", "/api/meta")).json;
    assert.equal(meta.phase_ends_at, null);
    assert.equal(meta.roster_locked, true);
    const autos = (meta.phase_log || []).filter((entry) => entry.automatic);
    assert.equal(autos.length, 1);
    assert.equal(autos[0].reason, "deadline");
    assert.equal(autos[0].from.phase, "Muster");
    assert.equal(autos[0].to.phase, "Logistics");
    assert.equal(autos[0].to.turn, 1);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const stayed = (await api(ctx, admin, "GET", "/api/meta")).json;
    assert.equal(stayed.phase, "Logistics");
    assert.equal(stayed.turn, 1);
    assert.equal((stayed.phase_log || []).filter((entry) => entry.automatic).length, 1);
  } finally {
    await ctx.stop();
  }
});

test("startup gives existing players their missing starting forces once", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-muster-migrate-"));
  fs.writeFileSync(path.join(dataDir, "players.json"), JSON.stringify([
    { player_id: 1, player_name: "Ada", display_name: "Ada", allegiance: "Loyalist", status: "active" },
    { player_id: 2, player_name: "Horus", display_name: "Horus", allegiance: "Traitor", status: "active" },
    { player_id: 3, player_name: "Shade", display_name: "Shade", allegiance: "needs side", status: "active" },
    { player_id: 4, player_name: "Gone", display_name: "Gone", allegiance: "Loyalist", status: "active" }
  ], null, 2));
  fs.writeFileSync(path.join(dataDir, "forces.json"), JSON.stringify([
    { force_id: 1, player_id: 2, force_name: "Wreck", allegiance: "Traitor", status: "destroyed", strength: 0, sys_id: 4 },
    { force_id: 2, player_id: 4, force_name: "Lost I", allegiance: "Loyalist", status: "destroyed", strength: 0, sys_id: 2 },
    { force_id: 3, player_id: 4, force_name: "Lost II", allegiance: "Loyalist", status: "destroyed", strength: 0, sys_id: 2 }
  ], null, 2));
  fs.writeFileSync(path.join(dataDir, "meta.json"), JSON.stringify({
    turn: 3,
    phase: "Battles",
    auto_advance_when_done: false
  }));

  const first = startServer({ dataDir });
  try {
    const log = await first.ready;
    assert.match(log, /Muster migration/);
    assert.equal(musterBackups(dataDir).length, 1);
    const backup = JSON.parse(fs.readFileSync(path.join(dataDir, "backups", musterBackups(dataDir)[0]), "utf8"));
    assert.equal(backup.forces.length, 3);
    assert.equal(backup.players.find((player) => player.player_id === 3).allegiance, "needs side");
    const forces = JSON.parse(fs.readFileSync(path.join(dataDir, "forces.json"), "utf8"));
    assert.equal(forces.filter((force) => force.player_id === 1 && force.status === "active").length, 2);
    assert.equal(forces.filter((force) => force.player_id === 2).length, 2);
    assert.equal(forces.filter((force) => force.player_id === 3).length, 0);
    assert.equal(forces.filter((force) => force.player_id === 4).length, 2);
    const meta = JSON.parse(fs.readFileSync(path.join(dataDir, "meta.json"), "utf8"));
    assert.equal(meta.phase, "Battles");
    assert.equal(meta.turn, 3);
  } finally {
    await first.stop();
  }

  const second = startServer({ dataDir });
  try {
    const log = await second.ready;
    assert.doesNotMatch(log, /Muster migration/);
    assert.equal(musterBackups(dataDir).length, 1);
    const forces = JSON.parse(fs.readFileSync(path.join(dataDir, "forces.json"), "utf8"));
    assert.equal(forces.filter((force) => force.player_id === 1).length, 2);
  } finally {
    await second.stop();
  }
});

test("Muster rules are in the campaign text, and the player page omits the build note", () => {
  const rulesMd = fs.readFileSync(path.join(ROOT, "campaign_rules.md"), "utf8");
  const rulesHtml = fs.readFileSync(path.join(ROOT, "rules.html"), "utf8");
  const dashboard = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.match(
    rulesMd,
    /Before the first campaign turn, players join, choose Loyalist or Traitor, name their two starting forces, and pick a home system for each force\.[\s\S]*\(added as part of web app build\)/
  );
  assert.match(rulesHtml, /id="muster"/);
  assert.match(rulesHtml, /A player who joins after Muster still receives two starting forces\./);
  assert.doesNotMatch(rulesHtml, /added as part of web app build/);
  assert.match(dashboard, /id="btn-begin"/);
  assert.match(dashboard, /id="muster-roster"/);
  assert.match(dashboard, /id="auto-advance-muster"/);
  assert.doesNotMatch(dashboard, /id="auto-advance-muster" checked/);
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  assert.match(server, /auto_advance_muster === true/);
  assert.match(server, /Battles are not available during Muster/);
  assert.match(server, /Campaign actions are not available during Muster/);
});
