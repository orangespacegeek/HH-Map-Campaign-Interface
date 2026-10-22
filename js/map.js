/**
 * Sunset Heresy sector map.
 * Systems, warp links, and forces all come from SH (shared API / local store).
 * Layout coordinates live on each system as sys_x / sys_y, with a fallback table.
 */
(function () {
  const NS = "http://www.w3.org/2000/svg";
  const BASE_W = 800;
  const BASE_H = 560;
  const TAP_SLOP = 10;
  const TYPE_CODE = {
    "Fleet Anchorage": "N",
    "Forge World": "F",
    Hive: "H",
    Agri: "A",
    Civilised: "C",
    Fortress: "R",
    "Knight World": "K",
    "Death World": "D",
    "Dead World": "U",
    Mining: "M",
    Shrine: "S",
    "Warp Rift": "W",
    "Void Station": "V",
    "Penal World": "P"
  };
  // Used only when a system has no sys_x / sys_y yet
  const LAYOUT = {
    1: { x: 400, y: 270 },
    2: { x: 530, y: 250 },
    3: { x: 650, y: 230 },
    4: { x: 390, y: 185 },
    5: { x: 540, y: 140 },
    6: { x: 430, y: 70 },
    7: { x: 300, y: 110 },
    8: { x: 160, y: 70 },
    9: { x: 120, y: 200 },
    10: { x: 140, y: 320 },
    11: { x: 265, y: 305 },
    12: { x: 300, y: 390 },
    13: { x: 640, y: 360 }
  };

  let systems = [];
  let forces = [];
  let players = [];
  let meta = {};
  let actionStatus = null;

  const svg = document.getElementById("map");
  const starsG = document.getElementById("stars");
  const linksG = document.getElementById("links");
  const nodesG = document.getElementById("nodes");
  const mapWrap = document.getElementById("map-wrap");
  const sheet = document.getElementById("sheet");

  function esc(s) {
    const div = document.createElement("div");
    div.textContent = String(s ?? "");
    return div.innerHTML;
  }

  function controllerClass(c) {
    const lower = String(c || "").toLowerCase();
    if (lower === "loyalist") return "loyalist";
    if (lower === "traitor") return "traitor";
    if (lower === "contested") return "contested";
    return "unaligned";
  }

  function typeCode(type) {
    if (!type) return "?";
    return TYPE_CODE[type] || String(type).charAt(0).toUpperCase();
  }

  function parseLinks(raw) {
    if (Array.isArray(raw)) return raw.map(Number).filter((n) => n > 0);
    if (raw == null || raw === "") return [];
    return String(raw)
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => n > 0);
  }

  function byId(id) {
    return systems.find((s) => Number(s.sys_id) === Number(id));
  }

  function playerName(id) {
    const p = players.find((x) => Number(x.player_id) === Number(id));
    if (!p) return id ? "#" + id : "—";
    return p.display_name || p.player_name || "#" + id;
  }

  function forcesAt(sysId) {
    return forces.filter(
      (f) =>
        Number(f.sys_id) === Number(sysId) &&
        String(f.status || "active").toLowerCase() !== "destroyed" &&
        String(f.status || "").toLowerCase() !== "retired" &&
        String(f.status || "").toLowerCase() !== "removed"
    );
  }

  function pos(s) {
    const x = Number(s.sys_x);
    const y = Number(s.sys_y);
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
    return LAYOUT[s.sys_id] || { x: 400, y: 280 };
  }

  function svgEl(name, attrs) {
    const el = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }

  function drawStars() {
    starsG.replaceChildren();
    for (let i = 0; i < 100; i++) {
      starsG.appendChild(
        svgEl("circle", {
          cx: Math.random() * BASE_W,
          cy: Math.random() * BASE_H,
          r: Math.random() * 1.3 + 0.3
        })
      );
    }
  }

  function drawLinks() {
    linksG.replaceChildren();
    const seen = new Set();
    systems.forEach((s) => {
      parseLinks(s.sys_links).forEach((otherId) => {
        const a = Number(s.sys_id);
        const b = Number(otherId);
        if (a === b) return;
        const key = a < b ? a + "-" + b : b + "-" + a;
        if (seen.has(key)) return;
        seen.add(key);
        const sa = byId(a);
        const sb = byId(b);
        if (!sa || !sb) return;
        const pa = pos(sa);
        const pb = pos(sb);
        linksG.appendChild(
          svgEl("line", {
            x1: pa.x,
            y1: pa.y,
            x2: pb.x,
            y2: pb.y,
            class: "link"
          })
        );
      });
    });
  }

  function drawNodes() {
    nodesG.replaceChildren();
    systems.forEach((s) => {
      const p = pos(s);
      const g = svgEl("g", {
        class: "node " + controllerClass(s.sys_controller),
        "data-id": String(s.sys_id)
      });

      g.appendChild(
        svgEl("circle", { cx: p.x, cy: p.y, r: 36, fill: "transparent" })
      );
      g.appendChild(
        svgEl("circle", { class: "main", cx: p.x, cy: p.y, r: 20 })
      );

      const tType = svgEl("text", { class: "type", x: p.x, y: p.y });
      tType.textContent = typeCode(s.sys_type);
      g.appendChild(tType);

      const tName = svgEl("text", { class: "label", x: p.x, y: p.y + 34 });
      tName.textContent = s.sys_name;
      g.appendChild(tName);

      const here = forcesAt(s.sys_id);
      if (here.length) {
        const traitors = here.filter((f) => f.allegiance === "Traitor").length;
        const loyalists = here.filter((f) => f.allegiance === "Loyalist").length;
        let fill = "#f0c040";
        if (traitors && !loyalists) fill = "#ef4444";
        else if (loyalists && !traitors) fill = "#3b82f6";
        const bx = p.x + 18;
        const by = p.y - 18;
        g.appendChild(svgEl("circle", { cx: bx, cy: by, r: 9, fill: fill, stroke: "#0a0a12", "stroke-width": 2 }));
        const t = svgEl("text", {
          class: "garrison",
          x: bx,
          y: by + 0.5,
          fill: "#0a0a12",
          "font-size": 10,
          "font-weight": 700,
          "text-anchor": "middle",
          "dominant-baseline": "central"
        });
        t.textContent = String(here.length);
        g.appendChild(t);
      }

      nodesG.appendChild(g);
    });
  }

  function updateStatusBar() {
    const counts = { loyalist: 0, traitor: 0, contested: 0, unaligned: 0 };
    systems.forEach((s) => {
      counts[controllerClass(s.sys_controller)]++;
    });
    const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
    const pct = (n) => Math.round((n / total) * 100);
    document.getElementById("status-labels").innerHTML = `
      <span class="loyalist">Loyalist <span class="pct">${pct(counts.loyalist)}%</span></span>
      <span class="traitor">Traitor <span class="pct">${pct(counts.traitor)}%</span></span>
      <span class="contested">Contested <span class="pct">${pct(counts.contested)}%</span></span>
      <span class="unaligned">Neutral <span class="pct">${pct(counts.unaligned)}%</span></span>
    `;
    document.getElementById("status-track").innerHTML = `
      <div class="seg loyalist" style="width:${pct(counts.loyalist)}%"></div>
      <div class="seg traitor" style="width:${pct(counts.traitor)}%"></div>
      <div class="seg contested" style="width:${pct(counts.contested)}%"></div>
      <div class="seg unaligned" style="width:${pct(counts.unaligned)}%"></div>
    `;
  }

  function updateHeader() {
    const sub = document.getElementById("header-sub");
    if (sub) {
      const sector = meta.subsector || "Port Maw";
      const turn = meta.turn != null ? "Turn " + meta.turn : "";
      const phase = meta.phase || "";
      sub.textContent = [sector, turn, phase].filter(Boolean).join(" · ");
    }
    const slot = document.getElementById("mode-slot");
    if (slot && window.SH) slot.innerHTML = SH.statusBadgeHtml();
  }

  const isMobile = () => window.matchMedia("(max-width: 767px)").matches;

  function selectSystem(id) {
    const s = byId(id);
    if (!s) return;
    document.querySelectorAll(".node").forEach((n) =>
      n.classList.toggle("selected", Number(n.dataset.id) === Number(id))
    );
    document.getElementById("empty-msg").hidden = true;
    document.getElementById("detail").hidden = false;
    document.getElementById("sheet-title").textContent = s.sys_name;

    const ctrlClass = controllerClass(s.sys_controller);
    document.getElementById("meta").innerHTML = `
      <dt>Type</dt><dd>${esc(s.sys_type)} (${esc(typeCode(s.sys_type))})</dd>
      <dt>Power</dt><dd>${esc(s.sys_power)}</dd>
      <dt>Durability</dt><dd>${esc(s.sys_durability != null && s.sys_durability !== "" ? s.sys_durability : 5)}</dd>
      <dt>Controller</dt><dd><span class="badge ${ctrlClass}">${esc(s.sys_controller)}</span></dd>
      <dt>Loyal / Traitor</dt><dd>${esc(s.sys_loyal)} / ${esc(s.sys_traitor)}</dd>
      <dt>Infrastructure</dt><dd>${esc(s.sys_struct) || "—"}</dd>
      <dt>Warp links</dt><dd>${parseLinks(s.sys_links).map((id) => esc((byId(id) || {}).sys_name || "#" + id)).join(", ") || "—"}</dd>
      <dt>Notes</dt><dd>${esc(s.sys_notes) || "—"}</dd>
    `;

    const present = forcesAt(s.sys_id);
    const fl = document.getElementById("force-list");
    if (present.length === 0) {
      fl.innerHTML = `<li style="border:none;background:none;color:var(--muted)">No forces currently present.</li>`;
    } else {
      fl.innerHTML = present
        .map(
          (f) => `
        <li>
          <div class="name">${esc(f.force_name)}</div>
          <div class="detail">${esc(playerName(f.player_id))} · ${esc(f.allegiance)} · ${esc(f.legion || f.force_type || "")} · Str ${esc(f.strength)}</div>
          ${f.notes ? `<div class="detail">${esc(f.notes)}</div>` : ""}
        </li>`
        )
        .join("");
    }

    renderActions(s);
    sheet.classList.add("open");
  }

  function actionNote(text, kind) {
    const p = document.createElement("p");
    p.className = "action-note" + (kind ? " " + kind : "");
    p.textContent = text;
    return p;
  }

  function fillSelect(select, rows, valueKey, labelFn) {
    rows.forEach((row) => {
      const opt = document.createElement("option");
      opt.value = row[valueKey];
      opt.textContent = labelFn(row);
      select.appendChild(opt);
    });
  }

  function renderActions(sys) {
    const box = document.getElementById("action-buttons");
    box.replaceChildren();
    const me = window.SH ? SH.user : null;
    if (!me || !SH.isLoggedIn()) {
      box.appendChild(actionNote("Log in to move, reinforce, fortify, or raise a force."));
      return;
    }

    const phase = meta.phase || "";
    const isAdmin = me.role === "campaign_admin";
    const present = forcesAt(sys.sys_id).filter(
      (f) => String(f.status || "active").toLowerCase() === "active"
    );
    const own = present.filter((f) => Number(f.player_id) === Number(me.player_id));
    const mine = isAdmin ? present : own;
    const allegiance = isAdmin
      ? (mine[0] && mine[0].allegiance) || (me.player && me.player.allegiance) || ""
      : (me.player && me.player.allegiance) || (mine[0] && mine[0].allegiance) || "";

    const msg = document.createElement("p");
    msg.id = "action-msg";
    msg.className = "action-note";
    msg.hidden = true;

    async function run(fn) {
      msg.hidden = false;
      msg.className = "action-note";
      msg.textContent = "Working…";
      try {
        const data = await fn();
        await refreshCampaignData();
        if (byId(sys.sys_id)) selectSystem(sys.sys_id);
        const note = document.getElementById("action-msg");
        if (note) {
          note.hidden = false;
          note.className = "action-note ok";
          note.textContent = (data && data.message) || "Done";
        }
      } catch (err) {
        msg.hidden = false;
        msg.className = "action-note err";
        msg.textContent = err.message || "Action failed";
      }
    }

    function actorExtra(force) {
      if (!isAdmin) return {};
      const extra = { spend: false };
      if (force && force.player_id != null) extra.player_id = force.player_id;
      return extra;
    }

    if (allegiance === "Blackshield") {
      box.appendChild(actionNote("Blackshield players do not take allegiance actions on the map."));
      return;
    }

    const controlled =
      allegiance && String(sys.sys_controller || "") === allegiance;
    const remaining =
      actionStatus && actionStatus.actions_remaining != null
        ? actionStatus.actions_remaining
        : null;

    if (phase === "Movement") {
      if (!mine.length) {
        box.appendChild(actionNote("You have no active force in this system to move."));
        return;
      }
      const links = parseLinks(sys.sys_links);
      if (!links.length) {
        box.appendChild(actionNote("This system has no warp links to move along."));
        return;
      }
      const forceSel = document.createElement("select");
      forceSel.setAttribute("aria-label", "Force to move");
      fillSelect(forceSel, mine, "force_id", (f) => f.force_name || "Force " + f.force_id);
      const destSel = document.createElement("select");
      destSel.setAttribute("aria-label", "Destination system");
      links.forEach((id) => {
        const other = byId(id);
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = other ? other.sys_name : "System " + id;
        destSel.appendChild(opt);
      });
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Move";
      btn.addEventListener("click", () => {
        const force = mine.find((f) => Number(f.force_id) === Number(forceSel.value)) || mine[0];
        run(() => SH.moveForce(Number(forceSel.value), Number(destSel.value), actorExtra(force)));
      });
      if (remaining != null) box.appendChild(actionNote("Actions left this turn: " + remaining));
      box.append(forceSel, destSel, btn, msg);
      return;
    }

    if (phase === "Logistics") {
      if (remaining != null) box.appendChild(actionNote("Actions left this turn: " + remaining));
      const grid = document.createElement("div");
      grid.className = "action-grid";

      if (mine.length && controlled) {
        const forceSel = document.createElement("select");
        forceSel.setAttribute("aria-label", "Force to reinforce");
        fillSelect(forceSel, mine, "force_id", (f) => f.force_name || "Force " + f.force_id);
        const reinforce = document.createElement("button");
        reinforce.type = "button";
        reinforce.textContent = "Reinforce";
        reinforce.addEventListener("click", () => {
          const force = mine.find((f) => Number(f.force_id) === Number(forceSel.value)) || mine[0];
          run(() => SH.reinforceForce(Number(forceSel.value), actorExtra(force)));
        });
        box.append(forceSel, reinforce);
      } else if (!mine.length) {
        box.appendChild(actionNote("Reinforce needs one of your active forces in this system."));
      } else {
        box.appendChild(actionNote("Reinforce is only available in a system your allegiance controls."));
      }

      // A player fortifies only with one of their own active forces here.
      // Admin keeps the server override and may fortify for any force present.
      if ((isAdmin ? mine.length : own.length) && controlled) {
        const fortify = document.createElement("button");
        fortify.type = "button";
        fortify.textContent = "Fortify";
        const actor = isAdmin ? mine[0] : own[0];
        fortify.addEventListener("click", () => {
          run(() => SH.fortifySystem(Number(sys.sys_id), actorExtra(actor)));
        });
        grid.appendChild(fortify);
      } else if (!isAdmin && controlled && !own.length) {
        const fortify = document.createElement("button");
        fortify.type = "button";
        fortify.textContent = "Fortify";
        fortify.disabled = true;
        fortify.title = "Fortify needs one of your active forces in this system.";
        const why = actionNote("Fortify needs one of your active forces in this system.");
        why.style.gridColumn = "1 / -1";
        grid.append(fortify, why);
      }

      if (controlled) {
        const generate = document.createElement("button");
        generate.type = "button";
        generate.textContent = "Generate Force";
        generate.addEventListener("click", () => {
          const fields = actorExtra(mine[0]);
          const name = nameInput.value.trim();
          if (name) fields.force_name = name;
          if (isAdmin && !fields.player_id) {
            msg.hidden = false;
            msg.className = "action-note err";
            msg.textContent = "Generate needs one of your forces here so the map knows which player is acting. Use the Forces page to raise one for another player.";
            return;
          }
          run(() => SH.generateForce(Number(sys.sys_id), fields));
        });
        grid.appendChild(generate);
      }

      const nameInput = document.createElement("input");
      nameInput.maxLength = 100;
      nameInput.placeholder = "New force name (optional)";
      nameInput.setAttribute("aria-label", "New force name");

      if (!grid.childElementCount && !mine.length) {
        box.appendChild(actionNote("No actions in this system until your allegiance controls it, or you have a force here."));
      }
      if (controlled) box.appendChild(nameInput);
      if (grid.childElementCount) box.appendChild(grid);
      box.appendChild(msg);
      return;
    }

    box.appendChild(
      actionNote(
        "No map actions in the " +
          (phase || "current") +
          " phase. Logistics covers reinforce, fortify, and generate. Movement covers move."
      )
    );
  }

  document.getElementById("close-sheet").addEventListener("click", () => {
    sheet.classList.remove("open");
    document.querySelectorAll(".node").forEach((n) => n.classList.remove("selected"));
  });

  // --- Stable pan & zoom using viewBox. Taps are not cancelled. ---
  let vb = { x: 0, y: 0, w: BASE_W, h: BASE_H };
  const MIN_W = BASE_W / 3.5;
  const MAX_W = BASE_W / 0.7;
  const pointers = new Map();
  let gesture = "none";
  let pinchDist = 0;
  let lastTap = 0;

  function applyViewBox() {
    svg.setAttribute("viewBox", `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  }

  function clientToSvg(clientX, clientY) {
    const rect = mapWrap.getBoundingClientRect();
    const sx = (clientX - rect.left) / rect.width;
    const sy = (clientY - rect.top) / rect.height;
    return { x: vb.x + sx * vb.w, y: vb.y + sy * vb.h };
  }

  function getDist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function nodeNear(clientX, clientY) {
    const el = document.elementFromPoint(clientX, clientY);
    const direct = el && el.closest ? el.closest(".node") : null;
    if (direct) return direct;
    const pt = clientToSvg(clientX, clientY);
    const rect = mapWrap.getBoundingClientRect();
    const px = rect.width / (vb.w || 1);
    const slop = 28 / (px || 1);
    let best = null;
    let bestD = slop;
    document.querySelectorAll("#nodes .node").forEach((n) => {
      const s = byId(Number(n.dataset.id));
      if (!s) return;
      const p = pos(s);
      const d = Math.hypot(p.x - pt.x, p.y - pt.y);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    });
    return best;
  }

  function showMapProblem(message) {
    const banner = document.getElementById("map-alert");
    if (banner) {
      banner.hidden = false;
      banner.textContent = message;
    }
    const empty = document.getElementById("empty-msg");
    if (empty) {
      empty.hidden = false;
      empty.textContent = message;
    }
    const detail = document.getElementById("detail");
    if (detail) detail.hidden = true;
    sheet.classList.add("open");
  }

  function hideHint() {
    const hint = document.getElementById("map-hint");
    if (hint) hint.style.opacity = "0";
  }

  mapWrap.addEventListener("pointerdown", (e) => {
    if (e.button != null && e.button !== 0) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
    if (pointers.size === 1) {
      gesture = "maybe";
    } else if (pointers.size >= 2) {
      gesture = "pinch";
      const pts = [...pointers.values()];
      pinchDist = getDist(pts[0], pts[1]);
      try {
        mapWrap.setPointerCapture(e.pointerId);
      } catch (_) {}
    }
  });

  mapWrap.addEventListener(
    "pointermove",
    (e) => {
      if (!pointers.has(e.pointerId)) return;
      const prev = pointers.get(e.pointerId);
      const curr = { x: e.clientX, y: e.clientY, sx: prev.sx, sy: prev.sy };
      pointers.set(e.pointerId, curr);

      if (gesture === "maybe" && pointers.size === 1) {
        if (Math.hypot(curr.x - curr.sx, curr.y - curr.sy) > TAP_SLOP) {
          gesture = "pan";
          try {
            mapWrap.setPointerCapture(e.pointerId);
          } catch (_) {}
          hideHint();
        }
      }

      if (gesture === "pan" && pointers.size === 1) {
        e.preventDefault();
        const rect = mapWrap.getBoundingClientRect();
        vb.x -= (curr.x - prev.x) * (vb.w / rect.width);
        vb.y -= (curr.y - prev.y) * (vb.h / rect.height);
        applyViewBox();
      } else if (gesture === "pinch" && pointers.size === 2) {
        e.preventDefault();
        const pts = [...pointers.values()];
        const dist = getDist(pts[0], pts[1]);
        const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
        if (pinchDist > 0) {
          let newW = vb.w * (pinchDist / dist);
          newW = Math.min(MAX_W, Math.max(MIN_W, newW));
          const midSvg = clientToSvg(mid.x, mid.y);
          const rect = mapWrap.getBoundingClientRect();
          const sx = (mid.x - rect.left) / rect.width;
          const sy = (mid.y - rect.top) / rect.height;
          vb.w = newW;
          vb.h = BASE_H * (newW / BASE_W);
          vb.x = midSvg.x - sx * vb.w;
          vb.y = midSvg.y - sy * vb.h;
          applyViewBox();
        }
        pinchDist = dist;
        hideHint();
      }
    },
    { passive: false }
  );

  function endPointer(e, allowTap) {
    const p = pointers.get(e.pointerId);
    const dist = p ? Math.hypot(e.clientX - p.sx, e.clientY - p.sy) : 999;
    const isTap = allowTap && gesture === "maybe" && dist < TAP_SLOP;
    pointers.delete(e.pointerId);

    if (isTap) {
      const node = nodeNear(e.clientX, e.clientY);
      if (node) selectSystem(Number(node.dataset.id));
      const now = Date.now();
      if (!node && now - lastTap < 300) {
        vb = { x: 0, y: 0, w: BASE_W, h: BASE_H };
        applyViewBox();
      }
      lastTap = now;
    }

    if (pointers.size === 0) {
      gesture = "none";
      pinchDist = 0;
    } else if (pointers.size === 1) {
      gesture = "maybe";
      pinchDist = 0;
    }
  }

  mapWrap.addEventListener("pointerup", (e) => endPointer(e, true));
  mapWrap.addEventListener("pointercancel", (e) => endPointer(e, false));

  mapWrap.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.1 : 0.9;
      let newW = Math.min(MAX_W, Math.max(MIN_W, vb.w * factor));
      const midSvg = clientToSvg(e.clientX, e.clientY);
      const rect = mapWrap.getBoundingClientRect();
      const sx = (e.clientX - rect.left) / rect.width;
      const sy = (e.clientY - rect.top) / rect.height;
      vb.w = newW;
      vb.h = BASE_H * (newW / BASE_W);
      vb.x = midSvg.x - sx * vb.w;
      vb.y = midSvg.y - sy * vb.h;
      applyViewBox();
    },
    { passive: false }
  );

  async function refreshCampaignData() {
    const [sysRows, forceRows, metaRow, status] = await Promise.all([
      SH.list("systems"),
      SH.list("forces"),
      SH.getMeta(),
      SH.actionsStatus().catch(() => null)
    ]);
    systems = Array.isArray(sysRows) ? sysRows : [];
    forces = Array.isArray(forceRows) ? forceRows : [];
    meta = metaRow && typeof metaRow === "object" ? metaRow : {};
    actionStatus = status;
    drawLinks();
    drawNodes();
    updateStatusBar();
    updateHeader();
  }

  async function loadCampaign() {
    await SH.probe();
    const [sysRows, forceRows, playerRows, metaRow, status] = await Promise.all([
      SH.list("systems"),
      SH.list("forces"),
      SH.list("players"),
      SH.getMeta(),
      SH.actionsStatus().catch(() => null)
    ]);
    actionStatus = status;
    systems = Array.isArray(sysRows) ? sysRows : [];
    forces = Array.isArray(forceRows) ? forceRows : [];
    players = Array.isArray(playerRows) ? playerRows : [];
    meta = metaRow && typeof metaRow === "object" ? metaRow : {};
  }

  function renderMap() {
    drawStars();
    drawLinks();
    drawNodes();
    updateStatusBar();
    updateHeader();
    applyViewBox();
    if (!isMobile()) sheet.classList.add("open");
  }

  loadCampaign()
    .then(() => {
      if (window.SH) SH.applyNavPermissions();
      if (!systems.length) {
        showMapProblem("Could not load systems. Start the campaign server and refresh.");
        return;
      }
      const banner = document.getElementById("map-alert");
      if (banner) banner.hidden = true;
      renderMap();
    })
    .catch((err) => {
      console.error(err);
      showMapProblem(err && err.message ? err.message : "Could not load campaign data.");
    });
})();
