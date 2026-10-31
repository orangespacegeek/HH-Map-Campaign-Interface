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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-invite-"));
  const port = 26000 + Math.floor(Math.random() * 20000);
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

test("invite codes stay off public routes and other players", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const login = await api(ctx, null, "POST", "/api/auth/login", { login: "admin", password: ADMIN_PW });
    assert.equal(login.status, 200);
    const admin = login.json.token;
    const issued = await api(ctx, admin, "POST", "/api/auth/invites", { note: "shared", max_uses: 2 });
    assert.equal(issued.status, 201, JSON.stringify(issued.json));
    const code = issued.json.invite.code;
    assert.ok(code);

    async function signup(name, allegiance) {
      const res = await api(ctx, null, "POST", "/api/auth/signup", {
        invite_code: code,
        login: name,
        password: "botpass-xyz",
        player_name: name,
        display_name: name,
        allegiance
      });
      assert.equal(res.status, 201, JSON.stringify(res.json));
      return res.json;
    }
    const loyal = await signup("see_loyal", "Loyalist");
    const traitor = await signup("see_traitor", "Traitor");

    assert.equal(loyal.signup_invite.code.replace(/-/g, ""), code.replace(/-/g, ""));
    assert.equal(typeof loyal.signup_invite.used_at, "string");
    assert.equal(loyal.signup_invite.used_by, undefined);
    assert.equal(JSON.stringify(loyal).includes("see_traitor"), false);
    assert.equal(traitor.signup_invite.code.replace(/-/g, ""), code.replace(/-/g, ""));
    assert.equal(JSON.stringify(traitor).includes("see_loyal"), false);

    const loyalMe = await api(ctx, loyal.token, "GET", "/api/auth/me");
    assert.equal(loyalMe.json.signup_invite.code.replace(/-/g, ""), code.replace(/-/g, ""));
    assert.equal(JSON.stringify(loyalMe.json).includes("see_traitor"), false);
    assert.equal(loyalMe.json.player.invite_code, undefined);

    const pub = await api(ctx, null, "GET", "/api/public/players");
    assert.equal(pub.status, 200);
    assert.equal(pub.text.includes(code.replace(/-/g, "")), false);
    assert.equal(pub.text.toLowerCase().includes("invite"), false);

    const asTraitor = await api(ctx, traitor.token, "GET", "/api/players");
    assert.equal(asTraitor.status, 200);
    assert.equal(asTraitor.text.includes(code.replace(/-/g, "")), false);
    const other = asTraitor.json.find((p) => p.player_id === loyal.player_id);
    assert.equal(other.display_name, "see_loyal");
    assert.equal(other.contact, undefined);
    assert.equal(other.invite_code, undefined);
    const one = await api(ctx, traitor.token, "GET", "/api/players/" + loyal.player_id);
    assert.equal(one.text.includes(code.replace(/-/g, "")), false);

    const invitesAsPlayer = await api(ctx, traitor.token, "GET", "/api/auth/invites");
    assert.equal(invitesAsPlayer.status, 403);

    const adminInvites = await api(ctx, admin, "GET", "/api/auth/invites");
    const row = adminInvites.json.invites.find((inv) => inv.code === code || inv.code_display === loyal.signup_invite.code);
    assert.ok(row, JSON.stringify(adminInvites.json.invites));
    assert.equal(row.used_by.length, 2);
    row.used_by.forEach((use) => {
      assert.equal(typeof use.used_at, "string");
      assert.ok(use.player_id);
      assert.ok(use.login);
    });
  } finally {
    await ctx.stop();
  }
});

function sliceFunction(source, name) {
  const start = source.indexOf("function " + name);
  assert.notEqual(start, -1, name);
  const next = source.indexOf("\n    function ", start + 10);
  return source.slice(start, next === -1 ? source.length : next);
}

test("player admin and account pages name invites and show the signup code", () => {
  const adminPage = fs.readFileSync(path.join(ROOT, "player_admin.html"), "utf8");
  const account = fs.readFileSync(path.join(ROOT, "account.html"), "utf8");
  const login = fs.readFileSync(path.join(ROOT, "login.html"), "utf8");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const deploy = fs.readFileSync(path.join(ROOT, "DEPLOY_RENDER.md"), "utf8");
  assert.match(adminPage, /Player invites/);
  assert.doesNotMatch(adminPage, /Tester invites/);
  assert.doesNotMatch(adminPage, /the tester/);
  assert.match(adminPage, /inviteDetailsHtml/);
  assert.match(adminPage, /<th>Used by<\/th>/);
  assert.match(adminPage, /<th>Invite<\/th>/);
  assert.match(adminPage, /class="invite-cell"/);
  assert.match(adminPage, /inviteDetailsHtml\(p\.player_id\)/);

  const card = sliceFunction(adminPage, "inviteDetailsHtml");
  assert.match(card, /invite-code/);
  assert.match(card, /code_display/);
  assert.doesNotMatch(card, /Used by/);
  assert.doesNotMatch(card, /used_by/);
  assert.doesNotMatch(card, /used_at/);

  const inviteList = sliceFunction(adminPage, "renderInvites");
  assert.match(inviteList, /used_by/);
  assert.match(inviteList, /used_at/);

  assert.match(account, /signup_invite/);
  assert.doesNotMatch(login, /New testers/);
  assert.match(login, /New players need an invite code/);
  assert.match(readme, /Player invites/);
  assert.match(readme, /show only the code that player used/);
  assert.doesNotMatch(readme, /plus everyone who used it/);
  assert.doesNotMatch(readme, /Tester invites/);
  assert.match(deploy, /Player invites/);
  assert.doesNotMatch(deploy, /Tester invites/);
});
