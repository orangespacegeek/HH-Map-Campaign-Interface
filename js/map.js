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
        String(f.status || "").toLowerCase() !== "retired"
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
        svgEl("circle", { cx: p.x, cy: p.y, r: 30, fill: "transparent" })
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

    document.getElementById("action-buttons").innerHTML = `
      <button type="button">Move</button>
      <button type="button">Reinforce</button>
      <button type="button">Fortify</button>
      <button type="button">Generate Force</button>
    `;

    sheet.classList.add("open");
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
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const node = el && el.closest ? el.closest(".node") : null;
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

  async function loadCampaign() {
    await SH.probe();
    const [sysRows, forceRows, playerRows, metaRow] = await Promise.all([
      SH.list("systems"),
      SH.list("forces"),
      SH.list("players"),
      SH.getMeta()
    ]);
    systems = Array.isArray(sysRows) ? sysRows : [];
    if (!systems.length) {
      try {
        const res = await fetch("data/systems.json", { cache: "no-store" });
        if (res.ok) systems = await res.json();
      } catch (_) {}
    }
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
      if (!systems.length) {
        document.getElementById("empty-msg").textContent =
          "Could not load systems. Start the campaign server and refresh.";
        return;
      }
      renderMap();
    })
    .catch((err) => {
      console.error(err);
      document.getElementById("empty-msg").textContent =
        "Could not load campaign data.";
    });
})();
