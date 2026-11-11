"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const ADMIN_PW = "test-admin-pw-123";
const FALLBACK_DESCRIPTION =
  "Sunset Heresy campaign tracker. Visitors can open the map and battle log. Players sign in or sign up with an invite code.";
const PAGES = [
  "/",
  "/campaign_map.html",
  "/systems.html",
  "/forces.html",
  "/games.html",
  "/login.html",
  "/player_admin.html",
  "/rules.html",
  "/actions.html"
];

function startServer(prep) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-sector-"));
  if (prep) prep(dataDir);
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

async function page(ctx, pathname) {
  const res = await fetch(ctx.base + pathname);
  const text = await res.text();
  assert.equal(res.status, 200, pathname);
  return text;
}

function sampleSubsector() {
  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "meta.json"), "utf8"));
  const name = meta && meta.subsector != null ? String(meta.subsector).trim() : "";
  assert.ok(name, "sample meta should name its sector");
  return name;
}

test("maintained files do not keep the old place name as branding", () => {
  const skipDir = new Set(["bot-test", "node_modules", ".git"]);
  const allowed = new Set([
    "server.js",
    "README.md",
    "DEPLOY_RENDER.md",
    "test/ajale-migration.test.js",
    "test/sector-name.test.js"
  ]);
  const textExt = new Set([".js", ".html", ".md", ".json", ".csv", ".css", ".yml", ".yaml", ".txt"]);
  const hits = [];
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skipDir.has(ent.name)) continue;
      const fp = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(fp);
        continue;
      }
      if (!ent.isFile()) continue;
      if (!textExt.has(path.extname(ent.name).toLowerCase())) continue;
      const rel = path.relative(ROOT, fp);
      const text = fs.readFileSync(fp, "utf8");
      if (!/port maw/i.test(text)) continue;
      if (!allowed.has(rel)) hits.push(rel);
    }
  }
  walk(ROOT);
  assert.deepEqual(hits, []);
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const withoutNeedle = server.replace('const LEGACY_PLACE_NAME = "Port Maw";', "");
  assert.equal(/port maw/i.test(withoutNeedle), false);
  const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "baseline", "systems.json"), "utf8"));
  const sampleSystems = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "systems.json"), "utf8"));
  assert.equal(baseline[0].sys_name, "Ajale Sector");
  assert.equal(sampleSystems[0].sys_name, "Ajale Sector");
  assert.equal(baseline[0].sys_id, sampleSystems[0].sys_id);
  assert.equal(baseline[0].sys_links, sampleSystems[0].sys_links);
  assert.equal(baseline[0].sys_x, sampleSystems[0].sys_x);
  assert.equal(baseline[0].sys_y, sampleSystems[0].sys_y);
  assert.equal(sampleSubsector(), "Ajale Sector");
});

test("force and player editors take systems from the API", () => {
  const forces = fs.readFileSync(path.join(ROOT, "forces.html"), "utf8");
  const players = fs.readFileSync(path.join(ROOT, "player_admin.html"), "utf8");
  for (const html of [forces, players]) {
    assert.match(html, /SH\.list\("systems"\)/);
    assert.match(html, /Loading systems…/);
    assert.match(html, /Could not load systems/);
    assert.match(html, /System " \+ keep/);
    assert.match(html, /No systems yet/);
  }
  assert.match(forces, /fillForceSystemSelect\(force && force\.sys_id \? force\.sys_id : ""\)/);
  assert.match(players, /fillStartSystemSelect\(player && player\.start_sys_id \? player\.start_sys_id : ""\)/);
});

test("a blank subsector uses neutral copy and a set subsector is rendered", async () => {
  const ctx = startServer();
  const sampleName = sampleSubsector();
  try {
    await ctx.ready;
    const fallback = {};
    for (const pathname of PAGES) {
      const html = await page(ctx, pathname);
      fallback[pathname] = html;
      assert.equal(html.includes("__SH_"), false, pathname + " left a placeholder");
      assert.equal(html.includes(sampleName), false, pathname + " showed the sample sector with empty meta");
      assert.ok(html.includes(FALLBACK_DESCRIPTION), pathname + " description");
    }
    const index = fallback["/"];
    assert.match(index, /property="og:title"[^>]*content="Sunset Heresy"/);
    assert.match(index, /name="twitter:title"[^>]*content="Sunset Heresy"/);
    assert.match(index, /<title>Sunset Heresy – Campaign Tracker<\/title>/);
    assert.match(index, /id="header-sub"[^>]*>Campaign sector</);
    assert.match(index, /Interactive campaign map with control colours, force presence, and system details\./);
    assert.match(index, /Unchecked, the starting map is restored, including links, positions, power, durability, and control\./);
    const map = fallback["/campaign_map.html"];
    assert.match(map, /<title[^>]*>Sunset Heresy – Campaign Map<\/title>/);
    assert.match(map, /id="header-sub"[^>]*>Campaign sector</);
    const systems = fallback["/systems.html"];
    assert.match(systems, /id="header-sub"[^>]*>Campaign sector</);

    const adminLogin = await api(ctx, null, "POST", "/api/auth/login", {
      login: "admin",
      password: ADMIN_PW
    });
    assert.equal(adminLogin.status, 200, JSON.stringify(adminLogin.json));
    const admin = adminLogin.json.token;

    async function putSubsector(subsector) {
      const current = (await api(ctx, null, "GET", "/api/public/meta")).json || {};
      const saved = await api(ctx, admin, "PUT", "/api/meta", { ...current, subsector });
      assert.equal(saved.status, 200, JSON.stringify(saved.json));
    }

    await putSubsector("   ");
    const blank = await page(ctx, "/");
    assert.ok(blank.includes(FALLBACK_DESCRIPTION));
    assert.match(blank, /id="header-sub"[^>]*>Campaign sector</);
    assert.equal(blank.includes("sub-sector."), false);

    await putSubsector("Garm Reach");
    for (const pathname of PAGES) {
      const html = await page(ctx, pathname);
      assert.ok(
        html.includes("Sunset Heresy campaign tracker for the Garm Reach."),
        pathname
      );
      assert.equal(html.includes("__SH_"), false, pathname);
    }
    const namedIndex = await page(ctx, "/");
    assert.match(namedIndex, /property="og:title"[^>]*content="Sunset Heresy – Garm Reach"/);
    assert.match(namedIndex, /name="twitter:title"[^>]*content="Sunset Heresy – Garm Reach"/);
    assert.match(namedIndex, /id="header-sub"[^>]*>Garm Reach</);
    assert.match(namedIndex, /Interactive map of the Garm Reach, with control colours/);
    assert.match(namedIndex, /Unchecked, the Garm Reach starting map is restored/);
    const namedMap = await page(ctx, "/campaign_map.html");
    assert.match(namedMap, /<title[^>]*>Sunset Heresy – Garm Reach<\/title>/);
    assert.match(namedMap, /id="header-sub"[^>]*>Garm Reach</);
    const namedSystems = await page(ctx, "/systems.html");
    assert.match(namedSystems, /id="header-sub"[^>]*>Garm Reach</);

    await putSubsector('A & B "C" <tag>');
    const escaped = await page(ctx, "/systems.html");
    assert.match(escaped, /for the A &amp; B &quot;C&quot; &lt;tag&gt;\./);
    assert.equal(escaped.includes('for the A & B "C" <tag>'), false);
    assert.match(escaped, /id="header-sub"[^>]*>A &amp; B &quot;C&quot; &lt;tag&gt;</);

    await putSubsector(sampleName);
    const fromData = await page(ctx, "/");
    assert.ok(fromData.includes("for the " + sampleName + "."));
    assert.match(fromData, new RegExp("id=\"header-sub\"[^>]*>" + sampleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "<"));

    await putSubsector("");
    const cleared = await page(ctx, "/campaign_map.html");
    assert.match(cleared, /<title[^>]*>Sunset Heresy – Campaign Map<\/title>/);
    assert.ok(cleared.includes(FALLBACK_DESCRIPTION));
  } finally {
    await ctx.stop();
  }
});

test("an existing data directory keeps its sector name, and reset restores the starting map", async () => {
  const sampleName = sampleSubsector();
  const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "baseline", "systems.json"), "utf8"));
  const ctx = startServer((dataDir) => {
    fs.writeFileSync(
      path.join(dataDir, "meta.json"),
      JSON.stringify({
        campaign_name: "Sunset Heresy",
        subsector: sampleName,
        turn: 4,
        phase: "Battles",
        loyal_score: 3,
        traitor_score: 1
      }, null, 2)
    );
    fs.writeFileSync(
      path.join(dataDir, "systems.json"),
      JSON.stringify([
        {
          sys_id: 99,
          sys_name: "Old Anchorage",
          sys_type: "Void",
          sys_power: 1,
          sys_durability: 5,
          sys_loyal: 0,
          sys_traitor: 0,
          sys_neut: 0,
          sys_controller: "Neutral",
          sys_links: "",
          sys_x: 1,
          sys_y: 1
        }
      ], null, 2)
    );
    fs.writeFileSync(
      path.join(dataDir, "games.json"),
      JSON.stringify([{ game_id: 1, sys_id: 99, result: "in_progress" }], null, 2)
    );
  });
  try {
    await ctx.ready;
    const html = await page(ctx, "/");
    assert.ok(html.includes("for the " + sampleName + "."));
    const systems = await api(ctx, null, "GET", "/api/public/systems");
    assert.equal(systems.status, 200);
    assert.equal(systems.json.length, 1);
    assert.equal(systems.json[0].sys_name, "Old Anchorage");

    const adminLogin = await api(ctx, null, "POST", "/api/auth/login", {
      login: "admin",
      password: ADMIN_PW
    });
    assert.equal(adminLogin.status, 200, JSON.stringify(adminLogin.json));
    const reset = await api(ctx, adminLogin.json.token, "POST", "/api/campaign/reset", { confirm: "RESET" });
    assert.equal(reset.status, 200, JSON.stringify(reset.json));
    assert.equal(reset.json.systems_restored, true);
    assert.equal(reset.json.games_cleared, 1);

    const after = await api(ctx, null, "GET", "/api/public/systems");
    assert.equal(after.json.length, baseline.length);
    assert.equal(after.json[0].sys_id, baseline[0].sys_id);
    assert.equal(after.json[0].sys_name, baseline[0].sys_name);
    const games = await api(ctx, adminLogin.json.token, "GET", "/api/games");
    assert.equal(games.status, 200);
    assert.deepEqual(games.json, []);
    const meta = await api(ctx, null, "GET", "/api/public/meta");
    assert.equal(meta.json.subsector, sampleName);
    assert.equal(meta.json.phase, "Muster");
    const stillNamed = await page(ctx, "/systems.html");
    assert.match(
      stillNamed,
      new RegExp("id=\"header-sub\"[^>]*>" + sampleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "<")
    );
  } finally {
    await ctx.stop();
  }
});
