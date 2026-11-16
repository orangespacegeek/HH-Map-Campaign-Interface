"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const BASELINE = path.join(ROOT, "data", "baseline", "systems.json");
const ADMIN_PW = "test-admin-pw-123";
const AJALE = 1;
const AEOLUS = 2;
const MARINAS = 3;
const MEZOA = 4;
const ELECTRIS = 5;
const ORTHO = 10;

function startServer(options = {}) {
  const dataDir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), "hh-occupy-"));
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
    dataDir,
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

function systemById(systems, sysId) {
  const sys = systems.find((row) => Number(row.sys_id) === Number(sysId));
  assert.ok(sys, "missing system " + sysId);
  return sys;
}

function influence(sys) {
  return {
    loyal: Number(sys.sys_loyal) || 0,
    traitor: Number(sys.sys_traitor) || 0,
    controller: sys.sys_controller
  };
}

function occupationLine(log) {
  const line = (log || []).find((entry) => String(entry).startsWith("Turn ") && String(entry).includes(" occupation:"));
  assert.ok(line, JSON.stringify(log));
  return line;
}

test("the Occupation rule is in the campaign text, and the page omits the build note", () => {
  const rulesMd = fs.readFileSync(path.join(ROOT, "campaign_rules.md"), "utf8");
  const rulesHtml = fs.readFileSync(path.join(ROOT, "rules.html"), "utf8");
  const control = rulesMd.indexOf("*System Control/Influence*");
  const occupation = rulesMd.indexOf("*Occupation*");
  const scoring = rulesMd.indexOf("*Campaign Turn Scoring*");
  assert.ok(control >= 0 && occupation > control && scoring > occupation);
  assert.match(
    rulesMd,
    /\*Occupation\*[\s\S]*active Forces from only one side[\s\S]*\+1 influence \(sys_loyal or sys_traitor\)[\s\S]*Destroyed and inactive Forces do not count\.[\s\S]*\(added as part of web app build\)/
  );
  const htmlControl = rulesHtml.indexOf("<h2>System Control</h2>");
  const htmlOccupation = rulesHtml.indexOf("<h3>Occupation</h3>");
  const htmlScoring = rulesHtml.indexOf("<h2>Scoring");
  assert.ok(htmlControl >= 0 && htmlOccupation > htmlControl && htmlScoring > htmlOccupation);
  assert.match(rulesHtml, /active Forces from only one side gains \+1 influence/);
  assert.match(rulesHtml, /Destroyed and inactive Forces do not count\./);
  assert.doesNotMatch(rulesHtml, /added as part of web app build/);
});

test("uncontested occupation grants influence once per turn, before scoring", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const admin = await adminToken(ctx);
    const loyalA = await signup(ctx, admin, "occ_loyal_a", "Loyalist", AEOLUS);
    const loyalB = await signup(ctx, admin, "occ_loyal_b", "Loyalist", AEOLUS);
    const traitorA = await signup(ctx, admin, "occ_traitor_a", "Traitor", MEZOA);
    const traitorB = await signup(ctx, admin, "occ_traitor_b", "Traitor", MEZOA);
    const traitorC = await signup(ctx, admin, "occ_traitor_c", "Traitor", MEZOA);
    const forces = (await api(ctx, admin, "GET", "/api/forces")).json;
    function owned(player) {
      return forces
        .filter((force) => force.player_id === player.player_id)
        .sort((a, b) => a.force_id - b.force_id);
    }
    const [loyalOne, loyalContested] = owned(loyalA);
    const [loyalDestroyed, loyalElectris] = owned(loyalB);
    const [traitorMarinasA, traitorMarinasB] = owned(traitorA);
    const [traitorMarinasC, traitorMezoa] = owned(traitorB);
    const [traitorInactive, traitorContested] = owned(traitorC);
    const placements = [
      [loyalOne, AEOLUS, null],
      [loyalContested, AJALE, null],
      [loyalDestroyed, MEZOA, "destroyed"],
      [loyalElectris, ELECTRIS, null],
      [traitorMarinasA, MARINAS, null],
      [traitorMarinasB, MARINAS, null],
      [traitorMarinasC, MARINAS, null],
      [traitorMezoa, MEZOA, null],
      [traitorInactive, ELECTRIS, "inactive"],
      [traitorContested, AJALE, null]
    ];
    for (const [force, sysId, status] of placements) {
      const body = { sys_id: sysId };
      if (status) body.status = status;
      const moved = await api(ctx, admin, "PUT", "/api/forces/" + force.force_id, body);
      assert.equal(moved.status, 200, JSON.stringify(moved.json));
      if (status) assert.equal(moved.json.status, status);
    }

    const beforeSystems = (await api(ctx, admin, "GET", "/api/systems")).json;
    const beforeStatus = await api(ctx, admin, "GET", "/api/campaign/status");
    assert.equal(beforeStatus.json.control_power.loyal, 12);
    assert.equal(beforeStatus.json.control_power.traitor, 10);
    assert.equal(beforeStatus.json.loyal_score || 0, 0);
    assert.equal(beforeStatus.json.traitor_score || 0, 0);

    const toMovement = await api(ctx, admin, "POST", "/api/campaign/advance", {});
    assert.equal(toMovement.status, 200, JSON.stringify(toMovement.json));
    assert.equal(toMovement.json.to.phase, "Movement");
    assert.equal((toMovement.json.log || []).some((entry) => String(entry).includes("occupation:")), false);
    const mid = (await api(ctx, admin, "GET", "/api/systems")).json;
    for (const sys of beforeSystems) {
      assert.deepEqual(influence(systemById(mid, sys.sys_id)), influence(sys));
    }
    assert.equal((await api(ctx, admin, "GET", "/api/meta")).json.occupation_applied_turn ?? null, null);

    assert.equal((await api(ctx, admin, "POST", "/api/campaign/set-phase", { phase: "Battles", turn: 1 })).status, 200);
    const ended = await api(ctx, admin, "POST", "/api/campaign/advance", {});
    assert.equal(ended.status, 200, JSON.stringify(ended.json));
    assert.equal(ended.json.to.phase, "Logistics");
    assert.equal(ended.json.to.turn, 2);
    assert.equal(
      occupationLine(ended.json.log),
      "Turn 1 occupation: Aeolus Loyalist +1; Marinas Traitor +3; Mezoa Traitor +1; Electris Loyalist +1"
    );
    const meta = (await api(ctx, admin, "GET", "/api/meta")).json;
    assert.equal(meta.occupation_applied_turn, 1);
    const saved = meta.phase_log[meta.phase_log.length - 1];
    assert.equal(occupationLine(saved.notes), occupationLine(ended.json.log));

    const after = (await api(ctx, admin, "GET", "/api/systems")).json;
    assert.deepEqual(influence(systemById(after, AEOLUS)), { loyal: 5, traitor: 1, controller: "Loyalist" });
    assert.deepEqual(influence(systemById(after, MARINAS)), { loyal: 2, traitor: 3, controller: "Traitor" });
    assert.deepEqual(influence(systemById(after, AJALE)), { loyal: 3, traitor: 3, controller: "Contested" });
    assert.deepEqual(influence(systemById(after, MEZOA)), { loyal: 2, traitor: 7, controller: "Traitor" });
    assert.deepEqual(influence(systemById(after, ELECTRIS)), { loyal: 2, traitor: 1, controller: "Loyalist" });
    assert.deepEqual(influence(systemById(after, ORTHO)), { loyal: 0, traitor: 2, controller: "Traitor" });
    for (const id of [6, 7, 8, 9, 11, 12, 13]) {
      assert.deepEqual(influence(systemById(after, id)), influence(systemById(beforeSystems, id)));
    }

    // Marinas (power 2) flips to Traitor and Electris (power 2) becomes Loyalist.
    // Scoring sees that control, so Traitor gains 2 more than the pre-occupation total.
    const scored = await api(ctx, admin, "GET", "/api/campaign/status");
    assert.equal(scored.json.loyal_score, 12);
    assert.equal(scored.json.traitor_score, 12);
    assert.equal(scored.json.control_power.loyal, 12);
    assert.equal(scored.json.control_power.traitor, 12);

    assert.equal((await api(ctx, admin, "POST", "/api/campaign/set-phase", { phase: "Battles", turn: 1 })).status, 200);
    const again = await api(ctx, admin, "POST", "/api/campaign/advance", {});
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(again.json.to.turn, 2);
    assert.equal(occupationLine(again.json.log), "Turn 1 occupation: already applied");
    const still = (await api(ctx, admin, "GET", "/api/systems")).json;
    for (const sys of after) {
      assert.deepEqual(influence(systemById(still, sys.sys_id)), influence(sys));
    }
    assert.equal((await api(ctx, admin, "GET", "/api/meta")).json.occupation_applied_turn, 1);
  } finally {
    await ctx.stop();
  }
});

test("a past Battles deadline grants occupation once, and a retry does not", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const admin = await adminToken(ctx);
    const loyal = await signup(ctx, admin, "occ_auto_loyal", "Loyalist", AEOLUS);
    const traitor = await signup(ctx, admin, "occ_auto_traitor", "Traitor", MEZOA);
    const forces = (await api(ctx, admin, "GET", "/api/forces")).json;
    const loyalForces = forces.filter((force) => force.player_id === loyal.player_id);
    const traitorForces = forces.filter((force) => force.player_id === traitor.player_id);
    assert.equal(loyalForces.length, 2);
    assert.equal(traitorForces.length, 2);
    for (const force of loyalForces) {
      assert.equal((await api(ctx, admin, "PUT", "/api/forces/" + force.force_id, { sys_id: AEOLUS })).status, 200);
    }
    for (const force of traitorForces) {
      assert.equal((await api(ctx, admin, "PUT", "/api/forces/" + force.force_id, { sys_id: MEZOA })).status, 200);
    }
    assert.equal((await api(ctx, admin, "POST", "/api/campaign/set-phase", { phase: "Battles", turn: 1 })).status, 200);
    const deadline = await api(ctx, admin, "POST", "/api/campaign/phase-deadline", {
      phase_ends_at: "2020-01-01T00:00:00.000Z"
    });
    assert.equal(deadline.status, 200, JSON.stringify(deadline.json));
    assert.equal(deadline.json.advanced, true);
    assert.equal(deadline.json.phase, "Logistics");
    assert.equal(deadline.json.turn, 2);
    const systems = (await api(ctx, admin, "GET", "/api/systems")).json;
    assert.deepEqual(influence(systemById(systems, AEOLUS)), { loyal: 6, traitor: 1, controller: "Loyalist" });
    assert.deepEqual(influence(systemById(systems, MEZOA)), { loyal: 2, traitor: 8, controller: "Traitor" });
    const meta = (await api(ctx, admin, "GET", "/api/meta")).json;
    assert.equal(meta.occupation_applied_turn, 1);
    const note = meta.phase_log[meta.phase_log.length - 1];
    assert.equal(note.automatic, true);
    assert.equal(note.reason, "deadline");
    assert.equal(
      occupationLine(note.notes),
      "Turn 1 occupation: Aeolus Loyalist +2; Mezoa Traitor +2"
    );

    assert.equal((await api(ctx, admin, "POST", "/api/campaign/set-phase", { phase: "Battles", turn: 1 })).status, 200);
    const retry = await api(ctx, admin, "POST", "/api/campaign/phase-deadline", {
      phase_ends_at: "2020-01-01T00:00:00.000Z"
    });
    assert.equal(retry.status, 200, JSON.stringify(retry.json));
    assert.equal(retry.json.advanced, true);
    assert.equal(retry.json.turn, 2);
    const still = (await api(ctx, admin, "GET", "/api/systems")).json;
    assert.deepEqual(influence(systemById(still, AEOLUS)), influence(systemById(systems, AEOLUS)));
    assert.deepEqual(influence(systemById(still, MEZOA)), influence(systemById(systems, MEZOA)));
    const again = (await api(ctx, admin, "GET", "/api/meta")).json;
    assert.equal(again.occupation_applied_turn, 1);
    assert.equal(occupationLine(again.phase_log[again.phase_log.length - 1].notes), "Turn 1 occupation: already applied");
  } finally {
    await ctx.stop();
  }
});

function seedTurn(dataDir, meta) {
  fs.copyFileSync(BASELINE, path.join(dataDir, "systems.json"));
  fs.writeFileSync(path.join(dataDir, "meta.json"), JSON.stringify(meta, null, 2));
  fs.writeFileSync(
    path.join(dataDir, "forces.json"),
    JSON.stringify([
      {
        force_id: 1,
        player_id: 1,
        force_name: "Lone Loyal",
        allegiance: "Loyalist",
        status: "active",
        strength: 3,
        sys_id: AEOLUS
      },
      {
        force_id: 2,
        player_id: 2,
        force_name: "Lone Traitor",
        allegiance: "Traitor",
        status: "active",
        strength: 3,
        sys_id: MEZOA
      }
    ])
  );
}

test("an older save with no marker grants the current turn only, and a recorded turn is skipped", async () => {
  const unmarkedDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-occupy-old-"));
  seedTurn(unmarkedDir, {
    campaign_name: "Sunset Heresy",
    turn: 4,
    phase: "Battles",
    loyal_score: 3,
    traitor_score: 3,
    player_actions: {},
    phase_log: []
  });
  const unmarked = startServer({ dataDir: unmarkedDir });
  try {
    await unmarked.ready;
    const admin = await adminToken(unmarked);
    const ended = await api(unmarked, admin, "POST", "/api/campaign/advance", {});
    assert.equal(ended.status, 200, JSON.stringify(ended.json));
    assert.equal(ended.json.to.turn, 5);
    assert.equal(occupationLine(ended.json.log), "Turn 4 occupation: Aeolus Loyalist +1; Mezoa Traitor +1");
    const systems = (await api(unmarked, admin, "GET", "/api/systems")).json;
    assert.equal(systemById(systems, AEOLUS).sys_loyal, 5);
    assert.equal(systemById(systems, MEZOA).sys_traitor, 7);
    const meta = (await api(unmarked, admin, "GET", "/api/meta")).json;
    assert.equal(meta.occupation_applied_turn, 4);
    assert.equal(meta.loyal_score, 3 + 12);
    assert.equal(meta.traitor_score, 3 + 10);

    assert.equal((await api(unmarked, admin, "POST", "/api/campaign/set-phase", { phase: "Battles", turn: 4 })).status, 200);
    const again = await api(unmarked, admin, "POST", "/api/campaign/advance", {});
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(occupationLine(again.json.log), "Turn 4 occupation: already applied");
    const still = (await api(unmarked, admin, "GET", "/api/systems")).json;
    assert.equal(systemById(still, AEOLUS).sys_loyal, 5);
    assert.equal(systemById(still, MEZOA).sys_traitor, 7);
  } finally {
    await unmarked.stop();
  }

  const markedDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-occupy-marked-"));
  seedTurn(markedDir, {
    campaign_name: "Sunset Heresy",
    turn: 2,
    phase: "Battles",
    loyal_score: 0,
    traitor_score: 0,
    occupation_applied_turn: 2,
    player_actions: {},
    phase_log: []
  });
  const marked = startServer({ dataDir: markedDir });
  try {
    await marked.ready;
    const admin = await adminToken(marked);
    const ended = await api(marked, admin, "POST", "/api/campaign/advance", {});
    assert.equal(ended.status, 200, JSON.stringify(ended.json));
    assert.equal(occupationLine(ended.json.log), "Turn 2 occupation: already applied");
    const systems = (await api(marked, admin, "GET", "/api/systems")).json;
    assert.equal(systemById(systems, AEOLUS).sys_loyal, 4);
    assert.equal(systemById(systems, MEZOA).sys_traitor, 6);
    assert.equal((await api(marked, admin, "GET", "/api/meta")).json.occupation_applied_turn, 2);
  } finally {
    await marked.stop();
  }
});
