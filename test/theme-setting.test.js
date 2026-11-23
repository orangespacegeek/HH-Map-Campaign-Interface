"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const ADMIN_PW = "test-admin-pw-123";

function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-theme-"));
  const port = 33000 + Math.floor(Math.random() * 20000);
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
  return { status: res.status, json, text };
}

async function adminToken(ctx) {
  const login = await api(ctx, null, "POST", "/api/auth/login", { login: "admin", password: ADMIN_PW });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  return login.json.token;
}

test("a campaign with no theme setting stays on the current style", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const stored = JSON.parse(fs.readFileSync(path.join(ctx.dataDir, "meta.json"), "utf8"));
    assert.equal(Object.prototype.hasOwnProperty.call(stored, "theme"), false);

    const pub = await api(ctx, null, "GET", "/api/public/meta");
    assert.equal(pub.status, 200);
    assert.equal(pub.json.theme, "current");

    const page = await fetch(ctx.base + "/");
    const html = await page.text();
    assert.match(html, /<html[^>]*data-theme-default="current"/);
    assert.equal(html.includes('data-theme="journal-tactica"'), false);
    const fonts = html.match(/href="css\/journal-fonts\.css\?v=([0-9a-f]{12})"/);
    assert.ok(fonts, "journal-fonts.css should be cache-busted");
    const expected = crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, "css", "journal-fonts.css"))).digest("hex").slice(0, 12);
    assert.equal(fonts[1], expected);
  } finally {
    await ctx.stop();
  }
});

test("only a campaign admin can set the site theme", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const anon = await api(ctx, null, "POST", "/api/campaign/theme", { theme: "journal-tactica" });
    assert.equal(anon.status, 401);

    const admin = await adminToken(ctx);
    const invite = await api(ctx, admin, "POST", "/api/auth/invites", { note: "theme" });
    assert.equal(invite.status, 201, JSON.stringify(invite.json));
    const signup = await api(ctx, null, "POST", "/api/auth/signup", {
      invite_code: invite.json.invite.code,
      login: "theme_player",
      password: "botpass-xyz",
      player_name: "theme_player",
      display_name: "theme_player",
      allegiance: "Loyalist",
      start_sys_id: 1
    });
    assert.equal(signup.status, 201, JSON.stringify(signup.json));
    const player = await api(ctx, signup.json.token, "POST", "/api/campaign/theme", { theme: "journal-tactica" });
    assert.equal(player.status, 403);

    const bad = await api(ctx, admin, "POST", "/api/campaign/theme", { theme: "parchment" });
    assert.equal(bad.status, 400);
    assert.equal((await api(ctx, null, "GET", "/api/public/meta")).json.theme, "current");

    const saved = await api(ctx, admin, "POST", "/api/campaign/theme", { theme: "journal-tactica" });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.equal(saved.json.theme, "journal-tactica");
    assert.equal((await api(ctx, null, "GET", "/api/public/meta")).json.theme, "journal-tactica");

    const page = await fetch(ctx.base + "/rules.html");
    assert.match(await page.text(), /data-theme-default="journal-tactica"/);

    const back = await api(ctx, admin, "POST", "/api/campaign/theme", { theme: "current" });
    assert.equal(back.status, 200);
    assert.equal((await api(ctx, null, "GET", "/api/public/meta")).json.theme, "current");
    const stored = JSON.parse(fs.readFileSync(path.join(ctx.dataDir, "meta.json"), "utf8"));
    assert.equal(stored.theme, "current");
  } finally {
    await ctx.stop();
  }
});

test("the current look stays on :root and Journal Tactica is scoped", () => {
  const css = fs.readFileSync(path.join(ROOT, "css", "theme.css"), "utf8");
  const journalAt = css.indexOf('html[data-theme="journal-tactica"] {');
  assert.ok(journalAt > 0);
  const root = css.slice(0, journalAt);
  assert.match(root, /--loyal:\s*#3b82f6/);
  assert.match(root, /--traitor:\s*#ef4444/);
  assert.match(root, /--text:\s*#e8e0c8/);
  const journal = css.slice(journalAt);
  assert.match(journal, /--loyal:\s*#cca55c/);
  assert.match(journal, /--border:\s*#826230/);
  assert.match(journal, /--traitor:\s*#e2624e/);
  assert.match(journal, /--danger:\s*#c43426/);
  assert.match(journal, /--contested:\s*#c8ba9c/);
  assert.match(journal, /--text:\s*#ece0c4/);
  assert.match(journal, /Archive Extract · Relay Choir of Fintlon · 009\.M31/);
  const script = fs.readFileSync(path.join(ROOT, "js", "theme.js"), "utf8");
  assert.match(script, /localStorage/);
  assert.match(script, /data-theme-default/);
  assert.match(script, /journal-tactica/);
  assert.match(script, /Use site default/);
});

test("journal map art is drawn only for the Journal Tactica theme", () => {
  const map = fs.readFileSync(path.join(ROOT, "js", "map.js"), "utf8");
  const drawStars = map.slice(map.indexOf("function drawStars()"), map.indexOf("function drawLinks()"));
  assert.match(drawStars, /if \(journalTheme\(\)\) return;/);
  assert.match(drawStars, /for \(let i = 0; i < 100; i\+\+\)/);
  assert.match(drawStars, /Math\.random\(\) \* BASE_W/);
  assert.ok(drawStars.indexOf("journalTheme") < drawStars.indexOf("Math.random"));
  assert.match(map, /data-theme"\) === "journal-tactica"/);
  assert.match(map, /AJALE SYSTEM/);
  assert.match(map, /Built with Abominable Intelligence/);
  assert.match(map, /class: "link"/);
  const css = fs.readFileSync(path.join(ROOT, "css", "journal-layout.css"), "utf8");
  assert.match(css, /html\[data-theme="journal-tactica"\] \.node\.selected \.jt-brackets/);
  assert.doesNotMatch(css, /^\.jt-(ring|brackets|icon|core|credit|halo)/m);
});
