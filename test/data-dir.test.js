"use strict";

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { evaluateDataDirectory } = require("../server.js");

const ROOT = path.join(__dirname, "..");
const ADMIN_PW = "test-admin-pw-123";
const SAMPLE_PLAYERS = path.join(ROOT, "data", "players.json");
const SAMPLE_META = path.join(ROOT, "data", "meta.json");

function trackedDataSnapshot() {
  const dir = path.join(ROOT, "data");
  const snap = {};
  for (const name of fs.readdirSync(dir)) {
    const fp = path.join(dir, name);
    const st = fs.statSync(fp);
    if (!st.isFile()) continue;
    snap[name] = { size: st.size, mtimeMs: st.mtimeMs };
  }
  return snap;
}

function baseEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.RENDER;
  delete env.ALLOW_EPHEMERAL_DATA;
  delete env.SEED_SAMPLE_CAMPAIGN;
  delete env.DATA_DIR;
  for (const [key, value] of Object.entries(extra || {})) {
    if (value == null) delete env[key];
    else env[key] = value;
  }
  return env;
}

function runServer(extra, cwd = ROOT) {
  return spawnSync(process.execPath, ["server.js"], {
    cwd,
    env: baseEnv(extra),
    encoding: "utf8",
    timeout: 8000
  });
}

function startServer(extra) {
  const dataDir = extra.DATA_DIR;
  const port = 41000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: baseEnv({
      HOST: "127.0.0.1",
      PORT: String(port),
      CAMPAIGN_ADMIN_PASSWORD: ADMIN_PW,
      CAMPAIGN_ADMIN_FORCE_PASSWORD: "1",
      TRUST_PROXY: "",
      AUTO_ADVANCE_INTERVAL_MS: "60000",
      ...extra
    }),
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
    log() {
      return log;
    },
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

function readJson(fp) {
  return JSON.parse(fs.readFileSync(fp, "utf8"));
}

function assertEmptyCampaign(dataDir) {
  const text = dirText(dataDir);
  assert.equal(text.includes("The Warsmith"), false, text.slice(0, 500));
  assert.equal(text.includes("Warsmith Voss"), false);
  for (const name of ["players.json", "forces.json", "games.json"]) {
    const fp = path.join(dataDir, name);
    if (!fs.existsSync(fp)) continue;
    assert.deepEqual(readJson(fp), [], name);
  }
  const metaPath = path.join(dataDir, "meta.json");
  if (fs.existsSync(metaPath)) {
    const meta = readJson(metaPath);
    assert.notEqual(meta.turn, 3);
    assert.notEqual(meta.phase, "Battles");
    assert.equal(JSON.stringify(meta).includes("Warsmith"), false);
  }
  const systems = readJson(path.join(dataDir, "systems.json"));
  const baseline = readJson(path.join(ROOT, "data", "baseline", "systems.json"));
  assert.deepEqual(systems, baseline);
}

function dirText(dir) {
  let out = "";
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const fp = path.join(dir, name);
    if (fs.statSync(fp).isDirectory()) {
      out += dirText(fp);
      continue;
    }
    out += "\n" + fs.readFileSync(fp, "utf8");
  }
  return out;
}

test("development warns when DATA_DIR is unset and still allows the repo data directory", () => {
  const unset = evaluateDataDirectory({ NODE_ENV: "development" }, ROOT);
  assert.equal(unset.ok, true);
  assert.equal(unset.unset, true);
  assert.equal(unset.production, false);
  assert.equal(unset.inside, true);
  assert.equal(unset.dataDir, path.join(ROOT, "data"));
  assert.match(unset.warnings.join("\n"), /DATA_DIR is unset/);
  assert.equal(unset.errors.length, 0);

  const explicit = evaluateDataDirectory({ DATA_DIR: path.join(ROOT, "data") }, ROOT);
  assert.equal(explicit.ok, true);
  assert.equal(explicit.warnings.length, 0);

  const blank = evaluateDataDirectory({ NODE_ENV: "production", DATA_DIR: "   " }, ROOT);
  assert.equal(blank.ok, false);
  assert.equal(blank.unset, true);
  assert.match(blank.errors.join("\n"), /Refusing to start/);
});

test("production refuses an unset or in-repo DATA_DIR unless the ephemeral override is exactly 1", () => {
  const unset = evaluateDataDirectory({ NODE_ENV: "production" }, ROOT);
  assert.equal(unset.ok, false);
  assert.match(unset.errors.join("\n"), /Refusing to start/);
  assert.match(unset.errors.join("\n"), /ALLOW_EPHEMERAL_DATA=1/);
  assert.match(unset.errors.join("\n"), /\/var\/data/);

  const render = evaluateDataDirectory({ RENDER: "true" }, ROOT);
  assert.equal(render.production, true);
  assert.equal(render.ok, false);

  const renderEmpty = evaluateDataDirectory({ RENDER: "" }, ROOT);
  assert.equal(renderEmpty.production, false);
  assert.equal(renderEmpty.ok, true);

  const inside = evaluateDataDirectory(
    { NODE_ENV: "production", DATA_DIR: path.join(ROOT, "data", "..", "data") },
    ROOT
  );
  assert.equal(inside.inside, true);
  assert.equal(inside.ok, false);

  const outside = path.join(os.tmpdir(), "hh-missing-" + process.pid, "campaign");
  const external = evaluateDataDirectory({ NODE_ENV: "production", DATA_DIR: outside, RENDER: "true" }, ROOT);
  assert.equal(external.ok, true);
  assert.equal(external.inside, false);
  assert.equal(external.warnings.length, 0);
  assert.equal(external.dataDir, path.resolve(outside));

  const word = evaluateDataDirectory(
    { NODE_ENV: "production", ALLOW_EPHEMERAL_DATA: "true" },
    ROOT
  );
  assert.equal(word.ok, false);

  const override = evaluateDataDirectory(
    { NODE_ENV: "production", ALLOW_EPHEMERAL_DATA: "1" },
    ROOT
  );
  assert.equal(override.ok, true);
  assert.match(override.warnings.join("\n"), /ALLOW_EPHEMERAL_DATA=1/);
  assert.match(override.warnings.join("\n"), /will not survive/);

  const unneeded = evaluateDataDirectory(
    { NODE_ENV: "production", DATA_DIR: outside, ALLOW_EPHEMERAL_DATA: "1" },
    ROOT
  );
  assert.equal(unneeded.ok, true);
  assert.equal(unneeded.warnings.length, 0);
});

test("a symlink that points into the repo counts as inside the application directory", () => {
  const inside = fs.mkdtempSync(path.join(ROOT, ".tmp-data-target-"));
  const link = path.join(os.tmpdir(), "hh-data-link-" + process.pid + "-" + Date.now());
  fs.symlinkSync(inside, link);
  try {
    const decision = evaluateDataDirectory({ NODE_ENV: "production", DATA_DIR: link }, ROOT);
    assert.equal(decision.inside, true);
    assert.equal(decision.ok, false);
    assert.equal(decision.dataDir, path.resolve(link));
  } finally {
    fs.unlinkSync(link);
    fs.rmSync(inside, { recursive: true, force: true });
  }
});

test("the process refuses to start and does not touch the repo data directory", () => {
  const before = trackedDataSnapshot();
  const cases = [
    { NODE_ENV: "production" },
    { RENDER: "true", NODE_ENV: "development" },
    { NODE_ENV: "production", DATA_DIR: "data" },
    { NODE_ENV: "production", DATA_DIR: "./data" },
    { NODE_ENV: "production", ALLOW_EPHEMERAL_DATA: "true" }
  ];
  try {
    for (const extra of cases) {
      const result = runServer(extra);
      assert.equal(result.status, 1, JSON.stringify(extra) + "\n" + result.stdout + result.stderr);
      assert.match(result.stderr, /Refusing to start/);
      assert.match(result.stderr, /ALLOW_EPHEMERAL_DATA=1/);
      assert.equal(result.stdout.includes("Health:"), false, result.stdout);
      const loggedPath = "Data directory: " + path.join(ROOT, "data");
      assert.equal(result.stdout.includes(loggedPath), false, result.stdout);
    }
    const inside = fs.mkdtempSync(path.join(ROOT, ".tmp-data-target-"));
    const link = path.join(os.tmpdir(), "hh-data-link-" + process.pid + "-refuse");
    fs.symlinkSync(inside, link);
    try {
      const result = runServer({ NODE_ENV: "production", DATA_DIR: link });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Refusing to start/);
      assert.equal(fs.readdirSync(inside).length, 0);
    } finally {
      fs.unlinkSync(link);
      fs.rmSync(inside, { recursive: true, force: true });
    }
  } finally {
    assert.deepEqual(trackedDataSnapshot(), before);
  }
});

test("ALLOW_EPHEMERAL_DATA=1 starts, warns, and still does not copy the sample campaign", async () => {
  const dataDir = fs.mkdtempSync(path.join(ROOT, ".tmp-ephemeral-"));
  const ctx = startServer({
    NODE_ENV: "production",
    DATA_DIR: dataDir,
    ALLOW_EPHEMERAL_DATA: "1",
    SEED_SAMPLE_CAMPAIGN: "1"
  });
  try {
    await ctx.ready;
    const log = ctx.log();
    assert.match(log, /WARNING: ALLOW_EPHEMERAL_DATA=1/);
    assert.match(log, /will not survive/);
    assert.ok(log.includes("Data directory: " + dataDir), log);
    assert.match(log, /SEED_SAMPLE_CAMPAIGN=1 is ignored in production/);
    assert.equal(log.includes("The Warsmith"), false);
    assertEmptyCampaign(dataDir);
  } finally {
    await ctx.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a fresh production data directory is an empty campaign with the baseline map", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-empty-prod-"));
  const ctx = startServer({ NODE_ENV: "production", DATA_DIR: dataDir, RENDER: "true" });
  try {
    await ctx.ready;
    const log = ctx.log();
    assert.ok(log.includes("Data directory: " + dataDir), log);
    assert.equal(/Refusing to start/.test(log), false);
    assert.equal(/ALLOW_EPHEMERAL_DATA/.test(log), false);
    assert.match(log, /Seeded \d+ systems from data\/baseline\/systems.json/);
    assert.equal(log.includes("sample campaign"), false);
    assertEmptyCampaign(dataDir);

    const players = await fetch(ctx.base + "/api/public/players");
    const forces = await fetch(ctx.base + "/api/public/forces");
    const games = await fetch(ctx.base + "/api/public/games");
    const meta = await fetch(ctx.base + "/api/public/meta");
    assert.equal(players.status, 200);
    assert.deepEqual(await players.json(), []);
    assert.deepEqual(await forces.json(), []);
    assert.deepEqual(await games.json(), []);
    const metaJson = await meta.json();
    assert.notEqual(metaJson.turn, 3);
    assert.notEqual(metaJson.phase, "Battles");
    assert.equal(JSON.stringify(metaJson).includes("Warsmith"), false);
    const sampleMeta = readJson(SAMPLE_META);
    assert.equal(sampleMeta.turn, 3);
    assert.notDeepEqual(metaJson, sampleMeta);
  } finally {
    await ctx.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("development does not copy the sample campaign unless SEED_SAMPLE_CAMPAIGN=1", async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "hh-empty-dev-"));
  const opted = fs.mkdtempSync(path.join(os.tmpdir(), "hh-sample-dev-"));
  const kept = fs.mkdtempSync(path.join(os.tmpdir(), "hh-keep-dev-"));
  const customPlayers = [{ player_id: 9, player_name: "Keep Me", display_name: "Keep Me", allegiance: "Loyalist", status: "active" }];
  fs.writeFileSync(path.join(kept, "players.json"), JSON.stringify(customPlayers, null, 2));
  const plainCtx = startServer({ NODE_ENV: "development", DATA_DIR: plain });
  const optedCtx = startServer({ NODE_ENV: "development", DATA_DIR: opted, SEED_SAMPLE_CAMPAIGN: "1" });
  const keptCtx = startServer({ NODE_ENV: "development", DATA_DIR: kept, SEED_SAMPLE_CAMPAIGN: "1" });
  try {
    await plainCtx.ready;
    assert.equal(/DATA_DIR is unset/.test(plainCtx.log()), false);
    assert.ok(plainCtx.log().includes("Data directory: " + plain));
    assertEmptyCampaign(plain);

    await optedCtx.ready;
    const players = readJson(path.join(opted, "players.json"));
    const meta = readJson(path.join(opted, "meta.json"));
    assert.equal(players.some((row) => row.display_name === "The Warsmith"), true);
    assert.equal(meta.turn, 3);
    assert.equal(meta.phase, "Battles");
    assert.match(optedCtx.log(), /SEED_SAMPLE_CAMPAIGN=1/);
    const samplePlayers = readJson(SAMPLE_PLAYERS);
    assert.equal(samplePlayers[0].display_name, "The Warsmith");

    await keptCtx.ready;
    assert.deepEqual(readJson(path.join(kept, "players.json")), customPlayers);
    assert.equal(readJson(path.join(kept, "meta.json")).turn, 3);
  } finally {
    await plainCtx.stop();
    await optedCtx.stop();
    await keptCtx.stop();
    fs.rmSync(plain, { recursive: true, force: true });
    fs.rmSync(opted, { recursive: true, force: true });
    fs.rmSync(kept, { recursive: true, force: true });
  }
});

test("production ignores SEED_SAMPLE_CAMPAIGN and stays empty", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-nosample-prod-"));
  const ctx = startServer({
    NODE_ENV: "production",
    DATA_DIR: dataDir,
    SEED_SAMPLE_CAMPAIGN: "1"
  });
  try {
    await ctx.ready;
    assert.match(ctx.log(), /SEED_SAMPLE_CAMPAIGN=1 is ignored in production/);
    assertEmptyCampaign(dataDir);
    const meta = await (await fetch(ctx.base + "/api/public/meta")).json();
    assert.notEqual(meta.turn, 3);
  } finally {
    await ctx.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
