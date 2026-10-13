/**
 * Sunset Heresy shared data client + auth.
 *
 * Server mode (preferred): role-aware API with sessions.
 * Local fallback: localStorage (solo testing, no real auth).
 *
 * Auth:
 *   await SH.login({ login, password })
 *   await SH.login({ invite_code, password })
 *   await SH.logout()
 *   await SH.me()          // { authenticated, role, player_id, ... }
 *   SH.role                // visitor | player | campaign_admin
 *
 * Data:
 *   await SH.list("players")   // uses public endpoint when visitor
 *   await SH.save / remove / replaceAll
 */

(function (global) {
  const ID_KEYS = {
    players: "player_id",
    forces: "force_id",
    systems: "sys_id",
    games: "game_id",
    meta: null
  };

  const LOCAL_KEYS = {
    players: "sunset_heresy_players_v1",
    forces: "sunset_heresy_forces_v1",
    systems: "sunset_heresy_systems_v1",
    games: "sunset_heresy_games_v1",
    meta: "sunset_heresy_meta_v1"
  };

  const SEEDS = {
    players: [
      {
        player_id: 1,
        player_name: "Alex Chen",
        display_name: "The Warsmith",
        contact: "discord:vox#1234",
        status: "active",
        role: "player",
        allegiance: "Traitor",
        start_sys_id: 4,
        notes: "Prefers weekend games.",
        joined_at: "2026-08-01"
      }
    ],
    forces: [
      {
        force_id: 12,
        player_id: 1,
        force_name: "14th Grand Battalion",
        game_system: "HH",
        force_type: "Legion",
        allegiance: "Traitor",
        legion: "IV Iron Warriors",
        warlord_name: "Warsmith Voss",
        strength: 3,
        status: "active",
        sys_id: 4,
        points: 3000,
        notes: "Siege cadre. Flagship damaged at Mezoa."
      }
    ],
    systems: null,
    games: [
      {
        game_id: 17,
        turn: 3,
        played_on: "2026-08-22",
        sys_id: 4,
        game_system: "HH",
        mission: "Onslaught",
        points: 3000,
        attacker_id: 1,
        defender_id: 2,
        attacker_force_id: 12,
        defender_force_id: 5,
        attacker_vp: 7,
        defender_vp: 5,
        result: "attacker_win",
        winner_id: 1,
        attacker_list: "The Ironfire 3000",
        defender_list: "Stone Gauntlet 3000",
        notes: "Warlord duel: both survived."
      }
    ],
    meta: {
      campaign_name: "Sunset Heresy",
      subsector: "Port Maw",
      turn: 3,
      phase: "Battles",
      loyal_score: 14,
      traitor_score: 26
    }
  };

  let mode = "local";
  let probed = false;
  let token = null;
  let meCache = { authenticated: false, role: "visitor" };

  try {
    token = localStorage.getItem("sh_session_token") || null;
  } catch (_) {}

  function apiBase() {
    if (typeof location !== "undefined" && location.protocol.startsWith("http")) return "";
    return "http://localhost:3847";
  }

  function authHeaders() {
    const h = { "Content-Type": "application/json" };
    if (token) h.Authorization = "Bearer " + token;
    return h;
  }

  async function probe() {
    if (probed) return mode;
    probed = true;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch(apiBase() + "/api/public/meta", {
        signal: ctrl.signal,
        cache: "no-store",
        credentials: "include"
      });
      clearTimeout(t);
      if (res.ok) {
        mode = "server";
        await refreshMe();
        return mode;
      }
    } catch (_) {}
    mode = "local";
    meCache = { authenticated: true, role: "campaign_admin", label: "Local test admin" };
    return mode;
  }

  async function refreshMe() {
    if (mode !== "server") return meCache;
    try {
      const res = await fetch(apiBase() + "/api/auth/me", {
        headers: authHeaders(),
        credentials: "include",
        cache: "no-store"
      });
      if (res.ok) meCache = await res.json();
      else meCache = { authenticated: false, role: "visitor" };
    } catch (_) {
      meCache = { authenticated: false, role: "visitor" };
    }
    return meCache;
  }

  function localRead(collection) {
    const key = LOCAL_KEYS[collection];
    try {
      const raw = localStorage.getItem(key);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    if (SEEDS[collection] != null) {
      const seed = structuredClone(SEEDS[collection]);
      localStorage.setItem(key, JSON.stringify(seed));
      return seed;
    }
    return collection === "meta" ? {} : [];
  }

  function localWrite(collection, data) {
    localStorage.setItem(LOCAL_KEYS[collection], JSON.stringify(data));
  }

  function publicizePlayers(list) {
    return list.map((p) => ({
      player_id: p.player_id,
      display_name: p.display_name || "Unknown commander",
      allegiance: p.allegiance,
      status: p.status,
      start_sys_id: p.start_sys_id || null
    }));
  }

  async function list(collection) {
    await probe();
    if (mode === "server") {
      const role = meCache.role || "visitor";
      // Visitors and general public reads go through sanitized endpoints for players/forces
      const usePublic =
        role === "visitor" && (collection === "players" || collection === "forces" || collection === "meta" || collection === "systems" || collection === "games");
      // Always safe to use public for systems/games/meta
      const path =
        collection === "systems" || collection === "games" || collection === "meta"
          ? "/api/public/" + collection
          : usePublic || role === "visitor"
            ? "/api/public/" + collection
            : "/api/" + collection;
      const res = await fetch(apiBase() + path, {
        headers: authHeaders(),
        credentials: "include",
        cache: "no-store"
      });
      if (!res.ok) throw new Error("API " + res.status);
      return res.json();
    }
    const data = localRead(collection);
    if (collection === "players" && meCache.role === "visitor") return publicizePlayers(data);
    return data;
  }

  async function get(collection, id) {
    await probe();
    if (mode === "server") {
      const res = await fetch(apiBase() + "/api/" + collection + "/" + id, {
        headers: authHeaders(),
        credentials: "include",
        cache: "no-store"
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("API " + res.status);
      return res.json();
    }
    const rows = localRead(collection);
    const key = ID_KEYS[collection];
    return rows.find((r) => String(r[key]) === String(id)) || null;
  }

  async function save(collection, row) {
    await probe();
    const idKey = ID_KEYS[collection];
    if (mode === "server") {
      if (row[idKey] != null) {
        const res = await fetch(apiBase() + "/api/" + collection + "/" + row[idKey], {
          method: "PUT",
          headers: authHeaders(),
          credentials: "include",
          body: JSON.stringify(row)
        });
        if (res.status === 404) {
          const created = await fetch(apiBase() + "/api/" + collection, {
            method: "POST",
            headers: authHeaders(),
            credentials: "include",
            body: JSON.stringify(row)
          });
          if (!created.ok) {
            const err = await created.json().catch(() => ({}));
            throw new Error(err.error || "API " + created.status);
          }
          return created.json();
        }
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || "API " + res.status);
        }
        return res.json();
      }
      const created = await fetch(apiBase() + "/api/" + collection, {
        method: "POST",
        headers: authHeaders(),
        credentials: "include",
        body: JSON.stringify(row)
      });
      if (!created.ok) {
        const err = await created.json().catch(() => ({}));
        throw new Error(err.error || "API " + created.status);
      }
      return created.json();
    }
    const listData = localRead(collection);
    if (row[idKey] == null) {
      const next = listData.reduce((m, r) => Math.max(m, Number(r[idKey]) || 0), 0) + 1;
      row[idKey] = next;
      listData.push(row);
    } else {
      const idx = listData.findIndex((r) => String(r[idKey]) === String(row[idKey]));
      if (idx >= 0) listData[idx] = { ...listData[idx], ...row };
      else listData.push(row);
    }
    localWrite(collection, listData);
    return row;
  }

  async function remove(collection, id) {
    await probe();
    if (mode === "server") {
      const res = await fetch(apiBase() + "/api/" + collection + "/" + id, {
        method: "DELETE",
        headers: authHeaders(),
        credentials: "include"
      });
      if (!res.ok && res.status !== 404) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "API " + res.status);
      }
      return true;
    }
    const idKey = ID_KEYS[collection];
    localWrite(
      collection,
      localRead(collection).filter((r) => String(r[idKey]) !== String(id))
    );
    return true;
  }

  async function replaceAll(collection, rows) {
    await probe();
    if (mode === "server") {
      const res = await fetch(apiBase() + "/api/" + collection, {
        method: "PUT",
        headers: authHeaders(),
        credentials: "include",
        body: JSON.stringify(rows)
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "API " + res.status);
      }
      return res.json();
    }
    localWrite(collection, rows);
    return rows;
  }

  async function getMeta() {
    return list("meta");
  }

  async function saveMeta(obj) {
    await probe();
    if (mode === "server") {
      const res = await fetch(apiBase() + "/api/meta", {
        method: "PUT",
        headers: authHeaders(),
        credentials: "include",
        body: JSON.stringify(obj)
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "API " + res.status);
      }
      return res.json();
    }
    localWrite("meta", obj);
    return obj;
  }

  async function login(creds) {
    await probe();
    if (mode !== "server") {
      meCache = { authenticated: true, role: "campaign_admin", label: "Local test admin" };
      return meCache;
    }
    const res = await fetch(apiBase() + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(creds)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Login failed");
    if (data.token) {
      token = data.token;
      try {
        localStorage.setItem("sh_session_token", token);
      } catch (_) {}
    }
    meCache = data;
    return data;
  }

  async function logout() {
    if (mode === "server") {
      try {
        await fetch(apiBase() + "/api/auth/logout", {
          method: "POST",
          headers: authHeaders(),
          credentials: "include"
        });
      } catch (_) {}
    }
    token = null;
    try {
      localStorage.removeItem("sh_session_token");
    } catch (_) {}
    meCache = { authenticated: false, role: "visitor" };
    return true;
  }

  async function me() {
    await probe();
    if (mode === "server") await refreshMe();
    return meCache;
  }

  async function createInvite(playerId) {
    await probe();
    const res = await fetch(apiBase() + "/api/auth/create-invite", {
      method: "POST",
      headers: authHeaders(),
      credentials: "include",
      body: JSON.stringify({ player_id: playerId })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Invite failed");
    return data;
  }

  async function campaignStatus() {
    await probe();
    if (mode === "server") {
      const res = await fetch(apiBase() + "/api/campaign/status", {
        headers: authHeaders(),
        credentials: "include",
        cache: "no-store"
      });
      if (!res.ok) throw new Error("API " + res.status);
      return res.json();
    }
    const meta = localRead("meta");
    return {
      turn: meta.turn,
      phase: meta.phase,
      loyal_score: meta.loyal_score,
      traitor_score: meta.traitor_score,
      phases: ["Logistics", "Movement", "Battles"]
    };
  }

  async function advancePhase(opts) {
    await probe();
    if (mode === "server") {
      const res = await fetch(apiBase() + "/api/campaign/advance", {
        method: "POST",
        headers: authHeaders(),
        credentials: "include",
        body: JSON.stringify(opts || {})
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Advance failed");
      return data;
    }
    // Local fallback: simple phase cycle without full scoring
    const meta = localRead("meta");
    const phases = ["Logistics", "Movement", "Battles"];
    let i = phases.indexOf(meta.phase);
    if (i < 0) i = 0;
    if (i >= 2) {
      meta.turn = (Number(meta.turn) || 1) + 1;
      meta.phase = "Logistics";
    } else {
      meta.phase = phases[i + 1];
    }
    localWrite("meta", meta);
    return { ok: true, meta, to: { turn: meta.turn, phase: meta.phase }, log: ["Local advance"] };
  }

  async function setPhase(phase, turn) {
    await probe();
    if (mode === "server") {
      const res = await fetch(apiBase() + "/api/campaign/set-phase", {
        method: "POST",
        headers: authHeaders(),
        credentials: "include",
        body: JSON.stringify({ phase, turn })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Set phase failed");
      return data;
    }
    const meta = localRead("meta");
    meta.phase = phase;
    if (turn != null) meta.turn = turn;
    localWrite("meta", meta);
    return { ok: true, meta };
  }

  async function actionsStatus() {
    await probe();
    if (mode === "server") {
      const res = await fetch(apiBase() + "/api/actions/status", {
        headers: authHeaders(),
        credentials: "include",
        cache: "no-store"
      });
      if (!res.ok) throw new Error("API " + res.status);
      return res.json();
    }
    const meta = localRead("meta");
    return {
      turn: meta.turn,
      phase: meta.phase,
      actions_per_turn: 2,
      actions_used: 0,
      actions_remaining: 2,
      role: meCache.role,
      authenticated: !!meCache.authenticated
    };
  }

  async function doAction(name, body) {
    await probe();
    if (mode === "server") {
      const res = await fetch(apiBase() + "/api/actions/" + name, {
        method: "POST",
        headers: authHeaders(),
        credentials: "include",
        body: JSON.stringify(body || {})
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Action failed");
      return data;
    }
    // Local fallback: apply simplified rules so solo testing still works
    return localDoAction(name, body || {});
  }

  function localDoAction(name, body) {
    const meta = localRead("meta");
    const phase = meta.phase || "Logistics";
    let forces = localRead("forces");
    let systems = localRead("systems");
    const playerId = meCache.player_id || body.player_id || 1;

    function parseLinks(sys) {
      if (!sys || !sys.sys_links) return [];
      return String(sys.sys_links)
        .split(/[,;\s]+/)
        .map((s) => Number(s.trim()))
        .filter((n) => n > 0);
    }
    function controller(sys) {
      const d = Number(sys.sys_loyal || 0) - Number(sys.sys_traitor || 0);
      if (d > 0) return "Loyalist";
      if (d < 0) return "Traitor";
      return "Contested";
    }

    if (name === "move") {
      if (phase !== "Movement") throw new Error("Move is only allowed during the Movement phase");
      const force = forces.find((f) => Number(f.force_id) === Number(body.force_id));
      if (!force) throw new Error("Force not found");
      const from = systems.find((s) => Number(s.sys_id) === Number(force.sys_id));
      const to = systems.find((s) => Number(s.sys_id) === Number(body.dest_sys_id));
      if (!from || !to) throw new Error("System not found");
      if (!parseLinks(from).includes(Number(body.dest_sys_id))) {
        throw new Error(from.sys_name + " is not connected to " + to.sys_name);
      }
      force.dest_sys_id = Number(body.dest_sys_id);
      localWrite("forces", forces);
      return { ok: true, action: "move", force, message: "Ordered move to " + to.sys_name };
    }
    if (name === "hold") {
      const force = forces.find((f) => Number(f.force_id) === Number(body.force_id));
      if (!force) throw new Error("Force not found");
      force.dest_sys_id = null;
      localWrite("forces", forces);
      return { ok: true, action: "hold", force, message: force.force_name + " holds" };
    }
    if (name === "reinforce") {
      if (phase !== "Logistics") throw new Error("Reinforce is only allowed during the Logistics phase");
      const force = forces.find((f) => Number(f.force_id) === Number(body.force_id));
      if (!force) throw new Error("Force not found");
      if ((Number(force.strength) || 0) >= 3) throw new Error("Force already at maximum strength (3)");
      const sys = systems.find((s) => Number(s.sys_id) === Number(force.sys_id));
      if (!sys || controller(sys) !== force.allegiance) {
        throw new Error("Can only Reinforce in an allegiance-controlled system");
      }
      force.strength = (Number(force.strength) || 0) + 1;
      localWrite("forces", forces);
      return { ok: true, action: "reinforce", force, message: "Reinforced to " + force.strength };
    }
    if (name === "fortify") {
      if (phase !== "Logistics") throw new Error("Fortify is only allowed during the Logistics phase");
      const idx = systems.findIndex((s) => Number(s.sys_id) === Number(body.sys_id));
      if (idx < 0) throw new Error("System not found");
      const sys = systems[idx];
      const player = localRead("players").find((p) => Number(p.player_id) === Number(playerId));
      const alleg = (player && player.allegiance) || forceAllegianceGuess();
      if (controller(sys) !== alleg) throw new Error("Can only Fortify an allegiance-controlled system");
      const dur = sys.sys_durability != null ? Number(sys.sys_durability) : 5;
      if (dur >= 10) throw new Error("System already at maximum durability (10)");
      systems[idx] = { ...sys, sys_durability: dur + 1 };
      localWrite("systems", systems);
      return { ok: true, action: "fortify", system: systems[idx], message: "Fortified to " + (dur + 1) };
    }
    if (name === "generate") {
      if (phase !== "Logistics") throw new Error("Generate Force is only allowed during the Logistics phase");
      const sys = systems.find((s) => Number(s.sys_id) === Number(body.sys_id));
      if (!sys) throw new Error("System not found");
      const players = localRead("players");
      const player = players.find((p) => Number(p.player_id) === Number(playerId));
      const alleg = (player && player.allegiance) || "Traitor";
      if (controller(sys) !== alleg) throw new Error("Can only Generate in an allegiance-controlled system");
      const opposing = forces.some(
        (f) =>
          f.status === "active" &&
          Number(f.sys_id) === Number(body.sys_id) &&
          f.allegiance &&
          f.allegiance !== alleg
      );
      if (opposing) throw new Error("Cannot Generate Force: opposing forces present");
      const id = forces.reduce((m, f) => Math.max(m, Number(f.force_id) || 0), 0) + 1;
      const newForce = {
        force_id: id,
        player_id: Number(playerId),
        force_name: body.force_name || "New " + alleg + " Force",
        game_system: body.game_system || "HH",
        force_type: body.force_type || "Legion",
        allegiance: alleg,
        legion: body.legion || "",
        warlord_name: body.warlord_name || "",
        points: body.points != null ? Number(body.points) : 3000,
        home_sys_id: Number(body.sys_id),
        sys_id: Number(body.sys_id),
        dest_sys_id: null,
        strength: 3,
        status: "active",
        notes: body.notes || "Raised this turn",
        fought_this_turn: false
      };
      forces.push(newForce);
      localWrite("forces", forces);
      return { ok: true, action: "generate", force: newForce, message: "Raised " + newForce.force_name };
    }
    throw new Error("Unknown action");

    function forceAllegianceGuess() {
      return "Traitor";
    }
  }

  function canEditPlayers() {
    return meCache.role === "campaign_admin";
  }
  function canEditSystems() {
    return meCache.role === "campaign_admin";
  }
  function canEditForce(force) {
    if (meCache.role === "campaign_admin") return true;
    if (meCache.role === "player" && force && force.player_id === meCache.player_id) return true;
    return false;
  }
  function isLoggedIn() {
    return !!meCache.authenticated && meCache.role !== "visitor";
  }

  function statusBadgeHtml() {
    const role = meCache.role || "visitor";
    const map = {
      visitor: { label: "Visitor", color: "#94a3b8" },
      player: { label: "Player", color: "#3b82f6" },
      campaign_admin: { label: "Campaign admin", color: "#f0c040" }
    };
    const m = map[role] || map.visitor;
    const store = mode === "server" ? "" : " · local";
    return `<span style="font-size:0.68rem;color:${m.color};border:1px solid ${m.color};padding:0.15rem 0.45rem;border-radius:4px;white-space:nowrap">${m.label}${store}</span>`;
  }

  function navAuthHtml() {
    if (isLoggedIn()) {
      const name = meCache.label || meCache.role;
      return `<a href="login.html">${escapeHtml(name)}</a><a href="#" id="nav-logout">Log out</a>`;
    }
    return `<a href="login.html">Log in</a>`;
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** Hide admin-only nav links for visitors/players. Call after DOM ready. */
  async function applyNavPermissions() {
    await probe();
    const role = meCache.role || "visitor";
    document.querySelectorAll("[data-role]").forEach((el) => {
      const need = (el.getAttribute("data-role") || "").split(/\s+/);
      const ok = need.some((r) => r === role || (r === "logged-in" && isLoggedIn()));
      el.style.display = ok ? "" : "none";
    });
    const slot = document.getElementById("nav-auth");
    if (slot) slot.innerHTML = navAuthHtml();
    const logoutBtn = document.getElementById("nav-logout");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        await global.SH.logout();
        location.href = "index.html";
      });
    }
    const badge = document.getElementById("mode-badge");
    if (badge) badge.innerHTML = statusBadgeHtml();
  }

  global.SH = {
    list,
    get,
    save,
    remove,
    replaceAll,
    getMeta,
    saveMeta,
    login,
    logout,
    me,
    createInvite,
    campaignStatus,
    advancePhase,
    setPhase,
    actionsStatus,
    doAction,
    moveForce: (forceId, destSysId, extra) =>
      doAction("move", { force_id: forceId, dest_sys_id: destSysId, ...(extra || {}) }),
    holdForce: (forceId, extra) => doAction("hold", { force_id: forceId, ...(extra || {}) }),
    reinforceForce: (forceId, extra) => doAction("reinforce", { force_id: forceId, ...(extra || {}) }),
    fortifySystem: (sysId, extra) => doAction("fortify", { sys_id: sysId, ...(extra || {}) }),
    generateForce: (sysId, fields) => doAction("generate", { sys_id: sysId, ...(fields || {}) }),
    probe,
    refreshMe,
    statusBadgeHtml,
    navAuthHtml,
    applyNavPermissions,
    canEditPlayers,
    canEditSystems,
    canEditForce,
    isLoggedIn,
    get mode() {
      return mode;
    },
    get role() {
      return meCache.role || "visitor";
    },
    get user() {
      return meCache;
    }
  };
})(typeof window !== "undefined" ? window : globalThis);
