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

  function journalTheme() {
    return document.documentElement.getAttribute("data-theme") === "journal-tactica";
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const CORE_NAMES = new Set(["Kasun", "The Thorn", "Nutorrans", "Kallina"]);
  const GATE_NAMES = new Set(["The Thorn", "Nutorrans"]);
  const RING_COLOR = {
    loyalist: "#d6b062",
    traitor: "#e24e3c",
    contested: "#e2d2a8",
    unaligned: "#9aa4b2"
  };
  const ICON_INK = {
    hive: "#96c8ff",
    forge: "#ffbe8c",
    mining: "#bedcc8",
    agri: "#d2f0a0",
    knight: "#e6d7ff",
    station: "#8cfff0",
    fleet: "#78e6ff",
    shrine: "#f0e6c8",
    death: "#e8a090",
    dead: "#b8c4d4",
    warp: "#c8b4ff",
    penal: "#f0c8a0",
    gas: "#c8b4ff",
    ocean: "#5ac8ff",
    world: "#9ad4ff"
  };

  function iconKey(type) {
    const t = String(type || "").toLowerCase();
    if (t.includes("hive")) return "hive";
    if (t.includes("forge")) return "forge";
    if (t.includes("mining")) return "mining";
    if (t.includes("agri")) return "agri";
    if (t.includes("knight") || t.includes("fortress")) return "knight";
    if (t.includes("station") || t.includes("void")) return "station";
    if (t.includes("fleet") || t.includes("anchor")) return "fleet";
    if (t.includes("shrine")) return "shrine";
    if (t.includes("dead")) return "dead";
    if (t.includes("death")) return "death";
    if (t.includes("warp")) return "warp";
    if (t.includes("penal")) return "penal";
    if (t.includes("gas")) return "gas";
    if (t.includes("ocean")) return "ocean";
    return "world";
  }

  function isGate(system) {
    if (!system) return false;
    if (GATE_NAMES.has(system.sys_name)) return true;
    const blob = [system.sys_name, system.sys_type, system.sys_notes, system.sys_struct].join(" ");
    if (/gate/i.test(blob)) return true;
    const type = String(system.sys_type || "");
    return type === "Fleet Anchorage" || type === "Void Station";
  }

  function coreCluster() {
    const named = systems.filter((s) => CORE_NAMES.has(s.sys_name));
    if (named.length >= 3) return named;
    const anchor = systems.find((s) => /ajale/i.test(String(s.sys_name || "")));
    if (anchor) {
      const origin = pos(anchor);
      const near = systems.filter((s) => {
        const p = pos(s);
        return Math.hypot(p.x - origin.x, p.y - origin.y) <= 160;
      });
      if (near.length >= 3) return near;
    }
    if (systems.length <= 4) return systems.slice();
    const pts = systems.map((s) => ({ s, ...pos(s) }));
    const cx = pts.reduce((sum, p) => sum + p.x, 0) / pts.length;
    const cy = pts.reduce((sum, p) => sum + p.y, 0) / pts.length;
    return pts
      .map((p) => ({ ...p, d: Math.hypot(p.x - cx, p.y - cy) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 4)
      .map((p) => p.s);
  }

  function clusterOutline(points, pad) {
    const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
    const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length;
    const steps = 72;
    const poly = [];
    let d = "";
    for (let i = 0; i < steps; i++) {
      const angle = (i / steps) * Math.PI * 2;
      let reach = pad;
      points.forEach((p) => {
        const projected = (p.x - cx) * Math.cos(angle) + (p.y - cy) * Math.sin(angle) + pad;
        if (projected > reach) reach = projected;
      });
      const x = cx + reach * Math.cos(angle);
      const y = cy + reach * Math.sin(angle);
      poly.push({ x, y });
      d += (i === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1) + " ";
    }
    return { d: d + "Z", cx, cy, poly };
  }

  function pointInPoly(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x;
      const yi = poly[i].y;
      const xj = poly[j].x;
      const yj = poly[j].y;
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function boxesCrowd(ax, ay, aw, ah, bx, by, bw, bh, gap) {
    const dx = Math.abs(ax - bx) - aw - bw;
    const dy = Math.abs(ay - by) - ah - bh;
    return dx < gap && dy < gap;
  }

  function labelHitsNode(x, y) {
    const halfW = 78;
    const halfH = 9;
    return systems.some((s) => {
      const p = pos(s);
      if (boxesCrowd(x, y, halfW, halfH, p.x, p.y, 40, 40, 4)) return true;
      const nameHalf = Math.max(28, String(s.sys_name || "").length * 4.4);
      return boxesCrowd(x, y, halfW, halfH, p.x, p.y + 46, nameHalf, 9, 4);
    });
  }

  function warpSegments() {
    const segs = [];
    const seen = new Set();
    systems.forEach((s) => {
      parseLinks(s.sys_links).forEach((otherId) => {
        const a = Number(s.sys_id);
        const b = Number(otherId);
        if (!a || !b || a === b) return;
        const key = a < b ? a + "-" + b : b + "-" + a;
        if (seen.has(key)) return;
        seen.add(key);
        const sa = byId(a);
        const sb = byId(b);
        if (sa && sb) segs.push([pos(sa), pos(sb)]);
      });
    });
    return segs;
  }

  function closestOnSegment(x, y, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2));
    return { x: a.x + t * dx, y: a.y + t * dy };
  }

  function labelHitsRoute(x, y) {
    const halfW = 78;
    const halfH = 11;
    return warpSegments().some(([a, b]) => {
      const p = closestOnSegment(x, y, a, b);
      const dx = Math.max(Math.abs(p.x - x) - halfW, 0);
      const dy = Math.max(Math.abs(p.y - y) - halfH, 0);
      return Math.hypot(dx, dy) < 10;
    });
  }

  function placeCoreLabel(poly) {
    const cx = poly.reduce((sum, p) => sum + p.x, 0) / poly.length;
    const cy = poly.reduce((sum, p) => sum + p.y, 0) / poly.length;
    const minX = Math.min.apply(null, poly.map((p) => p.x));
    const maxX = Math.max.apply(null, poly.map((p) => p.x));
    const minY = Math.min.apply(null, poly.map((p) => p.y));
    const maxY = Math.max.apply(null, poly.map((p) => p.y));
    let best = null;
    let bestScore = Infinity;
    for (let y = Math.max(22, minY - 36); y <= Math.min(BASE_H - 24, maxY + 36); y += 8) {
      for (let x = 88; x <= BASE_W - 88; x += 8) {
        if (labelHitsNode(x, y) || labelHitsRoute(x, y)) continue;
        const inside = pointInPoly(x, y, poly);
        const score = Math.hypot(x - cx, y - cy) + (inside ? 0 : 280);
        if (score < bestScore) {
          bestScore = score;
          best = { x, y };
        }
      }
    }
    return best || { x: cx, y: Math.max(22, minY - 18) };
  }

  function appendIcon(parent, x, y, type) {
    const key = iconKey(type);
    const ink = ICON_INK[key] || ICON_INK.world;
    const g = svgEl("g", {
      class: "jt-icon",
      transform: "translate(" + x + " " + y + ") scale(0.62)",
      fill: "none",
      stroke: ink,
      "stroke-width": "2.2",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "pointer-events": "none",
      filter: "url(#jt-glow)"
    });
    const line = (x1, y1, x2, y2, width) => {
      const attrs = { x1, y1, x2, y2 };
      if (width) attrs["stroke-width"] = width;
      g.appendChild(svgEl("line", attrs));
    };
    const dot = (cx, cy, r, opacity) => {
      g.appendChild(
        svgEl("circle", {
          cx,
          cy,
          r,
          fill: ink,
          "fill-opacity": opacity == null ? "0.3" : String(opacity),
          stroke: ink
        })
      );
    };
    if (key === "hive") {
      [[-18, 12, -4], [-12, 12, -12], [-6, 12, -22], [-2, 12, -30]].forEach(([xl, yb, yt]) => {
        g.appendChild(
          svgEl("rect", {
            x: xl,
            y: yt,
            width: -2 * xl,
            height: yb - yt,
            fill: ink,
            "fill-opacity": "0.22"
          })
        );
      });
      line(0, -30, 0, -38);
      line(-22, 12, 22, 12);
    } else if (key === "forge") {
      const pts = [];
      for (let i = 0; i < 16; i++) {
        const angle = (i * Math.PI) / 8;
        const radius = i % 2 === 0 ? 22 : 16;
        pts.push(Math.cos(angle) * radius + "," + Math.sin(angle) * radius);
      }
      g.appendChild(svgEl("polygon", { points: pts.join(" "), fill: ink, "fill-opacity": "0.22" }));
      g.appendChild(svgEl("circle", { cx: 0, cy: 0, r: 9, fill: "#071018", stroke: ink }));
    } else if (key === "mining") {
      [1, -1].forEach((side) => {
        line(-side * 16, 16, side * 12, -12, "3.2");
        const hx = side * 12;
        const hy = -12;
        g.appendChild(
          svgEl("path", {
            d: "M " + (hx - 12) + " " + (hy + 2) + " A 12 10 0 0 " + (side > 0 ? 1 : 0) + " " + (hx + 12) + " " + (hy + 2)
          })
        );
      });
    } else if (key === "agri") {
      [-25, 0, 25].forEach((angle) => {
        const rad = (angle * Math.PI) / 180;
        const tx = Math.sin(rad) * 28;
        const ty = 16 - Math.cos(rad) * 28;
        line(0, 16, tx, ty);
        for (let j = 0; j < 3; j++) {
          const t = 0.55 + j * 0.17;
          g.appendChild(
            svgEl("ellipse", {
              cx: tx * t,
              cy: 16 + (ty - 16) * t,
              rx: 3.2,
              ry: 2.1,
              fill: ink,
              stroke: "none"
            })
          );
        }
      });
      line(-8, 10, 8, 10);
    } else if (key === "knight") {
      g.appendChild(
        svgEl("polygon", {
          points: "-14,-8 -8,-18 8,-18 14,-8 12,14 0,20 -12,14",
          fill: ink,
          "fill-opacity": "0.22"
        })
      );
      line(-10, -2, 10, -2, "3");
      line(0, 0, 0, 16);
      line(0, -18, 0, -26);
    } else if (key === "station") {
      g.appendChild(svgEl("circle", { r: 18, "stroke-width": "2.6" }));
      for (let angle = 0; angle < 360; angle += 90) {
        const rad = (angle * Math.PI) / 180;
        const ca = Math.cos(rad);
        const sa = Math.sin(rad);
        line(7 * ca, 7 * sa, 18 * ca, 18 * sa);
        g.appendChild(
          svgEl("rect", {
            x: 18 * ca - 2.6,
            y: 18 * sa - 2.6,
            width: 5.2,
            height: 5.2,
            fill: ink,
            stroke: "none"
          })
        );
      }
      dot(0, 0, 6, 0.4);
    } else if (key === "fleet") {
      g.appendChild(svgEl("circle", { cx: 0, cy: -20, r: 3.5 }));
      line(0, -16, 0, 16, "3");
      line(-11, -6, 11, -6);
      g.appendChild(svgEl("path", { d: "M -16 2 A 16 12 0 0 0 16 2" }));
      [-1, 1].forEach((side) => {
        g.appendChild(
          svgEl("polygon", {
            points: side * 16 + ",4 " + side * 22 + ",12 " + side * 12 + ",10",
            fill: ink,
            stroke: "none"
          })
        );
      });
    } else if (key === "shrine") {
      g.appendChild(
        svgEl("polygon", {
          points: "0,-18 12,-2 12,14 -12,14 -12,-2",
          fill: ink,
          "fill-opacity": "0.22"
        })
      );
      line(0, -18, 0, -26);
      line(-6, 14, -6, 4);
      line(6, 14, 6, 4);
    } else if (key === "death") {
      g.appendChild(svgEl("circle", { r: 15 }));
      line(-8, -8, 8, 8, "2.4");
      line(-8, 8, 8, -8, "2.4");
    } else if (key === "dead") {
      g.appendChild(svgEl("circle", { r: 15, "stroke-dasharray": "3 3" }));
      dot(0, 0, 2.5, 0.8);
    } else if (key === "warp") {
      g.appendChild(svgEl("path", { d: "M 0,-16 C 14,-16 14,-2 0,-2 C -14,-2 -14,12 0,12" }));
      g.appendChild(svgEl("circle", { r: 18, "stroke-dasharray": "2 4" }));
    } else if (key === "penal") {
      g.appendChild(svgEl("circle", { r: 16 }));
      line(-6, -12, -6, 12);
      line(0, -14, 0, 14);
      line(6, -12, 6, 12);
    } else if (key === "gas") {
      dot(0, 0, 14, 0.2);
      [-6, 0, 6].forEach((oy) => line(-12 + Math.abs(oy) * 0.4, oy, 12 - Math.abs(oy) * 0.4, oy));
      g.appendChild(svgEl("ellipse", { cx: 0, cy: 0, rx: 24, ry: 7 }));
    } else if (key === "ocean") {
      dot(0, 0, 16, 0.18);
      [-6, 2, 8].forEach((oy) => {
        const pts = [];
        for (let px = -14; px <= 14; px += 2) {
          pts.push(px + "," + (oy + Math.sin(px / 3) * 2.2).toFixed(1));
        }
        g.appendChild(svgEl("polyline", { points: pts.join(" "), fill: "none" }));
      });
    } else {
      dot(0, 0, 15, 0.2);
      g.appendChild(svgEl("ellipse", { cx: 0, cy: 0, rx: 15, ry: 6 }));
      line(-15, 0, 15, 0);
    }
    parent.appendChild(g);
    return ink;
  }

  function forceDiamonds(parent, x, y, here) {
    const loyalists = here.filter((f) => f.allegiance === "Loyalist").length;
    const traitors = here.filter((f) => f.allegiance === "Traitor").length;
    const other = here.length - loyalists - traitors;
    const items = [];
    if (loyalists) items.push(["#d6b062", loyalists]);
    if (traitors) items.push(["#e24e3c", traitors]);
    if (other) items.push(["#e2d2a8", other]);
    items.forEach(([color, count], index) => {
      const bx = x - 48;
      const by = y - 6 + index * 18;
      const r = 8;
      parent.appendChild(
        svgEl("polygon", {
          class: "jt-diamond",
          points: bx + "," + (by - r) + " " + (bx + r) + "," + by + " " + bx + "," + (by + r) + " " + (bx - r) + "," + by,
          fill: "rgba(6,10,22,0.94)",
          stroke: color,
          "stroke-width": "1.6",
          "pointer-events": "none"
        })
      );
      const text = svgEl("text", {
        x: bx,
        y: by + 0.5,
        fill: color,
        "font-size": "10",
        "font-family": "Cinzel, serif",
        "font-weight": "700",
        "text-anchor": "middle",
        "dominant-baseline": "central",
        "pointer-events": "none"
      });
      text.textContent = String(count);
      parent.appendChild(text);
    });
  }

  function addJournalNode(g, system, p, here) {
    const ctrl = controllerClass(system.sys_controller);
    const ring = RING_COLOR[ctrl] || RING_COLOR.unaligned;
    const ink = ICON_INK[iconKey(system.sys_type)] || ICON_INK.world;
    g.appendChild(
      svgEl("circle", {
        class: "jt-glow",
        cx: p.x,
        cy: p.y,
        r: 16,
        fill: ink,
        opacity: "0.2",
        "pointer-events": "none"
      })
    );
    appendIcon(g, p.x, p.y, system.sys_type);
    const ringAttrs = {
      class: "jt-ring",
      cx: p.x,
      cy: p.y,
      r: 28,
      fill: "none",
      stroke: ring,
      "stroke-width": "2.2",
      "pointer-events": "none"
    };
    if (ctrl === "contested") ringAttrs["stroke-dasharray"] = "3 2.4";
    g.appendChild(svgEl("circle", ringAttrs));
    g.appendChild(
      svgEl("circle", {
        class: "jt-ring outer",
        cx: p.x,
        cy: p.y,
        r: 32,
        fill: "none",
        stroke: ring,
        "stroke-width": "1",
        opacity: "0.45",
        "pointer-events": "none"
      })
    );
    if (isGate(system)) {
      [45, 135, 225, 315].forEach((deg) => {
        const angle = (deg * Math.PI) / 180;
        g.appendChild(
          svgEl("line", {
            class: "jt-gate",
            x1: p.x + Math.cos(angle) * 38,
            y1: p.y + Math.sin(angle) * 38,
            x2: p.x + Math.cos(angle) * 47,
            y2: p.y + Math.sin(angle) * 47,
            stroke: "#c8f0ff",
            "stroke-width": "1.6",
            "stroke-linecap": "round",
            "pointer-events": "none"
          })
        );
      });
    }
    const brackets = svgEl("g", { class: "jt-brackets", visibility: "hidden", "pointer-events": "none" });
    const arm = 11;
    const reach = 36;
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sy]) => {
      brackets.appendChild(
        svgEl("path", {
          d:
            "M " + (p.x + sx * reach) + " " + (p.y + sy * (reach - arm)) +
            " L " + (p.x + sx * reach) + " " + (p.y + sy * reach) +
            " L " + (p.x + sx * (reach - arm)) + " " + (p.y + sy * reach),
          fill: "none",
          stroke: "#d6b062",
          "stroke-width": "2"
        })
      );
    });
    g.appendChild(brackets);
    forceDiamonds(g, p.x, p.y, here);
  }

  function drawJournalArt() {
    const previous = document.getElementById("jt-map-art");
    if (previous) previous.remove();
    if (!journalTheme()) return;
    const art = svgEl("g", { id: "jt-map-art", "pointer-events": "none" });
    const defs = svgEl("defs", {});
    const glow = svgEl("filter", { id: "jt-glow", x: "-60%", y: "-60%", width: "220%", height: "220%" });
    glow.appendChild(svgEl("feGaussianBlur", { stdDeviation: "1.35", result: "blur" }));
    const merge = svgEl("feMerge", {});
    merge.appendChild(svgEl("feMergeNode", { in: "blur" }));
    merge.appendChild(svgEl("feMergeNode", { in: "SourceGraphic" }));
    glow.appendChild(merge);
    defs.appendChild(glow);
    const voidGrad = svgEl("radialGradient", { id: "jt-void", cx: "46%", cy: "42%", r: "72%" });
    voidGrad.appendChild(svgEl("stop", { offset: "0%", "stop-color": "#16325c" }));
    voidGrad.appendChild(svgEl("stop", { offset: "48%", "stop-color": "#0a1628" }));
    voidGrad.appendChild(svgEl("stop", { offset: "100%", "stop-color": "#05070d" }));
    defs.appendChild(voidGrad);
    art.appendChild(defs);
    art.appendChild(svgEl("rect", { x: 0, y: 0, width: BASE_W, height: BASE_H, fill: "url(#jt-void)" }));
    [
      [250, 250, 170, 120, "#1c4e86", "0.28"],
      [140, 160, 120, 90, "#2a2a6a", "0.22"],
      [560, 390, 150, 100, "#12385c", "0.24"]
    ].forEach(([cx, cy, rx, ry, fill, opacity]) => {
      art.appendChild(svgEl("ellipse", { cx, cy, rx, ry, fill, opacity }));
    });
    for (let x = 40; x < BASE_W; x += 80) {
      art.appendChild(svgEl("line", { x1: x, y1: 0, x2: x, y2: BASE_H, stroke: "#5090c0", "stroke-width": "1", opacity: "0.08" }));
    }
    for (let y = 40; y < BASE_H; y += 80) {
      art.appendChild(svgEl("line", { x1: 0, y1: y, x2: BASE_W, y2: y, stroke: "#5090c0", "stroke-width": "1", opacity: "0.08" }));
    }
    const rand = mulberry32(7);
    for (let i = 0; i < 340; i++) {
      const bright = rand();
      art.appendChild(
        svgEl("circle", {
          class: "jt-star",
          cx: (rand() * BASE_W).toFixed(1),
          cy: (rand() * BASE_H).toFixed(1),
          r: bright > 0.96 ? "1.5" : (rand() * 0.7 + 0.25).toFixed(2),
          fill: "#d2e6ff",
          opacity: (0.15 + Math.pow(bright, 3) * 0.85).toFixed(2)
        })
      );
    }
    const cluster = coreCluster();
    if (cluster.length >= 3) {
      const outline = clusterOutline(cluster.map(pos), 54);
      art.appendChild(
        svgEl("path", {
          class: "jt-core",
          d: outline.d,
          fill: "rgba(60,160,255,0.07)",
          stroke: "#78dcff",
          "stroke-width": "1.5",
          "stroke-dasharray": "7 6",
          "stroke-linejoin": "round"
        })
      );
      const spot = placeCoreLabel(outline.poly);
      const captionAttrs = {
        class: "jt-core-label",
        x: spot.x.toFixed(1),
        y: spot.y.toFixed(1),
        "font-family": "Cinzel, serif",
        "font-size": "11",
        "font-weight": "600",
        "letter-spacing": "0.12em",
        "text-anchor": "middle"
      };
      const halo = svgEl("text", Object.assign({}, captionAttrs, { stroke: "rgba(4,10,22,0.9)", "stroke-width": "3.5", fill: "rgba(4,10,22,0.9)" }));
      halo.textContent = "AJALE SYSTEM";
      const caption = svgEl("text", Object.assign({}, captionAttrs, { fill: "rgba(160,230,255,0.9)" }));
      caption.textContent = "AJALE SYSTEM";
      art.appendChild(halo);
      art.appendChild(caption);
    }
    const credit = svgEl("text", {
      class: "jt-credit",
      x: BASE_W - 14,
      y: BASE_H - 16,
      fill: "rgba(120,220,255,0.62)",
      "font-family": "EB Garamond, serif",
      "font-style": "italic",
      "font-size": "13",
      "text-anchor": "end"
    });
    credit.textContent = "Built with Abominable Intelligence";
    art.appendChild(credit);
    svg.insertBefore(art, svg.firstChild);
  }

  function selectedNodeId() {
    const node = nodesG.querySelector(".node.selected");
    return node ? node.getAttribute("data-id") : "";
  }

  function restoreSelection(id) {
    if (!id) return;
    const node = nodesG.querySelector('.node[data-id="' + id + '"]');
    if (node) node.classList.add("selected");
  }

  function paintMap() {
    const keep = selectedNodeId();
    drawJournalArt();
    drawLinks();
    drawNodes();
    restoreSelection(keep);
  }

  function drawStars() {
    starsG.replaceChildren();
    if (journalTheme()) return;
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
        if (journalTheme()) {
          const dx = pb.x - pa.x;
          const dy = pb.y - pa.y;
          const len = Math.hypot(dx, dy);
          if (len < 1) return;
          const inset = Math.min(32, len * 0.3);
          const span = Math.max(len - inset * 2, 1);
          const count = Math.max(1, Math.round(span / 8));
          for (let i = 0; i <= count; i++) {
            const t = (inset + (span * i) / count) / len;
            linksG.appendChild(
              svgEl("circle", {
                class: "jt-link",
                cx: (pa.x + dx * t).toFixed(2),
                cy: (pa.y + dy * t).toFixed(2),
                r: "1.35",
                fill: "#c8f0ff",
                opacity: "0.88",
                "pointer-events": "none"
              })
            );
          }
          return;
        }
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

      const labelY = journalTheme() ? p.y + 44 : p.y + 34;
      if (journalTheme()) {
        const halo = svgEl("text", { class: "label jt-halo", x: p.x, y: labelY, "pointer-events": "none" });
        halo.textContent = s.sys_name;
        g.appendChild(halo);
      }
      const tName = svgEl("text", { class: "label", x: p.x, y: labelY });
      tName.textContent = s.sys_name;
      g.appendChild(tName);

      const here = forcesAt(s.sys_id);
      if (journalTheme()) {
        addJournalNode(g, s, p, here);
      } else if (here.length) {
        const traitors = here.filter((f) => f.allegiance === "Traitor").length;
        const loyalists = here.filter((f) => f.allegiance === "Loyalist").length;
        let fill = "var(--accent)";
        if (traitors && !loyalists) fill = "var(--traitor)";
        else if (loyalists && !traitors) fill = "var(--loyal)";
        const bx = p.x + 18;
        const by = p.y - 18;
        g.appendChild(svgEl("circle", { cx: bx, cy: by, r: 9, fill: fill, stroke: "var(--bg)", "stroke-width": 2 }));
        const t = svgEl("text", {
          class: "garrison",
          x: bx,
          y: by + 0.5,
          fill: "var(--on-accent)",
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
      const sector = window.SH && SH.sectorCopy ? SH.sectorCopy(meta).mapHeader : "Campaign sector";
      const phase = meta.phase || "";
      const turn = phase === "Muster" ? "" : (meta.turn != null ? "Turn " + meta.turn : "");
      sub.textContent = [sector, turn, phase].filter(Boolean).join(" · ");
    }
    const slot = document.getElementById("mode-slot");
    if (slot && window.SH) slot.innerHTML = SH.statusBadgeHtml();
    if (window.JT) JT.phaseBanner(document.getElementById("jt-phase"), meta, systems);
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
        .map((f) => {
          const bits = [playerName(f.player_id), f.allegiance, f.game_system, f.legion || f.force_type, f.warlord_name];
          if (f.primarch_present) bits.push("Primarch");
          if (f.titan_support) bits.push("Titan support");
          bits.push("Str " + (f.strength ?? ""));
          const detail = bits.filter((bit) => bit != null && String(bit) !== "").map((bit) => esc(bit)).join(" · ");
          const canEdit = window.SH && SH.canEditForce && SH.canEditForce(f);
          const edit = canEdit
            ? `<a class="edit-details" href="forces.html#force-${encodeURIComponent(f.force_id)}">Edit details</a>`
            : "";
          return `
        <li>
          <div class="name">${esc(f.force_name)}</div>
          <div class="detail">${detail}</div>
          ${f.notes ? `<div class="detail">${esc(f.notes)}</div>` : ""}
          ${edit}
        </li>`;
        })
        .join("");
    }

    if (window.JT) {
      const names = parseLinks(s.sys_links).map((linkId) => (byId(linkId) || {}).sys_name || ("#" + linkId));
      JT.dossier(document.getElementById("jt-dossier"), s, present, names);
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

    if (allegiance !== "Loyalist" && allegiance !== "Traitor" && !isAdmin) {
      box.appendChild(actionNote("The campaign admin still needs to assign your side."));
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
    paintMap();
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
    paintMap();
    updateStatusBar();
    updateHeader();
    applyViewBox();
    if (!isMobile()) sheet.classList.add("open");
  }

  new MutationObserver(() => {
    if (!systems.length) return;
    drawStars();
    paintMap();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

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
