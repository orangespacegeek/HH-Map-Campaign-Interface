"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const ADMIN_PW = "test-admin-pw-123";
const LEGACY = "Port Maw";

function writeJson(dir, name, value) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2) + "\n");
}

function readJson(dir, name) {
  return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
}

function placeBackups(dir) {
  const backupDir = path.join(dir, "backups");
  if (!fs.existsSync(backupDir)) return [];
  return fs.readdirSync(backupDir).filter((name) => name.startsWith("pre-ajale-sector-")).sort();
}

function startServer(dataDir) {
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
        resolve(log);
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

function legacyCampaign(dir) {
  writeJson(dir, "meta.json", {
    campaign_name: "Sunset Heresy",
    subsector: LEGACY,
    turn: 4,
    phase: "Battles",
    loyal_score: 11,
    traitor_score: 8,
    roster_locked: true,
    next_player_id: 8
  });
  writeJson(dir, "systems.json", [
    {
      sys_id: 1,
      sys_name: LEGACY,
      sys_type: "Fleet Anchorage",
      sys_power: 5,
      sys_durability: 5,
      sys_loyal: 3,
      sys_traitor: 3,
      sys_neut: 0,
      sys_controller: "Contested",
      sys_struct: "Orbital docks",
      sys_links: "2,3,4",
      sys_notes: "Sub-sector capital",
      sys_x: 400,
      sys_y: 270
    },
    {
      sys_id: 2,
      sys_name: LEGACY + " Outpost",
      sys_type: "Void",
      sys_power: 1,
      sys_durability: 5,
      sys_loyal: 0,
      sys_traitor: 1,
      sys_neut: 0,
      sys_controller: "Traitor",
      sys_links: "1",
      sys_notes: "Kept its own name",
      sys_x: 180,
      sys_y: 90
    },
    {
      sys_id: 3,
      sys_name: "Haven",
      sys_type: "Civilised",
      sys_power: 2,
      sys_durability: 5,
      sys_loyal: 4,
      sys_traitor: 0,
      sys_neut: 0,
      sys_controller: "Loyalist",
      sys_links: "1",
      sys_notes: "",
      sys_x: 20,
      sys_y: 30
    },
    {
      sys_id: 4,
      sys_name: "Ajale Sector",
      sys_type: "Hive",
      sys_power: 3,
      sys_durability: 5,
      sys_loyal: 1,
      sys_traitor: 1,
      sys_neut: 0,
      sys_controller: "Contested",
      sys_links: "",
      sys_notes: "Already renamed",
      sys_x: 12,
      sys_y: 12
    }
  ]);
  writeJson(dir, "players.json", [
    {
      player_id: 7,
      player_name: "Kept",
      display_name: "Kept",
      allegiance: "Loyalist",
      status: "active",
      notes: "Met at " + LEGACY,
      start_sys_id: 1
    }
  ]);
  writeJson(dir, "forces.json", [
    {
      force_id: 1,
      player_id: 7,
      force_name: "Kept I",
      allegiance: "Loyalist",
      status: "active",
      sys_id: 1,
      strength: 3
    },
    {
      force_id: 2,
      player_id: 7,
      force_name: "Kept II",
      allegiance: "Loyalist",
      status: "active",
      sys_id: 3,
      strength: 3
    }
  ]);
  writeJson(dir, "games.json", [
    {
      game_id: 3,
      sys_id: 1,
      turn: 4,
      result: "in_progress",
      notes: "Fought near " + LEGACY
    }
  ]);
  writeJson(dir, "accounts.json", [
    {
      account_id: 2,
      role: "player",
      login: "kept_user",
      player_id: 7,
      pass_hash: "abc",
      pass_salt: "def"
    }
  ]);
}

test("an exact legacy place name is renamed once and custom data stays", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-ajale-"));
  legacyCampaign(dataDir);
  const first = startServer(dataDir);
  try {
    const log = await first.ready;
    assert.match(log, /Place-name migration: renamed the legacy sector label and system label/);
    assert.equal(placeBackups(dataDir).length, 1);
    const backup = readJson(dataDir, path.join("backups", placeBackups(dataDir)[0]));
    assert.equal(backup.meta.subsector, LEGACY);
    assert.equal(backup.systems[0].sys_name, LEGACY);
    assert.equal(backup.systems[0].sys_id, 1);
    assert.equal(backup.systems[0].sys_links, "2,3,4");

    const meta = readJson(dataDir, "meta.json");
    assert.equal(meta.subsector, "Ajale Sector");
    assert.equal(meta.turn, 4);
    assert.equal(meta.phase, "Battles");
    assert.equal(meta.loyal_score, 11);
    assert.equal(meta.traitor_score, 8);
    assert.equal(meta.roster_locked, true);
    assert.equal(meta.next_player_id, 8);

    const systems = readJson(dataDir, "systems.json");
    assert.equal(systems[0].sys_name, "Ajale Sector");
    assert.equal(systems[0].sys_id, 1);
    assert.equal(systems[0].sys_links, "2,3,4");
    assert.equal(systems[0].sys_x, 400);
    assert.equal(systems[0].sys_y, 270);
    assert.equal(systems[0].sys_loyal, 3);
    assert.equal(systems[0].sys_traitor, 3);
    assert.equal(systems[0].sys_controller, "Contested");
    assert.equal(systems[0].sys_notes, "Sub-sector capital");
    assert.equal(systems[1].sys_name, LEGACY + " Outpost");
    assert.equal(systems[1].sys_x, 180);
    assert.equal(systems[2].sys_name, "Haven");
    assert.equal(systems[3].sys_name, "Ajale Sector");
    assert.equal(systems[3].sys_notes, "Already renamed");

    const players = readJson(dataDir, "players.json");
    assert.equal(players[0].notes, "Met at " + LEGACY);
    assert.equal(players[0].start_sys_id, 1);
    const games = readJson(dataDir, "games.json");
    assert.equal(games[0].sys_id, 1);
    assert.equal(games[0].notes, "Fought near " + LEGACY);
    const accounts = readJson(dataDir, "accounts.json");
    const kept = accounts.find((account) => account.login === "kept_user");
    assert.equal(kept.player_id, 7);
    assert.equal(kept.pass_hash, "abc");
    assert.equal(kept.pass_salt, "def");
  } finally {
    await first.stop();
  }

  const second = startServer(dataDir);
  try {
    const log = await second.ready;
    assert.doesNotMatch(log, /Place-name migration/);
    assert.equal(placeBackups(dataDir).length, 1);
    assert.equal(readJson(dataDir, "meta.json").subsector, "Ajale Sector");
    assert.equal(readJson(dataDir, "systems.json")[0].sys_name, "Ajale Sector");
    assert.equal(readJson(dataDir, "players.json")[0].notes, "Met at " + LEGACY);
  } finally {
    await second.stop();
  }
});

test("custom and near-miss place names are not renamed", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-ajale-custom-"));
  writeJson(dataDir, "meta.json", {
    campaign_name: "Sunset Heresy",
    subsector: "My Reach",
    turn: 2,
    phase: "Logistics",
    loyal_score: 4,
    traitor_score: 1
  });
  writeJson(dataDir, "systems.json", [
    { sys_id: 1, sys_name: "port maw", sys_links: "2", sys_x: 10, sys_y: 11, sys_loyal: 5, sys_controller: "Loyalist" },
    { sys_id: 2, sys_name: "PORT MAW", sys_links: "1", sys_x: 12, sys_y: 13, sys_loyal: 0, sys_controller: "Traitor" },
    { sys_id: 3, sys_name: LEGACY + " Station", sys_links: "", sys_x: 14, sys_y: 15, sys_controller: "Neutral" },
    { sys_id: 4, sys_name: "Haven", sys_links: "1", sys_x: 16, sys_y: 17, sys_controller: "Loyalist" }
  ]);
  const ctx = startServer(dataDir);
  try {
    const log = await ctx.ready;
    assert.doesNotMatch(log, /Place-name migration/);
    assert.deepEqual(placeBackups(dataDir), []);
    const meta = readJson(dataDir, "meta.json");
    assert.equal(meta.subsector, "My Reach");
    assert.equal(meta.turn, 2);
    assert.equal(meta.phase, "Logistics");
    assert.equal(meta.loyal_score, 4);
    const systems = readJson(dataDir, "systems.json");
    assert.deepEqual(systems.map((system) => system.sys_name), ["port maw", "PORT MAW", LEGACY + " Station", "Haven"]);
    assert.equal(systems[0].sys_x, 10);
    assert.equal(systems[1].sys_links, "1");
    assert.equal(systems[3].sys_controller, "Loyalist");
  } finally {
    await ctx.stop();
  }
});

test("a legacy system label is renamed without inventing a sector name", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-ajale-noname-"));
  writeJson(dataDir, "systems.json", [
    {
      sys_id: 9,
      sys_name: LEGACY,
      sys_links: "8",
      sys_x: 64,
      sys_y: 32,
      sys_loyal: 1,
      sys_traitor: 6,
      sys_controller: "Traitor"
    }
  ]);
  const ctx = startServer(dataDir);
  try {
    const log = await ctx.ready;
    assert.match(log, /Place-name migration: renamed the legacy system label/);
    const backup = readJson(dataDir, path.join("backups", placeBackups(dataDir)[0]));
    assert.equal(backup.meta, undefined);
    assert.equal(backup.systems[0].sys_name, LEGACY);
    const systems = readJson(dataDir, "systems.json");
    assert.equal(systems[0].sys_id, 9);
    assert.equal(systems[0].sys_name, "Ajale Sector");
    assert.equal(systems[0].sys_links, "8");
    assert.equal(systems[0].sys_x, 64);
    assert.equal(systems[0].sys_y, 32);
    assert.equal(systems[0].sys_traitor, 6);
    const metaPath = path.join(dataDir, "meta.json");
    if (fs.existsSync(metaPath)) {
      const meta = readJson(dataDir, "meta.json");
      assert.notEqual(meta.subsector, "Ajale Sector");
    }
  } finally {
    await ctx.stop();
  }
});

test("the sample baseline capital keeps its id, links, and position under the new name", () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "baseline", "systems.json"), "utf8"));
  const sample = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "systems.json"), "utf8"));
  const csv = fs.readFileSync(path.join(ROOT, "schema", "systems_template.csv"), "utf8");
  assert.equal(baseline.length, sample.length);
  baseline.forEach((system, index) => {
    assert.equal(system.sys_id, sample[index].sys_id);
    assert.equal(system.sys_name, sample[index].sys_name);
    assert.equal(system.sys_links, sample[index].sys_links);
    assert.equal(system.sys_x, sample[index].sys_x);
    assert.equal(system.sys_y, sample[index].sys_y);
    assert.equal(system.sys_controller, sample[index].sys_controller);
  });
  assert.equal(baseline[0].sys_id, 1);
  assert.equal(baseline[0].sys_name, "Ajale Sector");
  assert.equal(baseline[0].sys_links, "2,3,4");
  assert.equal(baseline[0].sys_x, 400);
  assert.equal(baseline[0].sys_y, 270);
  assert.ok(csv.includes("\n1,Ajale Sector,Fleet Anchorage,"));
  assert.equal(csv.includes(LEGACY), false);
});
