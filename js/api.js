/**
 * Sunset Heresy shared data client + auth.
 *
 * Server mode (preferred): role-aware API with sessions.
 * Local fallback: localStorage (solo testing, no real auth).
 *
 * Auth:
 *   await SH.login({ login, password })
 *   await SH.signup({ invite_code, login, password, player_name, display_name, ... })
 *   await SH.logout()
 *   await SH.me()
 *   await SH.setPassword({ password, current_password })
 *   await SH.listInvites() / issueInvite() / revokeInvite()   (campaign admin)
 *   SH.role
 *
 * Data:
 *   await SH.list("players")
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
    const h = { "Content-Type": "application/json", "X-SH-Request": "1" };
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
      const usePublic =
        role === "visitor" && (collection === "players" || collection === "forces" || collection === "meta" || collection === "systems" || collection === "games");
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
      headers: { "Content-Type": "application/json", "X-SH-Request": "1" },
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

  async function signup(body) {
    await probe();
    if (mode !== "server") throw new Error("Sign up needs the live server");
    const res = await fetch(apiBase() + "/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-SH-Request": "1" },
      credentials: "include",
      body: JSON.stringify(body || {})
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Sign up failed");
    if (data.token) {
      token = data.token;
      try {
        localStorage.setItem("sh_session_token", token);
      } catch (_) {}
    }
    meCache = data;
    return data;
  }

  async function listInvites() {
    await probe();
    const res = await fetch(apiBase() + "/api/auth/invites", {
      headers: authHeaders(),
      credentials: "include",
      cache: "no-store"
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Could not load invites");
    return data;
  }

  async function issueInvite(body) {
    await probe();
    const res = await fetch(apiBase() + "/api/auth/invites", {
      method: "POST",
      headers: authHeaders(),
      credentials: "include",
      body: JSON.stringify(body || {})
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Could not create invite");
    return data;
  }

  async function revokeInvite(inviteId) {
    await probe();
    const res = await fetch(apiBase() + "/api/auth/invites/revoke", {
      method: "POST",
      headers: authHeaders(),
      credentials: "include",
      body: JSON.stringify({ invite_id: inviteId })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Could not revoke invite");
    return data;
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

  async function confirmGame(id) {
    return postGameAction(id, "confirm");
  }

  async function disputeGame(id, note) {
    return postGameAction(id, "dispute", { note: note || "" });
  }

  async function voidGame(id) {
    return postGameAction(id, "void");
  }

  async function postGameAction(id, action, body) {
    await probe();
    if (mode !== "server") throw new Error("This needs the live server");
    const res = await fetch(apiBase() + "/api/games/" + id + "/" + action, {
      method: "POST",
      headers: authHeaders(),
      credentials: "include",
      body: JSON.stringify(body || {})
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "API " + res.status);
    return data;
  }

  async function inbox() {
    await probe();
    if (mode !== "server") return { actions: [], mine: [], notifications: [], action_count: 0, unread_count: 0 };
    const res = await fetch(apiBase() + "/api/inbox", {
      headers: authHeaders(),
      credentials: "include",
      cache: "no-store"
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Could not load actions");
    return data;
  }

  async function markInboxRead() {
    await probe();
    if (mode !== "server") return { ok: true };
    const res = await fetch(apiBase() + "/api/inbox/read", {
      method: "POST",
      headers: authHeaders(),
      credentials: "include",
      body: "{}"
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Could not update messages");
    return data;
  }

  async function submitFeedback(body) {
    await probe();
    if (mode !== "server") throw new Error("Feedback needs the live server");
    const res = await fetch(apiBase() + "/api/feedback", {
      method: "POST",
      headers: authHeaders(),
      credentials: "include",
      body: JSON.stringify(body || {})
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Could not send feedback");
    return data;
  }

  async function listFeedback() {
    await probe();
    const res = await fetch(apiBase() + "/api/feedback", {
      headers: authHeaders(),
      credentials: "include",
      cache: "no-store"
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Could not load feedback");
    return data;
  }

  async function downloadBackup() {
    await probe();
    if (mode !== "server") throw new Error("Backup needs the live server");
    const res = await fetch(apiBase() + "/api/admin/backup", {
      headers: authHeaders(),
      credentials: "include",
      cache: "no-store"
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Could not download backup");
    }
    return res.blob();
  }

  async function resetCampaign(body) {
    await probe();
    if (mode !== "server") throw new Error("Reset needs the live server");
    const res = await fetch(apiBase() + "/api/campaign/reset", {
      method: "POST",
      headers: authHeaders(),
      credentials: "include",
      body: JSON.stringify(body || {})
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Reset failed");
    return data;
  }

  async function setPassword(body) {
    await probe();
    if (mode !== "server") throw new Error("Password change needs the live server");
    const res = await fetch(apiBase() + "/api/auth/set-password", {
      method: "POST",
      headers: authHeaders(),
      credentials: "include",
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Password change failed");
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

  // Remaining helpers (advancePhase, setPhase, actions, nav) load from prior build via same module pattern.
  // Full action helpers retained below for offline mode.

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
      if (!res.ok) {
        const err = new Error(data.error || "Advance failed");
        err.code = data.code || null;
        err.battles = data.battles || null;
        throw err;
      }
      return data;
    }
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

  async function playerActions() {
    await probe();
    if (mode !== "server") throw new Error("Player actions need the campaign server");
    const res = await fetch(apiBase() + "/api/actions/players", {
      headers: authHeaders(),
      credentials: "include",
      cache: "no-store"
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "API " + res.status);
    return data;
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
    throw new Error("Local action mode limited; use the live server for full actions");
  }

  function isLoggedIn() {
    return !!(meCache && meCache.authenticated && meCache.role && meCache.role !== "visitor");
  }
  function canEditPlayers() {
    return meCache.role === "campaign_admin";
  }
  function canEditSystems() {
    return meCache.role === "campaign_admin";
  }
  function canEditForce(force) {
    if (meCache.role === "campaign_admin") return true;
    if (meCache.role === "player" && force && meCache.player_id != null) {
      return Number(force.player_id) === Number(meCache.player_id);
    }
    return false;
  }

  function statusBadgeHtml() {
    if (mode === "local") return '<span class="mode-badge local">Local</span>';
    return '<span class="mode-badge server">Live</span>';
  }

  function navAuthHtml() {
    if (isLoggedIn()) {
      const name = meCache.label || meCache.role;
      const onAccount = /(?:^|\/)account\.html$/.test(location.pathname);
      const active = onAccount ? " active" : "";
      return '<a class="nav-account' + active + '" href="account.html">' + escapeHtml(name) + "</a>";
    }
    const onLogin = /(?:^|\/)login\.html$/.test(location.pathname);
    const active = onLogin ? " active" : "";
    return '<a class="nav-login' + active + '" href="login.html">Log in</a>';
  }

  function syncFeedbackLink() {
    const menu = document.getElementById("site-menu");
    if (!menu) return;
    let link = menu.querySelector('a[href="feedback.html"]');
    if (!isLoggedIn()) {
      if (link) link.remove();
      return;
    }
    if (!link) {
      link = document.createElement("a");
      link.href = "feedback.html";
      link.textContent = "Feedback";
      const logout = document.getElementById("nav-logout");
      if (logout && logout.parentElement === menu) menu.insertBefore(link, logout);
      else menu.appendChild(link);
    }
    const path = (location.pathname || "").split("/").pop() || "";
    link.classList.toggle("active", path === "feedback.html");
  }

  function wireSiteMenu() {
    const header = document.querySelector(".site-header");
    const btn = document.querySelector(".nav-toggle");
    const menu = document.getElementById("site-menu");
    if (!header || !btn || !menu || btn.dataset.wired) return;
    btn.dataset.wired = "1";
    function setOpen(open) {
      header.classList.toggle("menu-open", open);
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      btn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    }
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      setOpen(!header.classList.contains("menu-open"));
    });
    menu.addEventListener("click", (e) => {
      if (e.target.closest("a, button")) setOpen(false);
    });
    document.addEventListener("click", (e) => {
      if (!header.contains(e.target)) setOpen(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") setOpen(false);
    });
    const path = (location.pathname || "").split("/").pop() || "index.html";
    menu.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href");
      if (href === path || (path === "" && href === "index.html")) a.classList.add("active");
    });
  }

  function labelResponsiveTables() {
    document.querySelectorAll(".table-wrap table").forEach((table) => {
      const headers = [...table.querySelectorAll("thead th")].map((th) => (th.textContent || "").trim());
      table.querySelectorAll("tbody tr").forEach((tr) => {
        [...tr.children].forEach((cell, i) => {
          if (cell.tagName !== "TD") return;
          const label = headers[i] || "";
          if (cell.getAttribute("data-label") !== label) cell.setAttribute("data-label", label);
        });
      });
    });
  }

  function bootChrome() {
    wireSiteMenu();
    labelResponsiveTables();
    if (bootChrome.watching || !document.body) return;
    bootChrome.watching = true;
    let pending = false;
    new MutationObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        labelResponsiveTables();
      });
    }).observe(document.body, { childList: true, subtree: true });
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/\u0026/g, "\u0026amp;")
      .replace(/\u003c/g, "\u0026lt;")
      .replace(/\u003e/g, "\u0026gt;")
      .replace(/\u0022/g, "\u0026quot;")
      .replace(/\u0027/g, "\u0026#39;");
  }

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
    syncFeedbackLink();
    const logoutBtn = document.getElementById("nav-logout");
    if (logoutBtn) {
      logoutBtn.hidden = !isLoggedIn();
      if (!logoutBtn.dataset.wired) {
        logoutBtn.dataset.wired = "1";
        logoutBtn.addEventListener("click", async (e) => {
          e.preventDefault();
          await global.SH.logout();
          location.href = "index.html";
        });
      }
    }
    const badge = document.getElementById("mode-badge");
    if (badge) badge.innerHTML = statusBadgeHtml();
    refreshWaitingBadge();
  }

  async function refreshWaitingBadge() {
    const link = document.getElementById("nav-waiting");
    if (!link) return;
    if (!isLoggedIn() || mode !== "server") {
      link.hidden = true;
      return;
    }
    let data = null;
    try {
      data = await inbox();
    } catch (_) {
      link.hidden = true;
      return;
    }
    link.hidden = false;
    const here = /(?:^|\/)actions\.html$/.test(location.pathname || "");
    link.classList.toggle("active", here);
    link.replaceChildren();
    link.append(document.createTextNode("Actions"));
    const count = Number(data.action_count) || 0;
    const unread = Number(data.unread_count) || 0;
    if (count > 0) {
      const pill = document.createElement("span");
      pill.className = "nav-badge";
      pill.textContent = count > 9 ? "9+" : String(count);
      link.appendChild(pill);
    } else if (unread > 0) {
      const dot = document.createElement("span");
      dot.className = "nav-dot";
      dot.title = "New messages";
      link.appendChild(dot);
    }
    link.setAttribute("aria-label", count > 0 ? "Actions waiting, " + count : "Actions");
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
    signup,
    logout,
    me,
    setPassword,
    submitFeedback,
    listFeedback,
    downloadBackup,
    resetCampaign,
    confirmGame,
    disputeGame,
    voidGame,
    inbox,
    markInboxRead,
    refreshWaitingBadge,
    createInvite,
    listInvites,
    issueInvite,
    revokeInvite,
    campaignStatus,
    advancePhase,
    setPhase,
    actionsStatus,
    playerActions,
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

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bootChrome);
  else bootChrome();
})(typeof window !== "undefined" ? window : globalThis);
