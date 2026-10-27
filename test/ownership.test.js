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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-own-"));
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
    start_sys_id: start,
    contact: name + "@example.invalid",
    notes: name + " private notes"
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { token: res.json.token, player_id: res.json.player_id, code: inv.json.invite.code };
}

test("players cannot read or change another player's private records", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const adminLogin = await api(ctx, null, "POST", "/api/auth/login", { login: "admin", password: ADMIN_PW });
    assert.equal(adminLogin.status, 200, JSON.stringify(adminLogin.json));
    const admin = adminLogin.json.token;
    const loyal = await signup(ctx, admin, "own_loyal", "Loyalist", 2);
    const traitor = await signup(ctx, admin, "own_traitor", "Traitor", 4);
    const bystander = await signup(ctx, admin, "own_bystander", "Loyalist", 3);
    assert.equal((await api(ctx, admin, "POST", "/api/campaign/reset", { confirm: "RESET" })).status, 200);
    assert.equal((await api(ctx, admin, "POST", "/api/campaign/begin", {})).status, 200);

    const adminForces = (await api(ctx, admin, "GET", "/api/forces")).json;
    const loyalForce = adminForces.find((f) => f.player_id === loyal.player_id);
    const traitorForce = adminForces.find((f) => f.player_id === traitor.player_id);
    assert.ok(loyalForce && traitorForce);
    assert.equal(
      (await api(ctx, admin, "PUT", "/api/forces/" + traitorForce.force_id, {
        notes: "traitor private plan",
        allies: "dark mechanicum",
        legion: "Sons of Horus"
      })).status,
      200
    );
    assert.equal(
      (await api(ctx, admin, "PUT", "/api/forces/" + loyalForce.force_id, { notes: "loyal private plan" })).status,
      200
    );

    const listed = (await api(ctx, loyal.token, "GET", "/api/forces")).json;
    const seenTraitor = listed.find((f) => f.force_id === traitorForce.force_id);
    const seenOwn = listed.find((f) => f.force_id === loyalForce.force_id);
    assert.equal(seenTraitor.legion, "Sons of Horus");
    assert.equal(seenTraitor.notes, undefined);
    assert.equal(seenTraitor.allies, undefined);
    assert.equal(seenOwn.notes, "loyal private plan");
    const one = await api(ctx, loyal.token, "GET", "/api/forces/" + traitorForce.force_id);
    assert.equal(one.status, 200);
    assert.equal(one.json.notes, undefined);
    assert.equal(one.json.allies, undefined);
    assert.equal((await api(ctx, admin, "GET", "/api/forces/" + traitorForce.force_id)).json.notes, "traitor private plan");

    const pub = (await api(ctx, null, "GET", "/api/public/forces")).json;
    assert.equal(pub.find((f) => f.force_id === traitorForce.force_id).notes, undefined);
    assert.equal((await api(ctx, null, "GET", "/api/forces")).status, 401);

    const edit = await api(ctx, loyal.token, "PUT", "/api/forces/" + traitorForce.force_id, { legion: "Stolen" });
    assert.equal(edit.status, 403);
    assert.match(edit.json.error, /Cannot edit this force/);
    const del = await api(ctx, loyal.token, "DELETE", "/api/forces/" + traitorForce.force_id);
    assert.equal(del.status, 403);
    assert.match(del.json.error, /Campaign admin only/);
    const ownDel = await api(ctx, loyal.token, "DELETE", "/api/forces/" + loyalForce.force_id);
    assert.equal(ownDel.status, 403);
    assert.equal((await api(ctx, admin, "GET", "/api/forces/" + traitorForce.force_id)).json.legion, "Sons of Horus");

    const reinforce = await api(ctx, loyal.token, "POST", "/api/actions/reinforce", { force_id: traitorForce.force_id });
    assert.equal(reinforce.status, 403);
    assert.match(reinforce.json.error, /Not your force/);

    const players = (await api(ctx, loyal.token, "GET", "/api/players")).json;
    const other = players.find((p) => p.player_id === traitor.player_id);
    const self = players.find((p) => p.player_id === loyal.player_id);
    assert.equal(other.notes, undefined);
    assert.equal(other.contact, undefined);
    assert.equal(other.player_name, undefined);
    assert.equal("invite_code" in other, false);
    assert.equal(self.notes, "own_loyal private notes");
    assert.equal(self.contact, "own_loyal@example.invalid");
    const otherOne = await api(ctx, loyal.token, "GET", "/api/players/" + traitor.player_id);
    assert.equal(otherOne.json.notes, undefined);
    assert.equal(otherOne.json.contact, undefined);
    const editPlayer = await api(ctx, loyal.token, "PUT", "/api/players/" + traitor.player_id, { display_name: "Renamed" });
    assert.equal(editPlayer.status, 403);
    assert.match(editPlayer.json.error, /Cannot edit this player/);

    const invites = await api(ctx, loyal.token, "GET", "/api/auth/invites");
    assert.equal(invites.status, 403);
    const me = await api(ctx, loyal.token, "GET", "/api/auth/me");
    assert.equal(me.json.signup_invite.code.replace(/-/g, ""), loyal.code.replace(/-/g, ""));
    assert.equal(JSON.stringify(me.json).replace(/-/g, "").includes(traitor.code.replace(/-/g, "")), false);
    assert.equal((await api(ctx, loyal.token, "GET", "/api/accounts")).status, 404);
    assert.equal((await api(ctx, loyal.token, "GET", "/api/admin/backup")).status, 403);

    await api(ctx, admin, "PUT", "/api/forces/" + loyalForce.force_id, { sys_id: 1 });
    await api(ctx, admin, "PUT", "/api/forces/" + traitorForce.force_id, { sys_id: 1 });
    assert.equal((await api(ctx, admin, "POST", "/api/campaign/set-phase", { phase: "Battles", turn: 1 })).status, 200);
    const game = await api(ctx, loyal.token, "POST", "/api/games", {
      attacker_id: loyal.player_id,
      defender_id: traitor.player_id,
      attacker_force_id: loyalForce.force_id,
      defender_force_id: traitorForce.force_id,
      sys_id: 1,
      result: "attacker_win",
      attacker_vp: 10,
      defender_vp: 5,
      notes: "fought at the docks"
    });
    assert.equal(game.status, 201, JSON.stringify(game.json));
    const gameId = game.json.game_id;
    const outsiderEdit = await api(ctx, bystander.token, "PUT", "/api/games/" + gameId, { notes: "tampered" });
    assert.equal(outsiderEdit.status, 403);
    const outsiderDispute = await api(ctx, bystander.token, "POST", "/api/games/" + gameId + "/dispute", { note: "nope" });
    assert.equal(outsiderDispute.status, 403);
    const outsiderDelete = await api(ctx, bystander.token, "DELETE", "/api/games/" + gameId);
    assert.equal(outsiderDelete.status, 403);
    assert.equal((await api(ctx, admin, "GET", "/api/games/" + gameId)).json.notes, "fought at the docks");

    const html = fs.readFileSync(path.join(ROOT, "forces.html"), "utf8");
    const drawerAt = html.indexOf("function openDrawer(force)");
    const drawer = html.slice(drawerAt, drawerAt + 400);
    assert.match(drawer, /SH\.canEditForce\(force\)/);
    assert.match(drawer, /Not your force/);
  } finally {
    await ctx.stop();
  }
});
