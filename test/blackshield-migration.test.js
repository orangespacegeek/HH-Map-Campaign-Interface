"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const ADMIN_PW = "test-admin-pw-123";

function writeJson(dir, name, data) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2) + "\n");
}

function backups(dir) {
  const folder = path.join(dir, "backups");
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).filter((name) => name.startsWith("pre-blackshield-")).sort();
}

function startServer(dataDir) {
  const port = 29000 + Math.floor(Math.random() * 20000);
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

function byId(rows, key, id) {
  return rows.find((row) => Number(row[key]) === Number(id));
}

test("Blackshield players need a side and forces follow the owner", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-shield-"));
  writeJson(dataDir, "players.json", [
    {
      player_id: 1,
      player_name: "Ada",
      display_name: "Ada",
      status: "active",
      role: "player",
      allegiance: "Loyalist"
    },
    {
      player_id: 2,
      player_name: "Horus",
      display_name: "Horus",
      status: "active",
      role: "player",
      allegiance: "Traitor"
    },
    {
      player_id: 3,
      player_name: "Shade",
      display_name: "Shade",
      status: "active",
      role: "player",
      allegiance: "Blackshield"
    },
    {
      player_id: 4,
      player_name: "Quiet",
      display_name: "Quiet",
      status: "inactive",
      role: "player",
      allegiance: "blackshields"
    }
  ]);
  writeJson(dataDir, "forces.json", [
    {
      force_id: 1,
      player_id: 1,
      force_name: "Blank type",
      allegiance: "Blackshield",
      force_type: "",
      status: "active",
      sys_id: 2,
      strength: 3
    },
    {
      force_id: 2,
      player_id: 1,
      force_name: "Keep legion",
      allegiance: "Blackshield",
      force_type: "Legion",
      status: "active",
      sys_id: 2,
      strength: 3
    },
    {
      force_id: 3,
      player_id: 3,
      force_name: "Unassigned",
      allegiance: "Blackshield",
      force_type: "",
      status: "active",
      sys_id: 1,
      strength: 3
    },
    {
      force_id: 4,
      player_id: 2,
      force_name: "Untouched",
      allegiance: "Traitor",
      force_type: "Legion",
      status: "active",
      sys_id: 4,
      strength: 3
    },
    {
      force_id: 5,
      player_id: 4,
      force_name: "Kept militia",
      allegiance: "Blackshield",
      force_type: "Militia",
      status: "active",
      sys_id: 1,
      strength: 3
    }
  ]);

  const first = startServer(dataDir);
  try {
    const log = await first.ready;
    assert.match(log, /Blackshield migration/);
    assert.equal(backups(dataDir).length, 1);
    const backup = JSON.parse(fs.readFileSync(path.join(dataDir, "backups", backups(dataDir)[0]), "utf8"));
    assert.equal(byId(backup.players, "player_id", 3).allegiance, "Blackshield");
    assert.equal(byId(backup.forces, "force_id", 2).force_type, "Legion");

    const adminLogin = await api(first, null, "POST", "/api/auth/login", { login: "admin", password: ADMIN_PW });
    assert.equal(adminLogin.status, 200, JSON.stringify(adminLogin.json));
    const admin = adminLogin.json.token;

    const players = await api(first, admin, "GET", "/api/players");
    assert.equal(players.status, 200, JSON.stringify(players.json));
    assert.equal(byId(players.json, "player_id", 1).allegiance, "Loyalist");
    assert.equal(byId(players.json, "player_id", 2).allegiance, "Traitor");
    assert.equal(byId(players.json, "player_id", 3).allegiance, "needs side");
    assert.equal(byId(players.json, "player_id", 4).allegiance, "needs side");

    const forces = await api(first, admin, "GET", "/api/forces");
    assert.equal(byId(forces.json, "force_id", 1).allegiance, "Loyalist");
    assert.equal(byId(forces.json, "force_id", 1).force_type, "Blackshields");
    assert.equal(byId(forces.json, "force_id", 2).allegiance, "Loyalist");
    assert.equal(byId(forces.json, "force_id", 2).force_type, "Legion");
    assert.equal(byId(forces.json, "force_id", 3).allegiance, "Blackshield");
    assert.equal(byId(forces.json, "force_id", 3).force_type, "Blackshields");
    assert.equal(byId(forces.json, "force_id", 4).allegiance, "Traitor");
    assert.equal(byId(forces.json, "force_id", 4).force_type, "Legion");
    assert.equal(byId(forces.json, "force_id", 5).allegiance, "Blackshield");
    assert.equal(byId(forces.json, "force_id", 5).force_type, "Militia");

    const roster = await api(first, admin, "GET", "/api/actions/players");
    assert.equal(roster.status, 200, JSON.stringify(roster.json));
    assert.equal(roster.json.active_players, 2);
    assert.equal(roster.json.players.some((player) => player.player_id === 3), false);
    assert.equal(roster.json.players.some((player) => player.player_id === 4), false);
    const waiting = roster.json.needs_side.map((player) => player.player_id).sort();
    assert.deepEqual(waiting, [3, 4]);

    const blocked = await api(first, admin, "POST", "/api/actions/fortify", { player_id: 3, sys_id: 2 });
    assert.equal(blocked.status, 400, JSON.stringify(blocked.json));
    assert.match(blocked.json.error, /needs a Loyalist or Traitor side/);

    const inv = await api(first, admin, "POST", "/api/auth/invites", { note: "shield" });
    assert.equal(inv.status, 201, JSON.stringify(inv.json));
    const rejected = await api(first, null, "POST", "/api/auth/signup", {
      invite_code: inv.json.invite.code,
      login: "shade2",
      password: "botpass-xyz",
      player_name: "Shade Two",
      display_name: "Shade Two",
      allegiance: "Blackshield"
    });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.json));
    assert.match(rejected.json.error, /Loyalist or Traitor/);

    const created = await api(first, admin, "POST", "/api/players", {
      player_name: "Nope",
      display_name: "Nope",
      status: "active",
      role: "player",
      allegiance: "Blackshield"
    });
    assert.equal(created.status, 400, JSON.stringify(created.json));

    const assigned = await api(first, admin, "PUT", "/api/players/3", { allegiance: "Traitor" });
    assert.equal(assigned.status, 200, JSON.stringify(assigned.json));
    assert.equal(assigned.json.allegiance, "Traitor");
    const after = await api(first, admin, "GET", "/api/forces");
    assert.equal(byId(after.json, "force_id", 3).allegiance, "Traitor");
    assert.equal(byId(after.json, "force_id", 3).force_type, "Blackshields");
    assert.equal(byId(after.json, "force_id", 5).allegiance, "Blackshield");
    const stillWaiting = await api(first, admin, "GET", "/api/actions/players");
    assert.equal(stillWaiting.json.needs_side.some((player) => player.player_id === 3), false);
    assert.equal(stillWaiting.json.needs_side.some((player) => player.player_id === 4), true);
    assert.equal(stillWaiting.json.players.some((player) => player.player_id === 3), true);

    const signup = await api(first, null, "POST", "/api/auth/signup", {
      invite_code: inv.json.invite.code,
      login: "sideloyal",
      password: "botpass-xyz",
      player_name: "Side Loyal",
      display_name: "Side Loyal",
      allegiance: "Loyalist"
    });
    assert.equal(signup.status, 201, JSON.stringify(signup.json));
    const made = await api(first, admin, "POST", "/api/forces", {
      player_id: signup.json.player_id,
      force_name: "Wrong side",
      allegiance: "Traitor",
      force_type: "Blackshield",
      status: "active",
      sys_id: 2,
      strength: 3,
      game_system: "HH"
    });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    assert.equal(made.json.allegiance, "Loyalist");
    assert.equal(made.json.force_type, "Blackshields");

    const playerEdit = await api(first, signup.json.token, "PUT", "/api/forces/" + made.json.force_id, {
      allegiance: "Traitor",
      force_type: "Militia"
    });
    assert.equal(playerEdit.status, 200, JSON.stringify(playerEdit.json));
    assert.equal(playerEdit.json.allegiance, "Loyalist");
    assert.equal(playerEdit.json.force_type, "Militia");

    const adminEdit = await api(first, admin, "PUT", "/api/forces/" + made.json.force_id, {
      allegiance: "Traitor"
    });
    assert.equal(adminEdit.status, 200, JSON.stringify(adminEdit.json));
    assert.equal(adminEdit.json.allegiance, "Loyalist");
    assert.equal(adminEdit.json.force_type, "Militia");

    const early = await api(first, admin, "PUT", "/api/forces/5", { force_name: "Still waiting" });
    assert.equal(early.status, 400, JSON.stringify(early.json));
    assert.match(early.json.error, /Assign this player a Loyalist or Traitor side/);
  } finally {
    await first.stop();
  }

  const second = startServer(dataDir);
  try {
    const log = await second.ready;
    assert.doesNotMatch(log, /Blackshield migration/);
    assert.equal(backups(dataDir).length, 1);
    const players = JSON.parse(fs.readFileSync(path.join(dataDir, "players.json"), "utf8"));
    assert.equal(byId(players, "player_id", 3).allegiance, "Traitor");
    assert.equal(byId(players, "player_id", 4).allegiance, "needs side");
    const forces = JSON.parse(fs.readFileSync(path.join(dataDir, "forces.json"), "utf8"));
    assert.equal(byId(forces, "force_id", 3).allegiance, "Traitor");
    assert.equal(byId(forces, "force_id", 3).force_type, "Blackshields");
    assert.equal(byId(forces, "force_id", 5).allegiance, "Blackshield");
    assert.equal(byId(forces, "force_id", 5).force_type, "Militia");
  } finally {
    await second.stop();
  }
});
