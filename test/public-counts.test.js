"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const ADMIN_PW = "test-admin-pw-123";
const PRIVATE_KEYS = [
  "player_name",
  "contact",
  "notes",
  "allies",
  "email",
  "login",
  "password",
  "pass_hash",
  "pass_salt",
  "invite_code",
  "signup_invite",
  "discord_user_id",
  "token",
  "realName"
];

function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-counts-"));
  const port = 42000 + Math.floor(Math.random() * 20000);
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
      AUTO_ADVANCE_INTERVAL_MS: "60000",
      SEED_SAMPLE_CAMPAIGN: "0"
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
  return { status: res.status, json, text, headers: res.headers };
}

function assertNoStore(headers) {
  const cache = headers.get("cache-control") || "";
  assert.match(cache, /no-store/);
  assert.doesNotMatch(cache, /max-age/);
}

function assertNoPrivate(text, label) {
  assert.equal(text.includes("Real Name"), false, label + " leaked a real name");
  assert.equal(text.includes("@example.invalid"), false, label + " leaked an email");
  assert.equal(text.includes("secret-note"), false, label + " leaked notes");
  assert.equal(text.includes("hidden-allies"), false, label + " leaked allies");
  assert.equal(text.includes("pass_hash"), false, label);
  assert.equal(text.includes("pass_salt"), false, label);
  for (const key of PRIVATE_KEYS) {
    assert.equal(text.includes('"' + key + '"'), false, label + " included " + key);
  }
}

function statNumbers(html) {
  const start = html.indexOf('id="stats"');
  const end = html.indexOf('id="score-panel"');
  assert.ok(start > 0 && end > start);
  const block = html.slice(start, end);
  return [...block.matchAll(/class="num"[^>]*>([^<]*)</g)].map((match) => match[1].trim());
}

test("public counts follow the admin active filters and are not the sample or a cache", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "baseline", "systems.json"), "utf8"));

    const empty = await api(ctx, null, "GET", "/api/public/counts");
    assert.equal(empty.status, 200, empty.text);
    assertNoStore(empty.headers);
    assert.deepEqual(Object.keys(empty.json).sort(), ["battles", "forces", "players", "systems"]);
    assert.deepEqual(empty.json, { players: 0, forces: 0, systems: baseline.length, battles: 0 });
    assert.equal(baseline.length, 13);

    const emptyPage = await api(ctx, null, "GET", "/");
    assert.equal(emptyPage.status, 200);
    assertNoStore(emptyPage.headers);
    assert.deepEqual(statNumbers(emptyPage.text), ["0", "13", "0", "0"]);
    assert.equal(emptyPage.text.includes("The Warsmith"), false);
    assert.doesNotMatch(emptyPage.text, /id="count-players">1</);

    const login = await api(ctx, null, "POST", "/api/auth/login", { login: "admin", password: ADMIN_PW });
    assert.equal(login.status, 200, login.text);
    const admin = login.json.token;
    const issued = await api(ctx, admin, "POST", "/api/auth/invites", { note: "wave", max_uses: 20 });
    assert.equal(issued.status, 201, issued.text);
    const code = issued.json.invite.code;
    assert.ok(code);

    async function signup(n) {
      const side = n % 2 === 0 ? "Traitor" : "Loyalist";
      const res = await api(ctx, null, "POST", "/api/auth/signup", {
        invite_code: code,
        login: "player" + n,
        password: "botpass-xyz",
        player_name: "Real Name " + n,
        display_name: "Commander " + n,
        allegiance: side,
        contact: "player" + n + "@example.invalid",
        notes: "secret-note " + n,
        start_sys_id: side === "Loyalist" ? 2 : 4
      });
      assert.equal(res.status, 201, res.text);
      return res.json;
    }

    for (let n = 1; n <= 12; n++) await signup(n);

    const live = await api(ctx, null, "GET", "/api/public/counts");
    assert.equal(live.status, 200, live.text);
    assertNoStore(live.headers);
    assert.deepEqual(live.json, { players: 12, forces: 24, systems: 13, battles: 0 });
    assertNoPrivate(live.text, "counts");
    assert.equal(live.text.includes(code), false);

    const page = await api(ctx, null, "GET", "/");
    assertNoStore(page.headers);
    assert.deepEqual(statNumbers(page.text), ["12", "13", "24", "0"]);
    assertNoPrivate(page.text, "dashboard html");
    assert.equal(page.text.includes(code), false);
    assert.equal(page.text.includes("The Warsmith"), false);

    const pubPlayers = await api(ctx, null, "GET", "/api/public/players");
    const pubForces = await api(ctx, null, "GET", "/api/public/forces");
    assert.equal(pubPlayers.status, 200);
    assert.equal(pubForces.status, 200);
    assert.equal(pubPlayers.json.length, 12);
    assert.equal(pubForces.json.length, 24);
    assert.equal(pubPlayers.json.filter((row) => row.status === "active").length, 12);
    assert.ok(pubPlayers.json.some((row) => row.display_name === "Commander 1"));
    assertNoPrivate(pubPlayers.text, "public players");
    assertNoPrivate(pubForces.text, "public forces");
    assert.equal(pubPlayers.text.includes(code), false);
    assert.equal(pubForces.text.includes(code), false);

    const adminPlayers = await api(ctx, admin, "GET", "/api/players");
    assert.equal(adminPlayers.json.filter((row) => row.status === "active").length, 12);
    assert.equal(adminPlayers.json.some((row) => row.player_name === "Real Name 1"), true);

    const thirteenth = await signup(13);
    const afterJoin = await api(ctx, null, "GET", "/api/public/counts");
    assertNoStore(afterJoin.headers);
    assert.deepEqual(afterJoin.json, { players: 13, forces: 26, systems: 13, battles: 0 });
    const afterPage = await api(ctx, null, "GET", "/");
    assert.deepEqual(statNumbers(afterPage.text), ["13", "13", "26", "0"]);

    const added = await api(ctx, admin, "POST", "/api/players", {
      player_name: "Real Name admin-made",
      display_name: "Added By Admin",
      allegiance: "Loyalist",
      status: "active",
      contact: "admin-made@example.invalid",
      notes: "secret-note admin"
    });
    assert.equal(added.status, 201, added.text);
    const withAdminMade = await api(ctx, null, "GET", "/api/public/counts");
    assert.equal(withAdminMade.json.players, 14);
    assert.equal(withAdminMade.json.forces, 26);

    assert.equal((await api(ctx, admin, "PUT", "/api/players/" + added.json.player_id, { status: "waitlist" })).status, 200);
    assert.equal((await api(ctx, admin, "PUT", "/api/players/" + thirteenth.player_id, { status: "inactive" })).status, 200);
    const retired = await api(ctx, admin, "POST", "/api/players", {
      player_name: "Real Name retired",
      display_name: "Retired Commander",
      allegiance: "Traitor",
      status: "retired",
      contact: "retired@example.invalid",
      notes: "secret-note retired"
    });
    assert.equal(retired.status, 201, retired.text);

    const forces = (await api(ctx, admin, "GET", "/api/forces")).json;
    const activeForces = forces.filter((force) => force.status === "active");
    assert.ok(activeForces.length >= 4);
    const dropped = ["destroyed", "removed", "retired", "eliminated"];
    const droppedIds = new Set();
    for (let i = 0; i < dropped.length; i++) {
      const force = activeForces[i];
      droppedIds.add(force.force_id);
      const saved = await api(ctx, admin, "PUT", "/api/forces/" + force.force_id, {
        status: dropped[i],
        notes: "secret-note force",
        allies: "hidden-allies"
      });
      assert.equal(saved.status, 200, saved.text);
    }

    const filtered = await api(ctx, null, "GET", "/api/public/counts");
    assert.deepEqual(filtered.json, { players: 12, forces: 22, systems: 13, battles: 0 });
    const stillListed = await api(ctx, null, "GET", "/api/public/players");
    assert.ok(stillListed.json.length > filtered.json.players);
    assert.equal(stillListed.json.some((row) => row.display_name === "Retired Commander"), true);
    assert.equal(stillListed.json.find((row) => row.display_name === "Retired Commander").status, "retired");
    const hiddenForce = await api(ctx, null, "GET", "/api/public/forces");
    assert.equal(hiddenForce.json.some((force) => force.status === "eliminated"), true);
    assert.equal(hiddenForce.text.includes("hidden-allies"), false);
    assert.equal(hiddenForce.text.includes("secret-note"), false);
    assertNoPrivate(filtered.text, "filtered counts");

    const loyal = activeForces.find((force) => force.allegiance === "Loyalist" && !droppedIds.has(force.force_id));
    const traitor = activeForces.find((force) => force.allegiance === "Traitor" && !droppedIds.has(force.force_id));
    assert.ok(loyal && traitor);
    assert.equal((await api(ctx, admin, "POST", "/api/campaign/set-phase", { phase: "Battles" })).status, 200);
    const battle = await api(ctx, admin, "POST", "/api/games", {
      attacker_id: loyal.player_id,
      defender_id: traitor.player_id,
      attacker_force_id: loyal.force_id,
      defender_force_id: traitor.force_id,
      sys_id: loyal.sys_id,
      result: "in_progress",
      notes: "secret-note battle"
    });
    assert.equal(battle.status, 201, battle.text);
    const withBattle = await api(ctx, null, "GET", "/api/public/counts");
    assert.equal(withBattle.json.battles, 1);
    assert.equal(withBattle.json.players, 12);
    assert.equal(withBattle.text.includes("secret-note"), false);
    const battledPage = await api(ctx, null, "GET", "/");
    assert.deepEqual(statNumbers(battledPage.text), ["12", "13", "22", "1"]);
  } finally {
    await ctx.stop();
  }
});

test("the dashboard source no longer bakes in the sample campaign counts", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.match(html, /id="count-players">—</);
  assert.match(html, /id="count-systems">—</);
  assert.match(html, /id="count-forces">—</);
  assert.match(html, /id="count-battles"/);
  assert.doesNotMatch(html, /<div class="num">1<\/div><div class="label">Players<\/div>/);
  assert.match(html, /loadPublic\("counts"\)/);
  assert.match(html, /\/api\/public\/" \+ name/);
  assert.match(html, /cache:\s*"no-store"/);
  assert.match(html, /data-role="logged-in"/);
  assert.match(html, /SH\.role === "campaign_admin" \|\| SH\.role === "player"\) \? "player_admin\.html"/);
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  assert.match(server, /function publicCounts\(/);
  assert.match(server, /row\.status === "active"/);
});
