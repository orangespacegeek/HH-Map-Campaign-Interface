"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const ADMIN_PW = "test-admin-pw-123";
const AEOLUS = 2;
const MARINAS = 3;

function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-fortify-"));
  const port = 28000 + Math.floor(Math.random() * 20000);
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

async function adminToken(ctx) {
  const res = await api(ctx, null, "POST", "/api/auth/login", { login: "admin", password: ADMIN_PW });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json.token;
}

async function inviteAndSignup(ctx, admin, name, allegiance, start) {
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

function durability(systems, sysId) {
  const sys = systems.find((s) => Number(s.sys_id) === sysId);
  assert.ok(sys, "missing system " + sysId);
  return Number(sys.sys_durability);
}

test("fortify requires the player's own active force, and admin may skip that check", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const admin = await adminToken(ctx);
    const loyal = await inviteAndSignup(ctx, admin, "fort_loyal", "Loyalist", AEOLUS);
    const traitor = await inviteAndSignup(ctx, admin, "fort_traitor", "Traitor", 4);
    assert.equal((await api(ctx, admin, "POST", "/api/campaign/reset", { confirm: "RESET" })).status, 200);
    assert.equal((await api(ctx, admin, "POST", "/api/campaign/begin", {})).status, 200);

    const forces = (await api(ctx, admin, "GET", "/api/forces")).json;
    const loyalForces = forces.filter((f) => f.player_id === loyal.player_id);
    const traitorForce = forces.find((f) => f.player_id === traitor.player_id);
    assert.equal(loyalForces.length, 2);
    assert.ok(loyalForces.every((f) => Number(f.sys_id) === AEOLUS && f.status === "active"));

    const absent = await api(ctx, loyal.token, "POST", "/api/actions/fortify", { sys_id: MARINAS });
    assert.equal(absent.status, 400, JSON.stringify(absent.json));
    assert.match(absent.json.error, /active force/);
    assert.equal(durability((await api(ctx, admin, "GET", "/api/systems")).json, MARINAS), 5);

    assert.equal(
      (await api(ctx, admin, "PUT", "/api/forces/" + traitorForce.force_id, { sys_id: MARINAS })).status,
      200
    );
    const opposed = await api(ctx, loyal.token, "POST", "/api/actions/fortify", { sys_id: MARINAS });
    assert.equal(opposed.status, 400, JSON.stringify(opposed.json));
    assert.match(opposed.json.error, /active force/);

    const present = await api(ctx, loyal.token, "POST", "/api/actions/fortify", { sys_id: AEOLUS });
    assert.equal(present.status, 200, JSON.stringify(present.json));
    assert.equal(present.json.system.sys_durability, 6);

    for (const force of loyalForces) {
      const destroyed = await api(ctx, admin, "PUT", "/api/forces/" + force.force_id, { status: "destroyed" });
      assert.equal(destroyed.status, 200, JSON.stringify(destroyed.json));
    }
    const inactive = await api(ctx, loyal.token, "POST", "/api/actions/fortify", { sys_id: AEOLUS });
    assert.equal(inactive.status, 400, JSON.stringify(inactive.json));
    assert.match(inactive.json.error, /active force/);
    assert.equal(durability((await api(ctx, admin, "GET", "/api/systems")).json, AEOLUS), 6);

    const override = await api(ctx, admin, "POST", "/api/actions/fortify", {
      sys_id: MARINAS,
      player_id: loyal.player_id,
      spend: false
    });
    assert.equal(override.status, 200, JSON.stringify(override.json));
    assert.equal(override.json.system.sys_durability, 6);
  } finally {
    await ctx.stop();
  }
});

test("fortify rules name the own-force requirement and the map disables it", () => {
  const rulesMd = fs.readFileSync(path.join(ROOT, "campaign_rules.md"), "utf8");
  const rulesHtml = fs.readFileSync(path.join(ROOT, "rules.html"), "utf8");
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const map = fs.readFileSync(path.join(ROOT, "js/map.js"), "utf8");

  assert.match(
    rulesMd,
    /Fortify:[\s\S]*own active Forces present in that system \(added as part of web app build\)/
  );
  assert.match(
    rulesHtml,
    /name">Fortify<\/div>[\s\S]*own active Forces in the system\./
  );
  assert.doesNotMatch(rulesHtml, /added as part of web app build/);
  assert.match(server, /campaign_rules\.md \(Logistics\): Fortify requires one of the acting player's own/);
  assert.match(server, /active forces in the system \(added as part of web app build\)/);
  assert.match(server, /if \(!present && auth\.account\.role !== "campaign_admin"\)/);
  assert.doesNotMatch(server, /judgment call|sensible; rules imply/);
  assert.match(map, /isAdmin \? mine\.length : own\.length/);
  assert.match(map, /fortify\.disabled = true/);
  assert.match(map, /Fortify needs one of your active forces in this system/);
});
