"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
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
    const issued = await api(ctx, admin, "POST", "/api/auth/invites", { note: "roster", max_uses: 3 });
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
    const traitor = await signup("roster_traitor", "Table Traitor", "Traitor", "discord:warsmith#1234");
    const quiet = await signup("roster_quiet", "Table Quiet", "Loyalist", "");
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
    assert.equal(list.text.includes("warsmith#1234"), false);
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
    assert.equal(pub.text.includes("warsmith#1234"), false);
    assert.equal(pub.text.includes("realName"), false);

    const anon = await api(ctx, null, "GET", "/api/roster");
    assert.equal(anon.status, 401);
    assert.equal(anon.text.includes("Real roster_"), false);
    assert.equal(anon.text.includes("loyal.secret@"), false);
    assert.equal(anon.text.includes("warsmith#1234"), false);
    assert.equal(anon.text.includes("123456789012345678"), false);
    assert.equal((await api(ctx, null, "POST", "/api/roster", {})).status, 405);

    const roster = await api(ctx, loyal.token, "GET", "/api/roster");
    assert.equal(roster.status, 200);
    const rosterKeys = ["allegiance", "contact", "display_name", "player_id", "realName", "start_sys_id", "status"];
    const rosterOther = roster.json.find((player) => Number(player.player_id) === Number(traitor.player_id));
    const rosterSelf = roster.json.find((player) => Number(player.player_id) === Number(loyal.player_id));
    const rosterQuiet = roster.json.find((player) => Number(player.player_id) === Number(quiet.player_id));
    assert.equal(rosterOther.display_name, "Table Traitor");
    assert.equal(rosterOther.realName, "Real roster_traitor");
    assert.equal(rosterOther.contact, "discord:warsmith#1234");
    assert.equal(rosterOther.allegiance, "Traitor");
    assert.deepEqual(Object.keys(rosterOther).sort(), rosterKeys);
    assert.equal(rosterSelf.realName, "Real roster_loyal");
    assert.equal(rosterSelf.contact, "loyal.secret@example.invalid");
    assert.equal(rosterQuiet.realName, "Real roster_quiet");
    assert.equal(rosterQuiet.contact, null);
    assert.equal(roster.text.includes("roster_traitor private notes"), false);
    assert.equal(roster.text.includes("123456789012345678"), false);
    assert.equal(roster.text.includes(code.replace(/-/g, "")), false);
    assert.equal(roster.text.includes("pass_hash"), false);
    assert.equal(roster.text.includes("discord_user_id"), false);
    assert.equal(rosterOther.notes, undefined);
    assert.equal(rosterOther.player_name, undefined);
    assert.equal(rosterOther.discord_user_id, undefined);

    const adminRoster = await api(ctx, admin, "GET", "/api/roster");
    assert.equal(adminRoster.status, 200);
    const adminRosterOther = adminRoster.json.find((player) => Number(player.player_id) === Number(traitor.player_id));
    assert.equal(adminRosterOther.realName, "Real roster_traitor");
    assert.equal(adminRosterOther.contact, "discord:warsmith#1234");
    assert.equal(adminRoster.text.includes("private notes"), false);
    assert.equal(adminRoster.text.includes("123456789012345678"), false);

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
    assert.equal(adminOther.contact, "discord:warsmith#1234");
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
  assert.match(roster, /arrange games/);
  assert.match(roster, /id="roster-list"/);
  assert.doesNotMatch(roster, /data-edit|invite-code|Generate code|id="btn-add"|id="f-contact"|id="btn-delete"/);

  const admin = page.slice(adminAt);
  assert.match(admin, /Player invites/);
  assert.match(admin, /data-edit/);
  assert.match(admin, /id="f-contact"/);
  assert.match(admin, /id="btn-delete"/);

  const shape = sliceFunction(page, "asRoster");
  assert.match(shape, /display_name/);
  assert.match(shape, /realName/);
  assert.match(shape, /contact/);
  assert.match(shape, /allegiance/);
  assert.match(shape, /legion/);
  assert.match(shape, /force_name/);
  assert.doesNotMatch(shape, /player_name|notes|discord_user_id|allies|invite|password|pass_hash/);

  const contact = sliceFunction(page, "contactHtml");
  assert.match(contact, /mailto:/);
  assert.match(contact, /data-copy-contact/);
  assert.match(contact, /No contact shared/);

  const load = sliceFunction(page, "loadRoster");
  assert.match(load, /SH\.roster\(\)/);
  assert.match(load, /loadPublicList\("forces"\)/);
  assert.doesNotMatch(load, /loadPublicList\("players"\)/);
  assert.doesNotMatch(load, /listInvites|passwordStatus|SH\.list\("players"\)/);

  const rulesMd = fs.readFileSync(path.join(ROOT, "campaign_rules.md"), "utf8");
  const rulesHtml = fs.readFileSync(path.join(ROOT, "rules.html"), "utf8");
  const rule = "Signed-in campaign players can see each other's real names and contact info on the Players page to arrange games.";
  const ruleRe = new RegExp(rule.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  assert.match(rulesMd, new RegExp(ruleRe.source + " \\(added as part of web app build\\)"));
  assert.match(rulesHtml, ruleRe);
  assert.doesNotMatch(rulesHtml, /added as part of web app build/);
  const login = fs.readFileSync(path.join(ROOT, "login.html"), "utf8");
  const account = fs.readFileSync(path.join(ROOT, "account.html"), "utf8");
  assert.match(login, /Other signed-in players can see it on the Players page/);
  assert.match(login, /Other signed-in players can see this on the Players page to arrange games/);
  assert.match(account, /Other signed-in players can see this on the Players page so they can arrange games/);
  const api = fs.readFileSync(path.join(ROOT, "js", "api.js"), "utf8");
  assert.match(api, /\/api\/roster/);

  assert.match(page, /String\(SH\.role \|\| ""\)\.trim\(\)\.toLowerCase\(\) === "player"/);
  assert.match(page, /function compareNames/);
  assert.doesNotMatch(page, /localeCompare\([^)]*undefined/);
  assert.match(page, /Players page failed/);
  assert.match(page, /rosterErrorText\(err\)/);
  assert.doesNotMatch(page, /showToast\("Could not load players"\)/);

  const compareSrc = page.slice(page.indexOf("function compareNames"), page.indexOf("function rosterText"));
  const compareNames = new Function(compareSrc + "\nreturn compareNames;")();
  const original = String.prototype.localeCompare;
  String.prototype.localeCompare = function () {
    throw new RangeError("Incorrect locale information provided");
  };
  try {
    assert.equal(typeof compareNames("Bravo", "alpha"), "number");
    assert.ok(compareNames("Alpha", "Bravo") < 0);
    assert.equal(compareNames("same", "same"), 0);
  } finally {
    String.prototype.localeCompare = original;
  }
  assert.match(page, /roster\.hidden = false/);
  assert.match(page, /await loadRoster\(\)/);
  assert.match(page, /if \(SH\.canEditPlayers\(\)\)/);
  assert.match(page, /adminBody\.hidden = false/);
  assert.match(page, /await reload\(\)/);
});

test("legacy and odd player rows still load for a signed-in player", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const login = await api(ctx, null, "POST", "/api/auth/login", { login: "admin", password: ADMIN_PW });
    assert.equal(login.status, 200, login.text);
    const admin = login.json.token;
    const issued = await api(ctx, admin, "POST", "/api/auth/invites", { max_uses: 1 });
    assert.equal(issued.status, 201, issued.text);
    const signed = await api(ctx, null, "POST", "/api/auth/signup", {
      invite_code: issued.json.invite.code,
      login: "legacy_player",
      password: "botpass-xyz",
      player_name: "Real Legacy",
      display_name: "Table Legacy",
      allegiance: "Loyalist",
      contact: "legacy@example.invalid",
      notes: "legacy private notes"
    });
    assert.equal(signed.status, 201, signed.text);

    const playersPath = path.join(ctx.dataDir, "players.json");
    const forcesPath = path.join(ctx.dataDir, "forces.json");
    const accountsPath = path.join(ctx.dataDir, "accounts.json");
    const players = JSON.parse(fs.readFileSync(playersPath, "utf8"));
    const forces = JSON.parse(fs.readFileSync(forcesPath, "utf8"));
    players.push(
      { player_id: 80, player_name: "Legacy Only", allegiance: "Blackshield", status: "active", role: "player", notes: "do not share", discord_user_id: "123456789012345678" },
      { player_id: 81, allegiance: null, status: null, contact: null, player_name: null, display_name: null },
      { player_id: 82, player_name: "No Forces", display_name: "Unraised", allegiance: "Traitor", status: "waitlist", contact: "discord:quiet#1" },
      { player_id: 83, player_name: { unexpected: true }, display_name: ["Array", "Name"], allegiance: "Loyalist", status: "inactive", contact: 44100 },
      null
    );
    forces.push(
      { force_id: 900, player_id: null, force_name: null, allegiance: null, sys_id: null, status: null, notes: "orphan secret", allies: "hidden allies" },
      { force_id: 901, player_id: 80, force_name: "Old Shield", legion: null, allegiance: "Blackshield", sys_id: 99999, status: "active", notes: "shield secret" },
      null
    );
    fs.writeFileSync(playersPath, JSON.stringify(players, null, 2));
    fs.writeFileSync(forcesPath, JSON.stringify(forces, null, 2));
    const accounts = JSON.parse(fs.readFileSync(accountsPath, "utf8"));
    const mine = accounts.find((account) => account.login === "legacy_player");
    assert.ok(mine);
    mine.role = "Player";
    fs.writeFileSync(accountsPath, JSON.stringify(accounts, null, 2));

    const anon = await api(ctx, null, "GET", "/api/roster");
    assert.equal(anon.status, 401);
    assert.equal(anon.json.error, "Login required");
    assert.equal(anon.text.includes("Real Legacy"), false);
    assert.equal(anon.text.includes("legacy@example.invalid"), false);

    const roster = await api(ctx, signed.json.token, "GET", "/api/roster");
    assert.equal(roster.status, 200, roster.text);
    const keys = ["allegiance", "contact", "display_name", "player_id", "realName", "start_sys_id", "status"];
    roster.json.forEach((row) => assert.deepEqual(Object.keys(row).sort(), keys));
    const self = roster.json.find((row) => row.display_name === "Table Legacy");
    const legacy = roster.json.find((row) => row.realName === "Legacy Only");
    const blank = roster.json.find((row) => Number(row.player_id) === 81);
    const quiet = roster.json.find((row) => row.display_name === "Unraised");
    const odd = roster.json.find((row) => Number(row.player_id) === 83);
    assert.ok(self && legacy && blank && quiet && odd);
    assert.equal(self.realName, "Real Legacy");
    assert.equal(self.contact, "legacy@example.invalid");
    assert.equal(legacy.display_name, "Unknown commander");
    assert.equal(legacy.allegiance, "Blackshield");
    assert.equal(legacy.contact, null);
    assert.equal(blank.realName, null);
    assert.equal(blank.contact, null);
    assert.equal(blank.display_name, "Unknown commander");
    assert.equal(quiet.contact, "discord:quiet#1");
    assert.equal(quiet.status, "waitlist");
    assert.equal(odd.realName, null);
    assert.equal(odd.display_name, "Unknown commander");
    assert.equal(odd.contact, "44100");
    assert.equal(roster.json.some((row) => row == null), false);
    assert.equal(roster.text.includes("legacy private notes"), false);
    assert.equal(roster.text.includes("do not share"), false);
    assert.equal(roster.text.includes("123456789012345678"), false);
    assert.equal(roster.text.includes("pass_hash"), false);
    assert.equal(roster.text.includes(issued.json.invite.code.replace(/-/g, "")), false);

    const pubPlayers = await api(ctx, null, "GET", "/api/public/players");
    const pubForces = await api(ctx, null, "GET", "/api/public/forces");
    assert.equal(pubPlayers.status, 200, pubPlayers.text);
    assert.equal(pubForces.status, 200, pubForces.text);
    assert.equal(pubPlayers.text.includes("Real Legacy"), false);
    assert.equal(pubPlayers.text.includes("legacy@example.invalid"), false);
    assert.equal(pubPlayers.text.includes("discord:quiet#1"), false);
    assert.equal(pubPlayers.text.includes("realName"), false);
    assert.equal(pubForces.text.includes("shield secret"), false);
    assert.equal(pubForces.text.includes("orphan secret"), false);
    assert.equal(pubForces.text.includes("hidden allies"), false);
  } finally {
    await ctx.stop();
  }
});

test("served pages version js and css so a new Players page cannot run a stale api.js", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const page = await fetch(ctx.base + "/player_admin.html");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("cache-control") || "", /no-store/);
    assert.doesNotMatch(page.headers.get("cache-control") || "", /max-age/);
    const html = await page.text();
    const script = html.match(/src="js\/api\.js\?v=([0-9a-f]{12})"/);
    const css = html.match(/href="css\/site-nav\.css\?v=([0-9a-f]{12})"/);
    const themeCss = html.match(/href="css\/theme\.css\?v=([0-9a-f]{12})"/);
    const themeJs = html.match(/src="js\/theme\.js\?v=([0-9a-f]{12})"/);
    assert.ok(script, html.slice(html.indexOf("js/api.js") - 20, html.indexOf("js/api.js") + 40));
    assert.ok(css);
    assert.ok(themeCss, "theme.css should be cache-busted");
    assert.ok(themeJs, "theme.js should be cache-busted");
    const themeCssExpected = crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, "css", "theme.css"))).digest("hex").slice(0, 12);
    const themeJsExpected = crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, "js", "theme.js"))).digest("hex").slice(0, 12);
    assert.equal(themeCss[1], themeCssExpected);
    assert.equal(themeJs[1], themeJsExpected);
    const expected = crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, "js", "api.js"))).digest("hex").slice(0, 12);
    assert.equal(script[1], expected);

    const versioned = await fetch(ctx.base + "/js/api.js?v=" + script[1]);
    assert.equal(versioned.status, 200);
    assert.match(versioned.headers.get("cache-control") || "", /immutable/);
    const source = await versioned.text();
    assert.match(source, /async function roster\(/);

    const bare = await fetch(ctx.base + "/js/api.js");
    assert.equal(bare.status, 200);
    assert.match(bare.headers.get("cache-control") || "", /must-revalidate/);
    assert.match(bare.headers.get("cache-control") || "", /max-age=0/);

    const map = await fetch(ctx.base + "/campaign_map.html");
    const mapHtml = await map.text();
    assert.match(mapHtml, /src="js\/map\.js\?v=[0-9a-f]{12}"/);
    assert.match(mapHtml, /src="js\/api\.js\?v=[0-9a-f]{12}"/);
  } finally {
    await ctx.stop();
  }
});
