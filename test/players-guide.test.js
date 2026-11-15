"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const GUIDE = "players_guide.html";
const LINK = '<a class="nav-guide" href="players_guide.html">Guide</a>';
const ACTIVE_LINK = '<a class="nav-guide active" href="players_guide.html" aria-current="page">Guide</a>';

const WORDING = [
  "Winter 2026/27 Heresy Escalation Campaign: Player's Guide",
  "Length: 3 months (Dec 2026 to Feb 2027), then we'll check in on how it's going.",
  "Dec: 500\u2013750 pts",
  "Jan: 1000\u20131500 pts",
  "Feb: 2000\u20133000 pts",
  "Agree on points and game type with your opponent ahead of time. For December I recommend Core, Relic and Zone Mortalis. Onslaught, Leviathan and Armoured Spearhead are fine too. No new army required.",
  "Book a table through the store's normal scheduling.",
  "Use the store's Heresy terrain or the Zone Mortalis/Necromunda set.",
  "Smaller games should use a 3\u2032 \u00d7 4\u2032 table so two can run side by side.",
  "Log your results in the campaign app. Store staff don't track anything.",
  "Store rules (please respect these, it's their space)",
  "No 3D-printed models and no pirated materials.",
  "3D-printed Legion shoulder pads, Legion-specific weapons and head swaps are OK.",
  "Between you, have the core rulebook and the scenario book (if needed). Each player brings the book for their army. Don't rely on New Recruit or PDFs.",
  "Painted minis (primed/WIP at a minimum). The core of each model should be GW or a purchasable alternative (e.g. Wargames Atlantic)."
];

function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-guide-"));
  const port = 31000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDir,
      CAMPAIGN_ADMIN_PASSWORD: "test-admin-pw-123",
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

test("every page with the top-right nav links the player's guide beside Actions", () => {
  const pages = fs.readdirSync(ROOT).filter((name) => name.endsWith(".html"));
  const withNav = [];
  for (const name of pages) {
    const html = fs.readFileSync(path.join(ROOT, name), "utf8");
    if (!html.includes('id="nav-waiting"')) continue;
    withNav.push(name);
    const headerEnd = html.slice(html.indexOf('class="header-end"'), html.indexOf('id="site-menu"'));
    const expected = name === GUIDE ? ACTIVE_LINK : LINK;
    assert.ok(headerEnd.includes(expected), name + " is missing the guide link beside Actions");
    const guideAt = headerEnd.indexOf('href="players_guide.html"');
    const actionsAt = headerEnd.indexOf('id="nav-waiting"');
    const authAt = headerEnd.indexOf('id="nav-auth"');
    assert.ok(guideAt >= 0 && actionsAt > guideAt, name + " guide link is not next to Actions");
    assert.ok(authAt > actionsAt, name + " guide link must stay outside the auth slot");
    assert.equal(headerEnd.includes('href="players_guide.html" hidden'), false, name);
    assert.equal(/data-role="[^"]*" href="players_guide.html"|href="players_guide.html"[^>]*data-role=/.test(headerEnd), false, name);
  }
  assert.ok(withNav.includes("index.html"));
  assert.ok(withNav.includes("rules.html"));
  assert.ok(withNav.includes(GUIDE));
  assert.equal(withNav.length, 12);
});

test("the player's guide keeps the written wording and is not campaign rules", () => {
  const html = fs.readFileSync(path.join(ROOT, GUIDE), "utf8");
  for (const line of WORDING) assert.ok(html.includes(line), "missing: " + line);
  assert.equal(html.includes("Ajale"), false);
  const rules = fs.readFileSync(path.join(ROOT, "rules.html"), "utf8");
  const rulesBody = rules.slice(rules.indexOf("<main>"));
  assert.equal(rulesBody.includes("Winter 2026/27"), false);
  const campaignRules = fs.readFileSync(path.join(ROOT, "campaign_rules.md"), "utf8");
  assert.equal(campaignRules.includes("Winter 2026/27"), false);
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  assert.match(server, /"players_guide\.html"/);
});

test("the player's guide page is served to a signed-out visitor", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const res = await fetch(ctx.base + "/players_guide.html");
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/html/);
    assert.equal(text.includes("__SH_"), false);
    assert.equal(text.includes("Ajale"), false);
    for (const line of WORDING) assert.ok(text.includes(line), "served page missing: " + line);
    assert.ok(text.includes(ACTIVE_LINK));
    const home = await fetch(ctx.base + "/");
    const homeText = await home.text();
    assert.equal(home.status, 200);
    assert.ok(homeText.includes(LINK));
    const blocked = await fetch(ctx.base + "/not-a-page.html");
    assert.equal(blocked.status, 404);
  } finally {
    await ctx.stop();
  }
});
