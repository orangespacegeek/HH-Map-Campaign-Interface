"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const ADMIN_PW = "test-admin-pw-123";
const PHASES = ["Logistics", "Movement", "Battles"];

function startServer(options = {}) {
  const dataDir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), "hh-auto-"));
  const port = 31000 + Math.floor(Math.random() * 20000);
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
      AUTO_ADVANCE_INTERVAL_MS: String(options.intervalMs == null ? 250 : options.intervalMs)
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

async function adminToken(ctx) {
  const login = await api(ctx, null, "POST", "/api/auth/login", { login: "admin", password: ADMIN_PW });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  return login.json.token;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function automaticEntries(meta) {
  return (meta.phase_log || []).filter((entry) => entry.automatic);
}

function assertOneStep(entry) {
  const from = PHASES.indexOf(entry.from.phase);
  const to = PHASES.indexOf(entry.to.phase);
  assert.ok(from >= 0 && to >= 0, JSON.stringify(entry));
  if (entry.from.phase === "Battles") {
    assert.equal(entry.to.phase, "Logistics");
    assert.equal(entry.to.turn, entry.from.turn + 1);
    return;
  }
  assert.equal(entry.to.turn, entry.from.turn);
  assert.equal(to, from + 1);
}

test("a deadline that passed while the server was down advances exactly once", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-auto-boot-"));
  fs.writeFileSync(
    path.join(dataDir, "players.json"),
    JSON.stringify([
      {
        player_id: 1,
        player_name: "boot_loyal",
        display_name: "boot_loyal",
        allegiance: "Loyalist",
        status: "active"
      },
      {
        player_id: 2,
        player_name: "boot_traitor",
        display_name: "boot_traitor",
        allegiance: "Traitor",
        status: "active"
      }
    ])
  );
  fs.writeFileSync(
    path.join(dataDir, "forces.json"),
    JSON.stringify([
      { force_id: 1, player_id: 1, force_name: "Boot Loyal I", allegiance: "Loyalist", status: "active", strength: 3, sys_id: 2, home_sys_id: 2 },
      { force_id: 2, player_id: 1, force_name: "Boot Loyal II", allegiance: "Loyalist", status: "active", strength: 3, sys_id: 2, home_sys_id: 2 },
      { force_id: 3, player_id: 2, force_name: "Boot Traitor I", allegiance: "Traitor", status: "active", strength: 3, sys_id: 4, home_sys_id: 4 },
      { force_id: 4, player_id: 2, force_name: "Boot Traitor II", allegiance: "Traitor", status: "active", strength: 3, sys_id: 4, home_sys_id: 4 }
    ])
  );
  fs.writeFileSync(
    path.join(dataDir, "meta.json"),
    JSON.stringify({
      campaign_name: "Sunset Heresy",
      turn: 1,
      phase: "Logistics",
      loyal_score: 0,
      traitor_score: 0,
      phase_ends_at: "2020-01-01T00:00:00.000Z",
      auto_advance_when_done: true,
      player_actions: { "1": { turn: 1, used: 2, log: [] } },
      phase_log: [],
      victor: null
    })
  );
  const ctx = startServer({ dataDir });
  try {
    await ctx.ready;
    const admin = await adminToken(ctx);
    const meta = (await api(ctx, admin, "GET", "/api/meta")).json;
    assert.equal(meta.phase, "Movement");
    assert.equal(meta.turn, 1);
    assert.equal(meta.phase_ends_at, null);
    assert.equal(meta.auto_advance_blocked, null);
    const autos = automaticEntries(meta);
    assert.equal(autos.length, 1);
    assert.equal(autos[0].reason, "deadline");
    assert.equal(autos[0].from.phase, "Logistics");
    assert.equal(autos[0].to.phase, "Movement");
    assert.match(autos[0].notes[0], /Automatic advance: the phase deadline passed/);
    assertOneStep(autos[0]);

    const notes = JSON.parse(fs.readFileSync(path.join(dataDir, "notifications.json"), "utf8"));
    const note = notes.find((row) => row.kind === "phase_advanced" && row.player_id === 1);
    assert.ok(note, JSON.stringify(notes));
    assert.equal(note.audience, "player");
    assert.match(note.text, /advanced automatically from Logistics to Movement \(turn 1\)/);
    assert.match(note.text, /because the phase deadline passed/);
    assert.equal(note.ref.automatic, true);
    assert.equal(note.ref.reason, "deadline");

    await sleep(900);
    const later = (await api(ctx, admin, "GET", "/api/meta")).json;
    assert.equal(later.phase, "Movement");
    assert.equal(later.turn, 1);
    assert.equal(automaticEntries(later).length, 1);

    const again = await api(ctx, admin, "POST", "/api/campaign/phase-deadline", {
      phase_ends_at: "2020-01-01T00:00:00.000Z"
    });
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(again.json.advanced, true);
    assert.equal(again.json.phase, "Battles");
    assert.equal(again.json.turn, 1);
    assert.equal(again.json.phase_ends_at, null);
    const second = (await api(ctx, admin, "GET", "/api/meta")).json;
    const secondAutos = automaticEntries(second);
    assert.equal(secondAutos.length, 2);
    assert.equal(secondAutos[1].reason, "deadline");
    assert.equal(secondAutos[1].from.phase, "Movement");
    assert.equal(secondAutos[1].to.phase, "Battles");
    assertOneStep(secondAutos[1]);
    await sleep(900);
    const stayed = (await api(ctx, admin, "GET", "/api/meta")).json;
    assert.equal(stayed.phase, "Battles");
    assert.equal(stayed.turn, 1);
    assert.equal(automaticEntries(stayed).length, 2);
  } finally {
    await ctx.stop();
  }
});

test("Logistics advances once when every counted player is out of actions", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const admin = await adminToken(ctx);
    const loyal = await signup(ctx, admin, "done_loyal", "Loyalist", 2);
    assert.equal((await api(ctx, admin, "POST", "/api/campaign/reset", { confirm: "RESET" })).status, 200);
    assert.equal((await api(ctx, admin, "POST", "/api/campaign/begin", {})).status, 200);
    const fresh = await api(ctx, null, "GET", "/api/campaign/status");
    assert.equal(fresh.json.phase, "Logistics");
    assert.equal(fresh.json.auto_advance_when_done, true);

    const off = await api(ctx, admin, "POST", "/api/campaign/auto-advance", { enabled: false });
    assert.equal(off.status, 200, JSON.stringify(off.json));
    assert.equal(off.json.auto_advance_when_done, false);
    assert.equal(off.json.advanced, false);

    assert.equal((await api(ctx, loyal.token, "POST", "/api/actions/fortify", { sys_id: 2 })).status, 200);
    assert.equal((await api(ctx, loyal.token, "POST", "/api/actions/fortify", { sys_id: 2 })).status, 200);
    const waiting = await api(ctx, admin, "GET", "/api/actions/players");
    assert.equal(waiting.json.ready_to_advance, true);
    const held = (await api(ctx, admin, "GET", "/api/meta")).json;
    assert.equal(held.phase, "Logistics");
    assert.equal(automaticEntries(held).length, 0);

    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const scheduled = await api(ctx, admin, "POST", "/api/campaign/phase-deadline", { phase_ends_at: future });
    assert.equal(scheduled.status, 200, JSON.stringify(scheduled.json));
    assert.equal(scheduled.json.advanced, false);
    assert.equal(scheduled.json.phase, "Logistics");
    assert.ok(scheduled.json.phase_ends_at);

    const on = await api(ctx, admin, "POST", "/api/campaign/auto-advance", { enabled: true });
    assert.equal(on.status, 200, JSON.stringify(on.json));
    assert.equal(on.json.advanced, true);
    assert.equal(on.json.phase, "Movement");
    assert.equal(on.json.turn, 1);

    const meta = (await api(ctx, admin, "GET", "/api/meta")).json;
    assert.equal(meta.phase_ends_at, null);
    const autos = automaticEntries(meta);
    assert.equal(autos.length, 1);
    assert.equal(autos[0].reason, "all_actions_done");
    assert.match(autos[0].notes[0], /every counted player is out of actions/);
    assertOneStep(autos[0]);

    const inbox = await api(ctx, loyal.token, "GET", "/api/inbox");
    const note = inbox.json.notifications.find((row) => row.kind === "phase_advanced");
    assert.ok(note, JSON.stringify(inbox.json.notifications));
    assert.match(note.text, /advanced automatically from Logistics to Movement \(turn 1\)/);
    assert.match(note.text, /because every counted player is out of actions/);
    assert.equal(note.ref.reason, "all_actions_done");

    const stillReady = await api(ctx, admin, "GET", "/api/actions/players");
    assert.equal(stillReady.json.ready_to_advance, true);
    assert.equal(stillReady.json.phase, "Movement");
    await sleep(900);
    const stayed = (await api(ctx, admin, "GET", "/api/meta")).json;
    assert.equal(stayed.phase, "Movement");
    assert.equal(stayed.turn, 1);
    assert.equal(automaticEntries(stayed).length, 1);
  } finally {
    await ctx.stop();
  }
});

test("open battles block auto-advance without voiding, then a later check advances once", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const admin = await adminToken(ctx);
    const loyal = await signup(ctx, admin, "block_loyal", "Loyalist", 2);
    const traitor = await signup(ctx, admin, "block_traitor", "Traitor", 4);
    assert.equal((await api(ctx, admin, "POST", "/api/campaign/reset", { confirm: "RESET" })).status, 200);
    const jumped = await api(ctx, admin, "POST", "/api/campaign/set-phase", { phase: "Battles" });
    assert.equal(jumped.status, 200, JSON.stringify(jumped.json));

    const game = await api(ctx, admin, "POST", "/api/games", {
      attacker_id: loyal.player_id,
      defender_id: traitor.player_id,
      sys_id: 1,
      result: "in_progress"
    });
    assert.equal(game.status, 201, JSON.stringify(game.json));
    assert.equal(game.json.result_state, "open");

    const blocked = await api(ctx, admin, "POST", "/api/campaign/phase-deadline", {
      phase_ends_at: "2020-01-01T00:00:00.000Z"
    });
    assert.equal(blocked.status, 200, JSON.stringify(blocked.json));
    assert.equal(blocked.json.advanced, false);
    assert.equal(blocked.json.phase, "Battles");
    assert.equal(blocked.json.turn, 1);
    assert.ok(blocked.json.phase_ends_at);
    const flagged = "Auto-advance blocked: 1 open battles. No report, pending admin confirmation: Battle #" +
      game.json.game_id + ". Confirm or reject them on the Actions page.";
    assert.equal(blocked.json.auto_advance_blocked.message, flagged);
    assert.deepEqual(blocked.json.auto_advance_blocked.no_report, [game.json.game_id]);

    await sleep(600);
    const still = await api(ctx, admin, "GET", "/api/games/" + game.json.game_id);
    assert.equal(still.json.result, "no_report");
    assert.equal(still.json.result_state, "pending");
    assert.equal(still.json.resolution, null);
    assert.equal(still.json.voided_at, undefined);
    const mid = (await api(ctx, admin, "GET", "/api/meta")).json;
    assert.equal(mid.phase, "Battles");
    assert.equal(mid.turn, 1);
    assert.ok(mid.phase_ends_at);
    assert.equal(mid.auto_advance_blocked.message, flagged);
    assert.equal(automaticEntries(mid).length, 0);

    assert.equal((await api(ctx, admin, "DELETE", "/api/games/" + game.json.game_id)).status, 200);
    let advanced = null;
    for (let i = 0; i < 20; i++) {
      const status = await api(ctx, null, "GET", "/api/campaign/status");
      if (status.json.phase === "Logistics" && status.json.turn === 2) {
        advanced = status.json;
        break;
      }
      await sleep(100);
    }
    assert.ok(advanced, "auto-advance did not retry after the battle was removed");
    assert.equal(advanced.phase_ends_at, null);
    assert.equal(advanced.auto_advance_blocked, null);

    const meta = (await api(ctx, admin, "GET", "/api/meta")).json;
    const autos = automaticEntries(meta);
    assert.equal(autos.length, 1);
    assert.equal(autos[0].reason, "deadline");
    assert.equal(autos[0].from.phase, "Battles");
    assert.equal(autos[0].from.turn, 1);
    assert.equal(autos[0].to.phase, "Logistics");
    assert.equal(autos[0].to.turn, 2);
    assert.match(autos[0].notes.join(" "), /Automatic advance: the phase deadline passed/);
    assert.doesNotMatch(autos[0].notes.join(" "), /Voided/);
    assertOneStep(autos[0]);

    const inbox = await api(ctx, loyal.token, "GET", "/api/inbox");
    const note = inbox.json.notifications.find((row) => row.kind === "phase_advanced" && row.ref && row.ref.automatic);
    assert.ok(note, JSON.stringify(inbox.json.notifications));
    assert.match(note.text, /from Battles \(turn 1\) to Logistics \(turn 2\)/);
    assert.match(note.text, /because the phase deadline passed/);

    await sleep(700);
    const stayed = await api(ctx, null, "GET", "/api/campaign/status");
    assert.equal(stayed.json.phase, "Logistics");
    assert.equal(stayed.json.turn, 2);
  } finally {
    await ctx.stop();
  }
});

test("deadline edits stay admin-only, and clearing the deadline leaves the phase alone", async () => {
  const ctx = startServer({ intervalMs: 60000 });
  try {
    await ctx.ready;
    assert.equal((await api(ctx, null, "POST", "/api/campaign/phase-deadline", { phase_ends_at: null })).status, 401);
    assert.equal((await api(ctx, null, "POST", "/api/campaign/auto-advance", { enabled: false })).status, 401);

    const admin = await adminToken(ctx);
    const loyal = await signup(ctx, admin, "dead_loyal", "Loyalist", 2);
    await signup(ctx, admin, "dead_traitor", "Traitor", 4);
    assert.equal((await api(ctx, admin, "POST", "/api/campaign/reset", { confirm: "RESET" })).status, 200);
    assert.equal((await api(ctx, admin, "POST", "/api/campaign/begin", {})).status, 200);
    assert.equal((await api(ctx, loyal.token, "POST", "/api/campaign/phase-deadline", { phase_ends_at: null })).status, 403);
    assert.equal((await api(ctx, loyal.token, "POST", "/api/campaign/auto-advance", { enabled: false })).status, 403);

    assert.equal((await api(ctx, admin, "POST", "/api/campaign/phase-deadline", {})).status, 400);
    assert.equal(
      (await api(ctx, admin, "POST", "/api/campaign/phase-deadline", { phase_ends_at: "tomorrow" })).status,
      400
    );
    assert.equal(
      (await api(ctx, admin, "POST", "/api/campaign/phase-deadline", { phase_ends_at: 5 })).status,
      400
    );
    assert.equal((await api(ctx, admin, "POST", "/api/campaign/auto-advance", { enabled: "yes" })).status, 400);

    const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const set = await api(ctx, admin, "POST", "/api/campaign/phase-deadline", { phase_ends_at: future });
    assert.equal(set.status, 200, JSON.stringify(set.json));
    assert.equal(set.json.advanced, false);
    assert.equal(set.json.phase, "Logistics");
    assert.equal(set.json.phase_ends_at, new Date(future).toISOString());

    const moved = await api(ctx, admin, "POST", "/api/campaign/set-phase", { phase: "Movement" });
    assert.equal(moved.status, 200, JSON.stringify(moved.json));
    const kept = (await api(ctx, null, "GET", "/api/campaign/status")).json;
    assert.equal(kept.phase, "Movement");
    assert.equal(kept.phase_ends_at, new Date(future).toISOString());
    assert.equal(kept.auto_advance_when_done, true);

    assert.equal((await api(ctx, admin, "POST", "/api/campaign/set-phase", { phase: "Logistics" })).status, 200);
    const cleared = await api(ctx, admin, "POST", "/api/campaign/phase-deadline", { phase_ends_at: null });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
    assert.equal(cleared.json.advanced, false);
    assert.equal(cleared.json.phase_ends_at, null);
    assert.equal(cleared.json.phase, "Logistics");

    const off = await api(ctx, admin, "POST", "/api/campaign/auto-advance", { enabled: false });
    assert.equal(off.json.advanced, false);
    const past = await api(ctx, admin, "POST", "/api/campaign/phase-deadline", {
      phase_ends_at: "2020-06-01T00:00:00.000Z"
    });
    assert.equal(past.status, 200, JSON.stringify(past.json));
    assert.equal(past.json.advanced, true);
    assert.equal(past.json.phase, "Movement");
    assert.equal(past.json.phase_ends_at, null);
    const afterDeadline = (await api(ctx, admin, "GET", "/api/meta")).json;
    assert.equal(automaticEntries(afterDeadline).length, 1);
    assert.equal(automaticEntries(afterDeadline)[0].reason, "deadline");

    const manual = await api(ctx, admin, "POST", "/api/campaign/advance", {});
    assert.equal(manual.status, 200, JSON.stringify(manual.json));
    assert.equal(manual.json.to.phase, "Battles");
    assert.equal(manual.json.to.turn, 1);
    assert.equal(manual.json.meta.phase_ends_at, null);
    const manualEntry = manual.json.meta.phase_log[manual.json.meta.phase_log.length - 1];
    assert.equal(manualEntry.automatic, false);
    assert.equal(manualEntry.reason, null);
    assertOneStep(manualEntry);

    const inbox = await api(ctx, loyal.token, "GET", "/api/inbox");
    const hand = inbox.json.notifications.find((row) => row.kind === "phase_advanced" && row.ref && !row.ref.automatic);
    assert.ok(hand, JSON.stringify(inbox.json.notifications));
    assert.match(hand.text, /The campaign advanced from Movement to Battles \(turn 1\)\./);
    assert.doesNotMatch(hand.text, /automatically/);
  } finally {
    await ctx.stop();
  }
});

test("the dashboard links stat cards and explains the deadline without auto-voiding", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const gridAt = html.indexOf('<div class="grid">');
  assert.ok(gridAt > 0);
  const grid = html.slice(gridAt, html.indexOf("Recent battles", gridAt));
  assert.match(grid, /href="campaign_map.html"/);
  assert.match(grid, /href="rules.html"/);
  assert.doesNotMatch(grid, /href="player_admin.html"/);
  assert.doesNotMatch(grid, /href="forces.html"/);
  assert.doesNotMatch(grid, /href="systems.html"/);
  assert.doesNotMatch(grid, /href="games.html"/);
  assert.doesNotMatch(grid, /Battle Log/);
  assert.match(html, /id="phase-deadline"/);
  assert.match(html, /Phase deadline passed/);
  assert.match(html, /id="auto-advance-blocked"/);
  assert.match(html, /id="auto-advance-done"/);
  assert.match(html, /Auto-advance when all players are done/);
  assert.match(html, /Open battles are not voided/);
  assert.doesNotMatch(html, /Setting a deadline does not advance the phase/);
  assert.match(html, /SH\.role === "campaign_admin" \? "player_admin\.html"/);
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  assert.match(server, /force: false/);
  assert.match(server, /auto_advance_when_done !== false/);
});
