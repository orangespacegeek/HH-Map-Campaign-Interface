"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const ADMIN_PW = "test-admin-pw-123";
const LOYAL_ID = "111111111111111111";
const TRAITOR_ID = "222222222222222222";
const THIRD_ID = "333333333333333333";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startWebhook() {
  const posts = [];
  const options = { status: 204, delayMs: 0, hang: false };
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        body = { raw: Buffer.concat(chunks).toString("utf8") };
      }
      const status = options.status || 204;
      const delayMs = options.delayMs || 0;
      const hang = options.hang;
      posts.push(body);
      if (hang) return;
      setTimeout(() => {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(status);
        res.end();
      }, delayMs);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        posts,
        url: "http://127.0.0.1:" + addr.port + "/api/webhooks/test/hook",
        setStatus(code) {
          options.status = code;
        },
        setDelay(ms) {
          options.delayMs = ms;
        },
        setHang(on) {
          options.hang = !!on;
        },
        stop() {
          sockets.forEach((socket) => socket.destroy());
          return new Promise((done) => {
            server.close(() => done());
          });
        }
      });
    });
  });
}

function startServer(options = {}) {
  const dataDir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), "hh-discord-"));
  const port = 33000 + Math.floor(Math.random() * 20000);
  const env = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    DATA_DIR: dataDir,
    CAMPAIGN_ADMIN_PASSWORD: ADMIN_PW,
    CAMPAIGN_ADMIN_FORCE_PASSWORD: "1",
    TRUST_PROXY: "",
    AUTO_ADVANCE_INTERVAL_MS: String(options.intervalMs == null ? 60000 : options.intervalMs),
    DISCORD_CAMPAIGN_WEBHOOK: options.webhook || "",
    DISCORD_WEBHOOK_TIMEOUT_MS: options.timeoutMs == null ? "" : String(options.timeoutMs)
  };
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env,
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

async function signup(ctx, admin, name, allegiance, start) {
  const inv = await api(ctx, admin, "POST", "/api/auth/invites", { note: name });
  assert.equal(inv.status, 201, JSON.stringify(inv.json));
  const body = {
    invite_code: inv.json.invite.code,
    login: name,
    password: "botpass-xyz",
    player_name: name,
    display_name: name,
    allegiance
  };
  if (start != null) body.start_sys_id = start;
  const res = await api(ctx, null, "POST", "/api/auth/signup", body);
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { token: res.json.token, player_id: res.json.player_id, name };
}

async function waitFor(fn, timeout = 4000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = fn();
    if (last) return last;
    await sleep(20);
  }
  throw new Error("timed out waiting for webhook: " + JSON.stringify(last));
}

async function waitForCount(mock, count, timeout = 4000) {
  await waitFor(() => mock.posts.length >= count, timeout);
}

async function waitForQuiet(mock, timeout = 4000) {
  const start = Date.now();
  let last = -1;
  let stableSince = Date.now();
  while (Date.now() - start < timeout) {
    if (mock.posts.length !== last) {
      last = mock.posts.length;
      stableSince = Date.now();
    } else if (last > 0 && Date.now() - stableSince >= 160) {
      return mock.posts.slice();
    }
    await sleep(20);
  }
  throw new Error("webhook did not settle at " + mock.posts.length);
}

function joined(posts) {
  return posts.map((post) => post.content || "").join("\n");
}

function assertMentionsClosed(post) {
  assert.deepEqual(post.allowed_mentions.parse, []);
  assert.ok(Array.isArray(post.allowed_mentions.users));
  const mentioned = [];
  const re = /<@(\d+)>/g;
  let match;
  while ((match = re.exec(post.content || ""))) mentioned.push(match[1]);
  mentioned.forEach((id) => {
    assert.ok(post.allowed_mentions.users.includes(id), post.content);
  });
  post.allowed_mentions.users.forEach((id) => {
    assert.ok((post.content || "").includes("<@" + id + ">"), JSON.stringify(post));
  });
  assert.equal(post.allowed_mentions.users.length, new Set(post.allowed_mentions.users).size);
}

test("a Discord user ID is optional, validated, and private", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const admin = await adminToken(ctx);
    const loyal = await signup(ctx, admin, "id_loyal", "Loyalist", 2);
    const traitor = await signup(ctx, admin, "id_traitor", "Traitor", 4);
    const shortId = await api(ctx, loyal.token, "PUT", "/api/players/" + loyal.player_id, {
      display_name: "id_loyal",
      discord_user_id: "12345"
    });
    assert.equal(shortId.status, 400, JSON.stringify(shortId.json));
    const letters = await api(ctx, loyal.token, "PUT", "/api/players/" + loyal.player_id, {
      display_name: "id_loyal",
      discord_user_id: "12345678901234567a"
    });
    assert.equal(letters.status, 400);
    const asNumber = await api(ctx, loyal.token, "PUT", "/api/players/" + loyal.player_id, {
      display_name: "id_loyal",
      discord_user_id: 42
    });
    assert.equal(asNumber.status, 400);
    const saved = await api(ctx, loyal.token, "PUT", "/api/players/" + loyal.player_id, {
      display_name: "id_loyal",
      discord_user_id: "  " + LOYAL_ID + "  "
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.equal(saved.json.discord_user_id, LOYAL_ID);

    const kept = await api(ctx, loyal.token, "PUT", "/api/players/" + loyal.player_id, {
      display_name: "id_loyal",
      contact: "table"
    });
    assert.equal(kept.status, 200, JSON.stringify(kept.json));
    assert.equal(kept.json.discord_user_id, LOYAL_ID);

    const badAfter = await api(ctx, loyal.token, "PUT", "/api/players/" + loyal.player_id, {
      display_name: "id_loyal",
      discord_user_id: "nope"
    });
    assert.equal(badAfter.status, 400);
    const still = await api(ctx, loyal.token, "GET", "/api/players/" + loyal.player_id);
    assert.equal(still.json.discord_user_id, LOYAL_ID);

    const me = await api(ctx, loyal.token, "GET", "/api/auth/me");
    assert.equal(me.json.player.discord_user_id, LOYAL_ID);

    const ownList = await api(ctx, loyal.token, "GET", "/api/players");
    const own = ownList.json.find((row) => row.player_id === loyal.player_id);
    const other = ownList.json.find((row) => row.player_id === traitor.player_id);
    assert.equal(own.discord_user_id, LOYAL_ID);
    assert.equal(Object.prototype.hasOwnProperty.call(other, "discord_user_id"), false);

    const seenByOther = await api(ctx, traitor.token, "GET", "/api/players/" + loyal.player_id);
    assert.equal(seenByOther.status, 200);
    assert.equal(Object.prototype.hasOwnProperty.call(seenByOther.json, "discord_user_id"), false);
    assert.equal(seenByOther.text.includes(LOYAL_ID), false);

    const pub = await api(ctx, null, "GET", "/api/public/players");
    assert.equal(pub.text.includes(LOYAL_ID), false);
    pub.json.forEach((row) => {
      assert.equal(Object.prototype.hasOwnProperty.call(row, "discord_user_id"), false);
    });

    const adminRow = await api(ctx, admin, "GET", "/api/players/" + loyal.player_id);
    assert.equal(adminRow.json.discord_user_id, LOYAL_ID);
    const adminSet = await api(ctx, admin, "PUT", "/api/players/" + traitor.player_id, {
      player_name: "id_traitor",
      display_name: "id_traitor",
      discord_user_id: TRAITOR_ID
    });
    assert.equal(adminSet.status, 200, JSON.stringify(adminSet.json));
    assert.equal(adminSet.json.discord_user_id, TRAITOR_ID);
    const adminClear = await api(ctx, admin, "PUT", "/api/players/" + traitor.player_id, {
      player_name: "id_traitor",
      display_name: "id_traitor",
      discord_user_id: ""
    });
    assert.equal(adminClear.status, 200, JSON.stringify(adminClear.json));
    assert.equal(adminClear.json.discord_user_id, null);

    const cleared = await api(ctx, loyal.token, "PUT", "/api/players/" + loyal.player_id, {
      display_name: "id_loyal",
      discord_user_id: ""
    });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.json.discord_user_id, null);

    assert.equal((await api(ctx, admin, "POST", "/api/campaign/reset", { confirm: "RESET" })).status, 200);
    const roster = await api(ctx, admin, "GET", "/api/campaign/muster");
    assert.equal(roster.text.includes(LOYAL_ID), false);
    const actions = await api(ctx, admin, "GET", "/api/actions/players");
    assert.equal(actions.text.includes(TRAITOR_ID), false);

    const rules = fs.readFileSync(path.join(ROOT, "rules.html"), "utf8");
    const written = fs.readFileSync(path.join(ROOT, "campaign_rules.md"), "utf8");
    const deploy = fs.readFileSync(path.join(ROOT, "DEPLOY_RENDER.md"), "utf8");
    const blueprint = fs.readFileSync(path.join(ROOT, "render.yaml"), "utf8");
    assert.match(rules, /id="discord"/);
    assert.match(rules, /Discord user ID/);
    assert.doesNotMatch(rules, /added as part of web app build/);
    assert.match(written, /\*Discord\*[\s\S]*Discord user ID[\s\S]*\(added as part of web app build\)/);
    assert.match(deploy, /DISCORD_CAMPAIGN_WEBHOOK/);
    assert.match(deploy, /New Webhook/);
    assert.match(blueprint, /DISCORD_CAMPAIGN_WEBHOOK/);
    assert.match(blueprint, /key: DISCORD_CAMPAIGN_WEBHOOK\n\s+sync: false/);
    const account = fs.readFileSync(path.join(ROOT, "account.html"), "utf8");
    assert.match(account, /Developer Mode/);
    assert.match(account, /Copy User ID/);
    assert.match(account, /btn-discord-test|discord_user_id/);
    const dashboard = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
    assert.match(dashboard, /Send test notification/);
  } finally {
    await ctx.stop();
  }
});

test("phase starts post the turn, phase, and deadline, and an unset webhook stays quiet", async () => {
  const hook = await startWebhook();
  const quiet = startServer();
  const ctx = startServer({ webhook: hook.url, intervalMs: 60000 });
  try {
    await quiet.ready;
    await ctx.ready;
    const admin = await adminToken(ctx);
    const quietAdmin = await adminToken(quiet);
    const jumped = await api(ctx, admin, "POST", "/api/campaign/set-phase", { phase: "Logistics", turn: 1 });
    assert.equal(jumped.status, 200, JSON.stringify(jumped.json));
    await sleep(200);
    assert.equal(hook.posts.length, 0);

    const manual = await api(ctx, admin, "POST", "/api/campaign/advance", {});
    assert.equal(manual.status, 200, JSON.stringify(manual.json));
    assert.equal(manual.json.to.phase, "Movement");
    assert.equal(manual.text.includes("discord"), false);
    await waitForCount(hook, 1);
    assert.match(hook.posts[0].content, /\*\*Turn 1 — Movement\*\* has started\./);
    assert.match(hook.posts[0].content, /No deadline is set\./);
    assert.deepEqual(hook.posts[0].allowed_mentions, { parse: [], users: [] });

    const past = await api(ctx, admin, "POST", "/api/campaign/phase-deadline", {
      phase_ends_at: "2020-01-01T00:00:00.000Z"
    });
    assert.equal(past.status, 200, JSON.stringify(past.json));
    assert.equal(past.json.advanced, true);
    assert.equal(past.json.phase, "Battles");
    await waitForCount(hook, 2);
    assert.match(hook.posts[1].content, /\*\*Turn 1 — Battles\*\* has started\./);
    assert.match(hook.posts[1].content, /No open battles\./);
    assert.match(hook.posts[1].content, /No deadline is set\./);
    assertMentionsClosed(hook.posts[1]);

    const quietAdvance = await api(quiet, quietAdmin, "POST", "/api/campaign/advance", {});
    assert.equal(quietAdvance.status, 200, JSON.stringify(quietAdvance.json));
    await sleep(250);
    assert.equal(hook.posts.length, 2);

    const missing = await api(quiet, quietAdmin, "POST", "/api/campaign/discord-test", {});
    assert.equal(missing.status, 400, JSON.stringify(missing.json));
    const denied = await api(ctx, null, "POST", "/api/campaign/discord-test", {});
    assert.equal(denied.status, 401);
  } finally {
    await ctx.stop();
    await quiet.stop();
    await hook.stop();
  }
});

test("all-actions auto-advance and Begin campaign post, including a Muster deadline", async () => {
  const hook = await startWebhook();
  const ctx = startServer({ webhook: hook.url, intervalMs: 60000 });
  try {
    await ctx.ready;
    const admin = await adminToken(ctx);
    const loyal = await signup(ctx, admin, "auto_loyal", "Loyalist", 2);
    assert.equal((await api(ctx, admin, "POST", "/api/campaign/reset", { confirm: "RESET" })).status, 200);
    const begun = await api(ctx, admin, "POST", "/api/campaign/begin", {});
    assert.equal(begun.status, 200, JSON.stringify(begun.json));
    assert.equal(begun.json.to.phase, "Logistics");
    await waitForCount(hook, 1);
    assert.match(hook.posts[0].content, /The campaign has begun\./);
    assert.match(hook.posts[0].content, /\*\*Turn 1 — Logistics\*\* has started\./);
    assert.match(hook.posts[0].content, /No deadline is set\./);

    assert.equal((await api(ctx, admin, "POST", "/api/campaign/auto-advance", { enabled: false })).status, 200);
    assert.equal((await api(ctx, loyal.token, "POST", "/api/actions/fortify", { sys_id: 2 })).status, 200);
    assert.equal((await api(ctx, loyal.token, "POST", "/api/actions/fortify", { sys_id: 2 })).status, 200);
    const on = await api(ctx, admin, "POST", "/api/campaign/auto-advance", { enabled: true });
    assert.equal(on.status, 200, JSON.stringify(on.json));
    assert.equal(on.json.advanced, true);
    assert.equal(on.json.phase, "Movement");
    await waitForCount(hook, 2);
    assert.match(hook.posts[1].content, /\*\*Turn 1 — Movement\*\* has started\./);
    assert.match(hook.posts[1].content, /No deadline is set\./);

    assert.equal((await api(ctx, admin, "POST", "/api/campaign/reset", { confirm: "RESET" })).status, 200);
    const held = await api(ctx, admin, "POST", "/api/campaign/phase-deadline", {
      phase_ends_at: "2020-01-01T00:00:00.000Z"
    });
    assert.equal(held.json.advanced, false);
    assert.equal(held.json.phase, "Muster");
    await sleep(200);
    assert.equal(hook.posts.length, 2);
    const muster = await api(ctx, admin, "POST", "/api/campaign/auto-advance", { muster: true });
    assert.equal(muster.status, 200, JSON.stringify(muster.json));
    assert.equal(muster.json.advanced, true);
    assert.equal(muster.json.phase, "Logistics");
    await waitForCount(hook, 3);
    assert.match(hook.posts[2].content, /The campaign has begun\./);
    assert.match(hook.posts[2].content, /\*\*Turn 1 — Logistics\*\* has started\./);
  } finally {
    await ctx.stop();
    await hook.stop();
  }
});

test("Battle phase lists open battles, and an admin-created battle posts on its own", async () => {
  const hook = await startWebhook();
  const ctx = startServer({ webhook: hook.url });
  try {
    await ctx.ready;
    const admin = await adminToken(ctx);
    const loyal = await signup(ctx, admin, "pair_loyal", "Loyalist", 2);
    const traitor = await signup(ctx, admin, "pair_traitor", "Traitor", 2);
    assert.equal((await api(ctx, admin, "POST", "/api/campaign/reset", { confirm: "RESET" })).status, 200);
    assert.equal(
      (await api(ctx, loyal.token, "PUT", "/api/players/" + loyal.player_id, {
        display_name: "pair_loyal",
        discord_user_id: LOYAL_ID
      })).status,
      200
    );
    const begun = await api(ctx, admin, "POST", "/api/campaign/begin", {});
    assert.equal(begun.status, 200, JSON.stringify(begun.json));
    assert.equal((await api(ctx, admin, "POST", "/api/campaign/advance", {})).status, 200);
    const battles = await api(ctx, admin, "POST", "/api/campaign/advance", {});
    assert.equal(battles.status, 200, JSON.stringify(battles.json));
    assert.equal(battles.json.to.phase, "Battles");
    assert.equal(battles.text.includes(LOYAL_ID), false);
    await waitForQuiet(hook);
    const startPost = hook.posts.find((post) => /Battles\*\* has started/.test(post.content));
    assert.ok(startPost, joined(hook.posts));
    assert.match(startPost.content, /No deadline is set\./);
    assert.match(startPost.content, /Open battles:/);
    const games = await api(ctx, admin, "GET", "/api/games");
    const forces = await api(ctx, admin, "GET", "/api/forces");
    const systems = await api(ctx, admin, "GET", "/api/systems");
    const players = await api(ctx, admin, "GET", "/api/players");
    const open = games.json.filter((game) => game.result_state === "open" && Number(game.turn) === 1);
    assert.ok(open.length >= 1, JSON.stringify(games.json));
    open.forEach((game) => {
      const tokenFor = (playerId, forceId) => {
        const player = players.json.find((row) => row.player_id === playerId);
        const force = forces.json.find((row) => row.force_id === forceId);
        const who = player.discord_user_id ? "<@" + player.discord_user_id + ">" : player.display_name;
        return who + " (" + player.allegiance + ", " + force.force_name + ")";
      };
      const system = systems.json.find((row) => row.sys_id === game.sys_id);
      const line =
        tokenFor(game.attacker_id, game.attacker_force_id) +
        " vs " +
        tokenFor(game.defender_id, game.defender_force_id) +
        " at " +
        system.sys_name;
      assert.ok(startPost.content.includes(line), line + "\n" + startPost.content);
    });
    assert.deepEqual(startPost.allowed_mentions.users, [LOYAL_ID]);
    assert.equal(startPost.content.includes("<@" + TRAITOR_ID + ">"), false);
    assert.match(startPost.content, /pair_traitor \(Traitor,/);
    assertMentionsClosed(startPost);

    const before = hook.posts.length;
    const created = await api(ctx, admin, "POST", "/api/games", {
      attacker_id: loyal.player_id,
      defender_id: traitor.player_id,
      attacker_force_id: open[0].attacker_force_id,
      defender_force_id: open[0].defender_force_id,
      sys_id: 3,
      turn: 1,
      result: "in_progress"
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    await waitForCount(hook, before + 1);
    const added = hook.posts[hook.posts.length - 1];
    assert.match(added.content, /A battle was added during \*\*Turn 1 — Battles\*\*\./);
    assert.match(added.content, /<@111111111111111111> \(Loyalist,/);
    assert.match(added.content, /pair_traitor \(Traitor,/);
    assert.match(added.content, / at /);
    assert.deepEqual(added.allowed_mentions, { parse: [], users: [LOYAL_ID] });
    const playerCreate = await api(ctx, loyal.token, "POST", "/api/games", {
      attacker_id: loyal.player_id,
      defender_id: traitor.player_id,
      attacker_force_id: open[0].attacker_force_id,
      defender_force_id: open[0].defender_force_id,
      sys_id: 5,
      turn: 1,
      result: "in_progress"
    });
    assert.notEqual(playerCreate.status, 201);
    await sleep(200);
    assert.equal(hook.posts.length, before + 1);
  } finally {
    await ctx.stop();
    await hook.stop();
  }
});

test("the 24h reminder is sent once per deadline and survives a restart", async () => {
  const hook = await startWebhook();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-discord-remind-"));
  const ctx = startServer({ webhook: hook.url, dataDir, intervalMs: 200 });
  try {
    await ctx.ready;
    const admin = await adminToken(ctx);
    const moved = await api(ctx, admin, "POST", "/api/campaign/set-phase", { phase: "Movement", turn: 2 });
    assert.equal(moved.status, 200);
    await sleep(250);
    assert.equal(hook.posts.length, 0);

    const later = new Date(Date.now() + 30 * 60 * 60 * 1000).toISOString();
    const far = await api(ctx, admin, "POST", "/api/campaign/phase-deadline", { phase_ends_at: later });
    assert.equal(far.status, 200, JSON.stringify(far.json));
    assert.equal(far.json.advanced, false);
    await sleep(300);
    assert.equal(hook.posts.length, 0);

    const soon = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const near = await api(ctx, admin, "POST", "/api/campaign/phase-deadline", { phase_ends_at: soon });
    assert.equal(near.status, 200, JSON.stringify(near.json));
    const unix = Math.floor(Date.parse(near.json.phase_ends_at) / 1000);
    await waitForCount(hook, 1);
    assert.match(hook.posts[0].content, /\*\*Turn 2 — Movement\*\* ends in under 24 hours\./);
    assert.match(hook.posts[0].content, new RegExp("Deadline: <t:" + unix + ":F> \\(<t:" + unix + ":R>\\)"));
    assert.deepEqual(hook.posts[0].allowed_mentions, { parse: [], users: [] });
    const meta = JSON.parse(fs.readFileSync(path.join(dataDir, "meta.json"), "utf8"));
    assert.equal(meta.discord_deadline_reminder_key, "2|Movement|" + near.json.phase_ends_at);
    const pub = await api(ctx, null, "GET", "/api/public/meta");
    assert.equal(Object.prototype.hasOwnProperty.call(pub.json, "discord_deadline_reminder_key"), false);

    await sleep(400);
    assert.equal(hook.posts.length, 1);

    const again = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString();
    const changed = await api(ctx, admin, "POST", "/api/campaign/phase-deadline", { phase_ends_at: again });
    assert.equal(changed.status, 200);
    await waitForCount(hook, 2);
    assert.match(hook.posts[1].content, /ends in under 24 hours/);
  } finally {
    await ctx.stop();
  }

  const restarted = startServer({ webhook: hook.url, dataDir, intervalMs: 200 });
  try {
    await restarted.ready;
    await sleep(500);
    assert.equal(hook.posts.length, 2);
  } finally {
    await restarted.stop();
    await hook.stop();
  }
});

test("a Battles reminder mentions only players with unreported battles", async () => {
  const hook = await startWebhook();
  const ctx = startServer({ webhook: hook.url, intervalMs: 200 });
  try {
    await ctx.ready;
    const admin = await adminToken(ctx);
    const loyal = await signup(ctx, admin, "ping_loyal", "Loyalist", 2);
    const traitor = await signup(ctx, admin, "ping_traitor", "Traitor", 4);
    const done = await signup(ctx, admin, "ping_done", "Loyalist", 5);
    for (const [player, id] of [
      [loyal, LOYAL_ID],
      [traitor, TRAITOR_ID],
      [done, THIRD_ID]
    ]) {
      const saved = await api(ctx, admin, "PUT", "/api/players/" + player.player_id, {
        player_name: player.name,
        display_name: player.name,
        discord_user_id: id
      });
      assert.equal(saved.status, 200, JSON.stringify(saved.json));
    }
    const forces = (await api(ctx, admin, "GET", "/api/forces")).json;
    function forceId(playerId) {
      const row = forces.find((force) => force.player_id === playerId && force.status !== "removed");
      assert.ok(row);
      return row.force_id;
    }
    assert.equal((await api(ctx, admin, "POST", "/api/campaign/set-phase", { phase: "Battles", turn: 1 })).status, 200);
    const open = await api(ctx, admin, "POST", "/api/games", {
      attacker_id: loyal.player_id,
      defender_id: traitor.player_id,
      attacker_force_id: forceId(loyal.player_id),
      defender_force_id: forceId(traitor.player_id),
      sys_id: 1,
      turn: 1,
      result: "in_progress"
    });
    assert.equal(open.status, 201, JSON.stringify(open.json));
    const reported = await api(ctx, admin, "POST", "/api/games", {
      attacker_id: done.player_id,
      defender_id: traitor.player_id,
      attacker_force_id: forceId(done.player_id),
      defender_force_id: forceId(traitor.player_id),
      sys_id: 6,
      turn: 1,
      result: "in_progress"
    });
    assert.equal(reported.status, 201, JSON.stringify(reported.json));
    const applied = await api(ctx, admin, "PUT", "/api/games/" + reported.json.game_id, {
      result: "attacker_win"
    });
    assert.equal(applied.status, 200, JSON.stringify(applied.json));
    assert.equal(applied.json.result_state, "applied");
    await waitForQuiet(hook);

    const soon = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    const beforeReminder = hook.posts.length;
    const deadline = await api(ctx, admin, "POST", "/api/campaign/phase-deadline", { phase_ends_at: soon });
    assert.equal(deadline.status, 200, JSON.stringify(deadline.json));
    assert.equal(deadline.json.advanced, false);
    await waitForCount(hook, beforeReminder + 1);
    const reminder = hook.posts[hook.posts.length - 1];
    const loyalForce = forces.find((force) => force.player_id === loyal.player_id && force.status !== "removed");
    const traitorForce = forces.find((force) => force.player_id === traitor.player_id && force.status !== "removed");
    assert.match(reminder.content, /\*\*Turn 1 — Battles\*\* ends in under 24 hours\./);
    assert.match(reminder.content, /Unreported battles:/);
    assert.ok(reminder.content.includes("<@" + LOYAL_ID + "> (Loyalist, " + loyalForce.force_name + ")"));
    assert.ok(reminder.content.includes("<@" + TRAITOR_ID + "> (Traitor, " + traitorForce.force_name + ")"));
    assert.match(reminder.content, / at Port Maw/);
    assert.equal(reminder.content.includes("ping_done"), false);
    assert.equal(reminder.content.includes("<@" + THIRD_ID + ">"), false);
    assert.deepEqual(reminder.allowed_mentions.parse, []);
    assert.deepEqual(reminder.allowed_mentions.users.slice().sort(), [LOYAL_ID, TRAITOR_ID].sort());
    assertMentionsClosed(reminder);
    const count = hook.posts.length;
    await sleep(450);
    assert.equal(hook.posts.length, count);
  } finally {
    await ctx.stop();
    await hook.stop();
  }
});

test("long battle lists split at 2000 characters and mentions stay with their chunk", async () => {
  const hook = await startWebhook();
  const ctx = startServer({ webhook: hook.url });
  try {
    await ctx.ready;
    const admin = await adminToken(ctx);
    const loyal = await signup(ctx, admin, "split_loyal", "Loyalist", 2);
    const traitor = await signup(ctx, admin, "split_traitor", "Traitor", 4);
    assert.equal(
      (await api(ctx, loyal.token, "PUT", "/api/players/" + loyal.player_id, {
        display_name: "split_loyal",
        discord_user_id: LOYAL_ID
      })).status,
      200
    );
    assert.equal(
      (await api(ctx, traitor.token, "PUT", "/api/players/" + traitor.player_id, {
        display_name: "split_traitor",
        discord_user_id: TRAITOR_ID
      })).status,
      200
    );
    const forces = (await api(ctx, admin, "GET", "/api/forces")).json;
    const loyalForce = forces.find((force) => force.player_id === loyal.player_id);
    const traitorForce = forces.find((force) => force.player_id === traitor.player_id);
    const longLoyal = "L" + "a".repeat(89);
    const longTraitor = "T" + "b".repeat(89);
    assert.equal(
      (await api(ctx, admin, "PUT", "/api/forces/" + loyalForce.force_id, { force_name: longLoyal })).status,
      200
    );
    assert.equal(
      (await api(ctx, admin, "PUT", "/api/forces/" + traitorForce.force_id, { force_name: longTraitor })).status,
      200
    );
    assert.equal((await api(ctx, admin, "POST", "/api/campaign/advance", {})).status, 200);
    await waitForCount(hook, 1);
    const systems = (await api(ctx, admin, "GET", "/api/systems")).json;
    for (const system of systems) {
      const created = await api(ctx, admin, "POST", "/api/games", {
        attacker_id: loyal.player_id,
        defender_id: traitor.player_id,
        attacker_force_id: loyalForce.force_id,
        defender_force_id: traitorForce.force_id,
        sys_id: system.sys_id,
        turn: 1,
        result: "in_progress"
      });
      assert.equal(created.status, 201, JSON.stringify(created.json));
    }
    await waitForQuiet(hook, 8000);
    const before = hook.posts.length;
    const advanced = await api(ctx, admin, "POST", "/api/campaign/advance", {});
    assert.equal(advanced.status, 200, JSON.stringify(advanced.json));
    assert.equal(advanced.json.to.phase, "Battles");
    await waitFor(() => hook.posts.length >= before + 2, 8000);
    await waitForQuiet(hook, 8000);
    const chunks = hook.posts.slice(before);
    assert.ok(chunks.length >= 2, "expected a split, got " + chunks.length);
    chunks.forEach((post) => {
      assert.ok(post.content.length <= 2000, String(post.content.length));
      assertMentionsClosed(post);
    });
    const text = joined(chunks);
    assert.match(text, /Battles\*\* has started/);
    assert.match(text, /Open battles:/);
    systems.forEach((system) => {
      assert.ok(text.includes(" at " + system.sys_name), system.sys_name);
    });
    assert.ok(text.includes("<@" + LOYAL_ID + ">"));
    assert.ok(text.includes("<@" + TRAITOR_ID + ">"));
    const users = new Set(chunks.flatMap((post) => post.allowed_mentions.users));
    assert.deepEqual([...users].sort(), [LOYAL_ID, TRAITOR_ID].sort());
  } finally {
    await ctx.stop();
    await hook.stop();
  }
});

test("a webhook failure does not block or roll back a phase advance", async () => {
  const hook = await startWebhook();
  hook.setDelay(1200);
  const ctx = startServer({ webhook: hook.url, timeoutMs: 4000 });
  try {
    await ctx.ready;
    const admin = await adminToken(ctx);
    const started = Date.now();
    const advanced = await api(ctx, admin, "POST", "/api/campaign/advance", {});
    const elapsed = Date.now() - started;
    assert.equal(advanced.status, 200, JSON.stringify(advanced.json));
    assert.equal(advanced.json.to.phase, "Movement");
    assert.ok(elapsed < 800, "advance waited for Discord (" + elapsed + "ms)");
    hook.setDelay(0);
    await waitForCount(hook, 1);

    hook.setStatus(500);
    const next = await api(ctx, admin, "POST", "/api/campaign/advance", {});
    assert.equal(next.status, 200, JSON.stringify(next.json));
    assert.equal(next.json.to.phase, "Battles");
    await waitFor(() => ctx.log().includes("Discord campaign webhook returned 500"));
    const stayed = await api(ctx, admin, "GET", "/api/campaign/status");
    assert.equal(stayed.json.phase, "Battles");
    assert.equal(stayed.json.turn, 1);

    const testPost = await api(ctx, admin, "POST", "/api/campaign/discord-test", {});
    assert.equal(testPost.status, 502, JSON.stringify(testPost.json));
    hook.setStatus(204);
    const ok = await api(ctx, admin, "POST", "/api/campaign/discord-test", {});
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    await waitFor(() => hook.posts.some((post) => /test notification/.test(post.content || "")));
    const testMessage = hook.posts.find((post) => /test notification/.test(post.content || ""));
    assert.deepEqual(testMessage.allowed_mentions, { parse: [], users: [] });
  } finally {
    await ctx.stop();
    await hook.stop();
  }
});

test("a hung webhook times out without leaving the new phase", async () => {
  const hook = await startWebhook();
  hook.setHang(true);
  const ctx = startServer({ webhook: hook.url, timeoutMs: 200 });
  try {
    await ctx.ready;
    const admin = await adminToken(ctx);
    const started = Date.now();
    const advanced = await api(ctx, admin, "POST", "/api/campaign/advance", {});
    assert.equal(advanced.status, 200, JSON.stringify(advanced.json));
    assert.ok(Date.now() - started < 800);
    await waitFor(() => /Discord campaign webhook failed/.test(ctx.log()), 3000);
    const status = await api(ctx, admin, "GET", "/api/campaign/status");
    assert.equal(status.json.phase, "Movement");
  } finally {
    await ctx.stop();
    await hook.stop();
  }
});

test("a non-Discord campaign webhook URL is ignored", async () => {
  const ctx = startServer({ webhook: "https://example.com/api/webhooks/1/secret" });
  try {
    await ctx.ready;
    const admin = await adminToken(ctx);
    const advanced = await api(ctx, admin, "POST", "/api/campaign/advance", {});
    assert.equal(advanced.status, 200, JSON.stringify(advanced.json));
    assert.match(ctx.log(), /DISCORD_CAMPAIGN_WEBHOOK is set but is not a Discord webhook URL/);
    const testPost = await api(ctx, admin, "POST", "/api/campaign/discord-test", {});
    assert.equal(testPost.status, 400);
  } finally {
    await ctx.stop();
  }
});
