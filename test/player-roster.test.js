"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const ADMIN_PW = "test-admin-pw-123";
const PRIVATE_PLAYER_KEYS = [
  "player_name",
  "contact",
  "notes",
  "discord_user_id",
  "invite_code",
  "pass_hash",
  "pass_salt",
  "login",
  "password",
  "token",
  "email",
  "signup_invite"
];

function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-roster-"));
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
  return { status: res.status, json, text };
}

function sliceFunction(source, name) {
  const start = source.indexOf("function " + name);
  assert.notEqual(start, -1, name);
  const nextFn = source.indexOf("\n    function ", start + 10);
  const nextStmt = source.indexOf("\n    document.", start + 10);
  let end = source.length;
  if (nextFn !== -1) end = Math.min(end, nextFn);
  if (nextStmt !== -1) end = Math.min(end, nextStmt);
  return source.slice(start, end);
}

function assertNoPrivatePlayerFields(row) {
  for (const key of PRIVATE_PLAYER_KEYS) {
    assert.equal(row[key], undefined, key);
  }
}

test("a signed-in player can read the roster without private fields", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const login = await api(ctx, null, "POST", "/api/auth/login", { login: "admin", password: ADMIN_PW });
    assert.equal(login.status, 200, JSON.stringify(login.json));
    const admin = login.json.token;
    const issued = await api(ctx, admin, "POST", "/api/auth/invites", { note: "roster", max_uses: 2 });
    assert.equal(issued.status, 201, JSON.stringify(issued.json));
    const code = issued.json.invite.code;

    async function signup(name, display, allegiance, contact) {
      const res = await api(ctx, null, "POST", "/api/auth/signup", {
        invite_code: code,
        login: name,
        password: "botpass-xyz",
        player_name: "Real " + name,
        display_name: display,
        allegiance,
        contact,
        notes: name + " private notes",
        start_sys_id: allegiance === "Loyalist" ? 2 : 4
      });
      assert.equal(res.status, 201, JSON.stringify(res.json));
      return res.json;
    }

    const loyal = await signup("roster_loyal", "Table Loyal", "Loyalist", "loyal.secret@example.invalid");
    const traitor = await signup("roster_traitor", "Table Traitor", "Traitor", "traitor.secret@example.invalid");
    const discord = await api(ctx, traitor.token, "PUT", "/api/players/" + traitor.player_id, {
      discord_user_id: "123456789012345678"
    });
    assert.equal(discord.status, 200, JSON.stringify(discord.json));

    const adminForces = (await api(ctx, admin, "GET", "/api/forces")).json;
    const traitorForce = adminForces.find((force) => Number(force.player_id) === Number(traitor.player_id));
    assert.ok(traitorForce);
    const named = await api(ctx, admin, "PUT", "/api/forces/" + traitorForce.force_id, {
      force_name: "Sons of Horus spearhead",
      legion: "Sons of Horus",
      force_type: "Legion",
      warlord_name: "Horus",
      notes: "traitor secret plan",
      allies: "dark mechanicum"
    });
    assert.equal(named.status, 200, JSON.stringify(named.json));

    const list = await api(ctx, loyal.token, "GET", "/api/players");
    assert.equal(list.status, 200);
    const other = list.json.find((player) => Number(player.player_id) === Number(traitor.player_id));
    const self = list.json.find((player) => Number(player.player_id) === Number(loyal.player_id));
    assert.ok(other && self);
    assert.equal(other.display_name, "Table Traitor");
    assert.equal(other.allegiance, "Traitor");
    assertNoPrivatePlayerFields(other);
    assert.equal(self.contact, "loyal.secret@example.invalid");
    assert.equal(list.text.includes("traitor.secret@example.invalid"), false);
    assert.equal(list.text.includes("Real roster_traitor"), false);
    assert.equal(list.text.includes("traitor private notes"), false);
    assert.equal(list.text.includes("123456789012345678"), false);
    assert.equal(list.text.includes(code.replace(/-/g, "")), false);
    assert.equal(list.text.includes("pass_hash"), false);
    assert.equal(list.text.includes("pass_salt"), false);

    const one = await api(ctx, loyal.token, "GET", "/api/players/" + traitor.player_id);
    assert.equal(one.status, 200);
    assert.equal(one.json.display_name, "Table Traitor");
    assertNoPrivatePlayerFields(one.json);

    const pub = await api(ctx, loyal.token, "GET", "/api/public/players");
    assert.equal(pub.status, 200);
    const pubOther = pub.json.find((player) => Number(player.player_id) === Number(traitor.player_id));
    const pubSelf = pub.json.find((player) => Number(player.player_id) === Number(loyal.player_id));
    assert.equal(pubOther.display_name, "Table Traitor");
    assert.equal(pubOther.allegiance, "Traitor");
    assert.equal(pubSelf.display_name, "Table Loyal");
    pub.json.forEach(assertNoPrivatePlayerFields);
    assert.equal(pub.text.includes("secret@"), false);
    assert.equal(pub.text.includes("Real roster_"), false);
    assert.equal(pub.text.includes("private notes"), false);
    assert.equal(pub.text.includes("123456789012345678"), false);
    assert.equal(pub.text.includes("pass_hash"), false);

    const pubForces = await api(ctx, loyal.token, "GET", "/api/public/forces");
    assert.equal(pubForces.status, 200);
    const seen = pubForces.json.find((force) => Number(force.force_id) === Number(traitorForce.force_id));
    assert.ok(seen);
    assert.equal(seen.force_name, "Sons of Horus spearhead");
    assert.equal(seen.legion, "Sons of Horus");
    assert.equal(seen.force_type, "Legion");
    assert.equal(seen.warlord_name, "Horus");
    assert.equal(seen.allegiance, "Traitor");
    assert.equal(seen.player_id, traitor.player_id);
    assert.equal(seen.notes, undefined);
    assert.equal(seen.allies, undefined);
    assert.equal(pubForces.text.includes("traitor secret plan"), false);
    assert.equal(pubForces.text.includes("dark mechanicum"), false);

    const forces = await api(ctx, loyal.token, "GET", "/api/forces");
    const hidden = forces.json.find((force) => Number(force.force_id) === Number(traitorForce.force_id));
    assert.equal(hidden.legion, "Sons of Horus");
    assert.equal(hidden.notes, undefined);
    assert.equal(hidden.allies, undefined);

    assert.equal((await api(ctx, loyal.token, "PUT", "/api/players/" + traitor.player_id, { display_name: "Renamed" })).status, 403);
    assert.equal((await api(ctx, loyal.token, "DELETE", "/api/players/" + traitor.player_id)).status, 403);
    assert.equal((await api(ctx, loyal.token, "GET", "/api/auth/invites")).status, 403);
    assert.equal((await api(ctx, loyal.token, "GET", "/api/auth/password-resets")).status, 403);
    assert.equal((await api(ctx, loyal.token, "GET", "/api/accounts")).status, 404);
    assert.equal((await api(ctx, loyal.token, "GET", "/api/sessions")).status, 404);
    assert.equal((await api(ctx, loyal.token, "GET", "/api/admin/backup")).status, 403);

    const adminList = await api(ctx, admin, "GET", "/api/players");
    const adminOther = adminList.json.find((player) => Number(player.player_id) === Number(traitor.player_id));
    assert.equal(adminOther.player_name, "Real roster_traitor");
    assert.equal(adminOther.contact, "traitor.secret@example.invalid");
    assert.equal(adminOther.notes, "roster_traitor private notes");
    assert.equal(adminOther.discord_user_id, "123456789012345678");
    const adminForce = (await api(ctx, admin, "GET", "/api/forces/" + traitorForce.force_id)).json;
    assert.equal(adminForce.notes, "traitor secret plan");
    assert.equal(adminForce.allies, "dark mechanicum");
  } finally {
    await ctx.stop();
  }
});

test("the players tab is for signed-in players and the page keeps admin tools separate", () => {
  const pages = fs.readdirSync(ROOT).filter((name) => name.endsWith(".html"));
  assert.ok(pages.includes("player_admin.html"));
  for (const name of pages) {
    const html = fs.readFileSync(path.join(ROOT, name), "utf8");
    if (!html.includes('href="player_admin.html"')) continue;
    assert.match(html, /href="player_admin\.html"[^>]*data-role="logged-in"/, name);
    assert.doesNotMatch(html, /href="player_admin\.html"[^>]*data-role="campaign_admin"/, name);
  }

  const page = fs.readFileSync(path.join(ROOT, "player_admin.html"), "utf8");
  const rosterAt = page.indexOf('id="player-roster"');
  const adminAt = page.indexOf('id="admin-body"');
  assert.ok(rosterAt > 0 && adminAt > rosterAt);
  const roster = page.slice(rosterAt, adminAt);
  assert.match(roster, /Display names, sides, and forces/);
  assert.match(roster, /id="roster-list"/);
  assert.doesNotMatch(roster, /data-edit|invite-code|Generate code|id="btn-add"|id="f-contact"|id="btn-delete"/);

  const admin = page.slice(adminAt);
  assert.match(admin, /Player invites/);
  assert.match(admin, /data-edit/);
  assert.match(admin, /id="f-contact"/);
  assert.match(admin, /id="btn-delete"/);

  const shape = sliceFunction(page, "asRoster");
  assert.match(shape, /display_name/);
  assert.match(shape, /allegiance/);
  assert.match(shape, /legion/);
  assert.match(shape, /force_name/);
  assert.doesNotMatch(shape, /player_name|contact|notes|discord|allies|invite|password|pass_hash/);

  const load = sliceFunction(page, "loadRoster");
  assert.match(load, /loadPublicList\("players"\)/);
  assert.match(load, /loadPublicList\("forces"\)/);
  assert.doesNotMatch(load, /listInvites|passwordStatus|SH\.list\("players"\)/);

  assert.match(page, /if \(SH\.role === "player"\)/);
  assert.match(page, /roster\.hidden = false/);
  assert.match(page, /await loadRoster\(\)/);
  assert.match(page, /if \(SH\.canEditPlayers\(\)\)/);
  assert.match(page, /adminBody\.hidden = false/);
  assert.match(page, /await reload\(\)/);
});
