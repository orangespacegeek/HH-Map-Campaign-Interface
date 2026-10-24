"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");

test("every page header uses the shared auth slot", () => {
  const pages = fs.readdirSync(ROOT).filter((name) => name.endsWith(".html"));
  assert.ok(pages.includes("campaign_map.html"));
  for (const name of pages) {
    const html = fs.readFileSync(path.join(ROOT, name), "utf8");
    if (!html.includes("site-header")) continue;
    assert.match(html, /id="nav-auth"/, name + " is missing #nav-auth");
    assert.match(html, /applyNavPermissions\(/, name + " never paints the signed-in header");
    assert.match(html, /js\/api\.js/, name + " does not load the shared auth script");
  }
});

test("session probe is single-flight so the map header can see the signed-in user", () => {
  const api = fs.readFileSync(path.join(ROOT, "js", "api.js"), "utf8");
  assert.match(api, /let probePromise = null/);
  const runAt = api.indexOf("async function runProbe()");
  assert.ok(runAt > api.indexOf("async function probe()"));
  const runBody = api.slice(runAt, runAt + 900);
  assert.ok(runBody.indexOf("await refreshMe()") > 0);
  assert.ok(
    runBody.indexOf("await refreshMe()") < runBody.indexOf("probed = true"),
    "probed must stay false until refreshMe finishes"
  );
  const map = fs.readFileSync(path.join(ROOT, "js", "map.js"), "utf8");
  assert.match(map, /SH\.applyNavPermissions\(\)/);
});
