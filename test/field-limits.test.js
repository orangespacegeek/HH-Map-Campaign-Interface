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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-limits-"));
  const port = 27000 + Math.floor(Math.random() * 20000);
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

test("free-text fields are trimmed and rejected when over the cap", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const adminLogin = await api(ctx, null, "POST", "/api/auth/login", { login: "admin", password: ADMIN_PW });
    assert.equal(adminLogin.status, 200, JSON.stringify(adminLogin.json));
    const admin = adminLogin.json.token;
    const inv = await api(ctx, admin, "POST", "/api/auth/invites", { note: "limits" });
    assert.equal(inv.status, 201, JSON.stringify(inv.json));
    const signup = await api(ctx, null, "POST", "/api/auth/signup", {
      invite_code: inv.json.invite.code,
      login: "limit_loyal",
      password: "botpass-xyz",
      player_name: "limit_loyal",
      display_name: "Limit Loyal",
      allegiance: "Loyalist",
      start_sys_id: 2
    });
    assert.equal(signup.status, 201, JSON.stringify(signup.json));
    const token = signup.json.token;
    const playerId = signup.json.player_id;
    assert.equal((await api(ctx, admin, "POST", "/api/campaign/reset", { confirm: "RESET" })).status, 200);

    const forces = (await api(ctx, token, "GET", "/api/forces")).json;
    const mine = forces.find((f) => f.player_id === playerId);
    assert.ok(mine, "player should see their own force");
    const id = mine.force_id;

    const padded = await api(ctx, token, "PUT", "/api/forces/" + id, {
      legion: "  " + "A".repeat(60) + "  ",
      warlord_name: "\n" + "B".repeat(60) + " "
    });
    assert.equal(padded.status, 200, JSON.stringify(padded.json));
    assert.equal(padded.json.legion, "A".repeat(60));
    assert.equal(padded.json.warlord_name, "B".repeat(60));

    const longLegion = await api(ctx, token, "PUT", "/api/forces/" + id, { legion: "A".repeat(61) });
    assert.equal(longLegion.status, 400);
    assert.match(longLegion.json.error, /Legion \/ faction must be at most 60/);
    const longWarlord = await api(ctx, admin, "PUT", "/api/forces/" + id, { warlord_name: "B".repeat(61) });
    assert.equal(longWarlord.status, 400);
    assert.match(longWarlord.json.error, /Warlord must be at most 60/);
    const kept = (await api(ctx, token, "GET", "/api/forces/" + id)).json;
    assert.equal(kept.legion, "A".repeat(60));
    assert.equal(kept.warlord_name, "B".repeat(60));

    const longName = await api(ctx, token, "PUT", "/api/forces/" + id, { force_name: "N".repeat(101) });
    assert.equal(longName.status, 400);
    assert.match(longName.json.error, /Force name must be at most 100/);
    const longNotes = await api(ctx, token, "PUT", "/api/forces/" + id, { notes: "n".repeat(501) });
    assert.equal(longNotes.status, 400);
    assert.match(longNotes.json.error, /Notes must be at most 500/);
    const longType = await api(ctx, token, "PUT", "/api/forces/" + id, { force_type: "T".repeat(41) });
    assert.equal(longType.status, 400);
    assert.match(longType.json.error, /Force type must be at most 40/);
    assert.equal((await api(ctx, token, "GET", "/api/forces/" + id)).json.force_name, mine.force_name);

    const beforeGen = (await api(ctx, token, "GET", "/api/forces")).json.length;
    const badGen = await api(ctx, token, "POST", "/api/actions/generate", {
      sys_id: 2,
      legion: "L".repeat(61),
      warlord_name: "W".repeat(60)
    });
    assert.equal(badGen.status, 400, JSON.stringify(badGen.json));
    assert.match(badGen.json.error, /Legion \/ faction/);
    assert.equal((await api(ctx, token, "GET", "/api/forces")).json.length, beforeGen);
    const status = await api(ctx, token, "GET", "/api/actions/status");
    assert.equal(status.json.actions_used, 0);

    const raised = await api(ctx, token, "POST", "/api/actions/generate", {
      sys_id: 2,
      force_name: "  " + "F".repeat(100) + "  ",
      legion: "L".repeat(60),
      warlord_name: "W".repeat(60)
    });
    assert.equal(raised.status, 201, JSON.stringify(raised.json));
    assert.equal(raised.json.force.force_name, "F".repeat(100));
    assert.equal(raised.json.force.legion, "L".repeat(60));

    const longGame = await api(ctx, admin, "POST", "/api/games", { notes: "g".repeat(501), mission: "Onslaught" });
    assert.equal(longGame.status, 400);
    assert.match(longGame.json.error, /Notes must be at most 500/);
    const longMission = await api(ctx, admin, "POST", "/api/games", { mission: "M".repeat(81) });
    assert.equal(longMission.status, 400);
    assert.match(longMission.json.error, /Mission must be at most 80/);
    assert.equal((await api(ctx, admin, "GET", "/api/games")).json.length, 0);

    const longDispute = await api(ctx, token, "POST", "/api/games/1/dispute", { note: "d".repeat(301) });
    assert.equal(longDispute.status, 400);
    assert.match(longDispute.json.error, /Dispute note must be at most 300/);

    const sysBefore = (await api(ctx, admin, "GET", "/api/systems/1")).json;
    const longSys = await api(ctx, admin, "PUT", "/api/systems/1", { sys_notes: "s".repeat(501) });
    assert.equal(longSys.status, 400);
    assert.match(longSys.json.error, /Notes must be at most 500/);
    assert.equal((await api(ctx, admin, "GET", "/api/systems/1")).json.sys_notes, sysBefore.sys_notes);
    const longLinks = await api(ctx, admin, "PUT", "/api/systems/1", { sys_links: "1,".repeat(120) });
    assert.equal(longLinks.status, 400);
    assert.match(longLinks.json.error, /Links must be at most 200/);

    const longDisplay = await api(ctx, token, "PUT", "/api/players/" + playerId, { display_name: "D".repeat(81) });
    assert.equal(longDisplay.status, 400);
    assert.match(longDisplay.json.error, /Display name must be at most 80/);
    const longAdminName = await api(ctx, admin, "PUT", "/api/players/" + playerId, { display_name: "D".repeat(81) });
    assert.equal(longAdminName.status, 400);
    assert.equal((await api(ctx, token, "GET", "/api/players/" + playerId)).json.display_name, "Limit Loyal");

    const longPassword = await api(ctx, token, "POST", "/api/auth/set-password", {
      password: "p".repeat(129),
      current_password: "botpass-xyz"
    });
    assert.equal(longPassword.status, 400);
    assert.match(longPassword.json.error, /at most 128/);
  } finally {
    await ctx.stop();
  }
});
