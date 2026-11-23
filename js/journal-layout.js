/* Journal Tactica layouts. The markup is always filled, and css/journal-layout.css
   shows it only while html[data-theme="journal-tactica"]. The current theme
   keeps the existing tables and map sheet. */
(function () {
  var STEPS = ["Muster", "Logistics", "Movement", "Battles"];

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function controllerKey(value) {
    var name = String(value || "").toLowerCase();
    if (name === "loyalist" || name === "traitor" || name === "contested") return name;
    return "neutral";
  }

  function pips(filled, total, kind) {
    var html = '<span class="jt-pips ' + (kind || "") + '">';
    var n = Math.max(0, Number(filled) || 0);
    var max = Math.max(1, Number(total) || 1);
    for (var i = 1; i <= max; i++) html += '<i class="' + (i <= n ? "on" : "") + '"></i>';
    return html + "</span>";
  }

  function deadlineText(iso) {
    if (!iso) return "No deadline set";
    var date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "No deadline set";
    var day = date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    var time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return "Orders close " + day + " · " + time;
  }

  function controlCounts(systems) {
    var counts = { loyalist: 0, traitor: 0, contested: 0, neutral: 0 };
    (systems || []).forEach(function (system) {
      counts[controllerKey(system.sys_controller)] += 1;
    });
    return counts;
  }

  function phaseBanner(el, meta, systems) {
    if (!el) return;
    meta = meta || {};
    var phase = STEPS.indexOf(meta.phase) >= 0 ? meta.phase : "Muster";
    var index = STEPS.indexOf(phase);
    var turn = phase === "Muster" ? "Muster" : "Turn " + (meta.turn != null ? meta.turn : "—");
    var counts = controlCounts(systems);
    var total = counts.loyalist + counts.traitor + counts.contested + counts.neutral || 1;
    var pct = function (n) { return Math.round((n / total) * 1000) / 10; };
    var steps = STEPS.map(function (name, i) {
      var state = i < index ? "done" : i === index ? "now" : "";
      return '<li class="' + state + '"><i></i>' + esc(name) + "</li>";
    }).join("");
    el.innerHTML =
      '<div class="jt-phase-top">' +
        '<div class="jt-turn">' + esc(turn) + " · " + esc(phase) + "</div>" +
        '<ol class="jt-track">' + steps + "</ol>" +
        '<div class="jt-deadline">' + esc(deadlineText(meta.phase_ends_at)) + "</div>" +
      "</div>" +
      '<div class="jt-control">' +
        '<div class="jt-control-labels">' +
          '<span class="loyalist">Loyalist ' + counts.loyalist + "</span>" +
          '<span class="contested">Contested ' + counts.contested + "</span>" +
          '<span class="traitor">Traitor ' + counts.traitor + "</span>" +
        "</div>" +
        '<div class="jt-control-bar">' +
          '<i class="loyalist" style="width:' + pct(counts.loyalist) + '%"></i>' +
          '<i class="contested" style="width:' + pct(counts.contested) + '%"></i>' +
          '<i class="traitor" style="width:' + pct(counts.traitor) + '%"></i>' +
          '<i class="neutral" style="width:' + pct(counts.neutral) + '%"></i>' +
        "</div>" +
      "</div>";
  }

  function systemName(systems, id) {
    if (!id) return "";
    var found = (systems || []).find(function (system) { return Number(system.sys_id) === Number(id); });
    return found ? (found.sys_name || ("System " + found.sys_id)) : ("System " + id);
  }

  function parseLinks(value) {
    if (value == null || value === "") return [];
    return String(value).split(/[,;\s]+/).map(function (part) { return Number(part); }).filter(function (n) { return n > 0; });
  }

  function orderOfBattle(el, forces, systems, canEdit) {
    if (!el) return;
    var rows = forces || [];
    function column(side) {
      var list = rows.filter(function (force) { return force.allegiance === side; });
      var body = list.map(function (force) {
        var where = systemName(systems, force.sys_id) || "—";
        var moving = force.dest_sys_id ? " → " + systemName(systems, force.dest_sys_id) : "";
        var label = force.legion || force.force_type || force.game_system || force.organisation || "";
        var orders = String(force.status || "").toLowerCase() === "destroyed"
          ? "Destroyed"
          : (force.dest_sys_id ? "Moving" : "Holding");
        var edit = canEdit && canEdit(force)
          ? '<button type="button" data-edit="' + esc(force.force_id) + '">Edit</button>'
          : "";
        return '<article class="jt-force ' + side.toLowerCase() + '">' +
          '<div class="jt-force-name">' + esc(force.force_name || "Force") + "</div>" +
          (label ? '<div class="jt-force-label">' + esc(label) + "</div>" : "") +
          '<div class="jt-force-where">' + esc(where + moving) + "</div>" +
          '<div class="jt-force-foot">' + pips(force.strength, 3, side.toLowerCase()) +
            '<span class="jt-orders">' + esc(orders) + "</span>" + edit + "</div>" +
        "</article>";
      }).join("");
      if (!body) body = '<p class="jt-empty">No ' + esc(side.toLowerCase()) + " forces.</p>";
      return '<section class="jt-col ' + side.toLowerCase() + '">' +
        '<h3>' + esc(side) + " · " + list.length + "</h3>" + body + "</section>";
    }
    var loyal = rows.filter(function (force) { return force.allegiance === "Loyalist"; }).length;
    var traitor = rows.filter(function (force) { return force.allegiance === "Traitor"; }).length;
    el.innerHTML =
      '<h2 class="jt-title"><span>Order of Battle</span></h2>' +
      '<p class="jt-kicker">' + rows.length + " forces in view</p>" +
      '<div class="jt-mini">' +
        '<div><b>' + loyal + '</b><span>Loyalist</span></div>' +
        '<div><b>' + traitor + '</b><span>Traitor</span></div>' +
      "</div>" +
      '<div class="jt-cols">' + column("Loyalist") + column("Traitor") + "</div>";
  }

  function worldCards(el, systems, canEdit) {
    if (!el) return;
    var list = systems || [];
    var cards = list.map(function (system) {
      var key = controllerKey(system.sys_controller);
      var links = parseLinks(system.sys_links);
      var durability = system.sys_durability != null && system.sys_durability !== "" ? system.sys_durability : 5;
      var edit = canEdit && canEdit()
        ? '<button type="button" data-edit="' + esc(system.sys_id) + '">Edit</button>'
        : "";
      return '<article class="jt-world ' + key + '">' +
        '<div class="jt-world-top">' +
          '<h3>' + esc(system.sys_name || "System") + "</h3>" +
          '<span class="badge ' + key + '">' + esc(system.sys_controller || "Neutral") + "</span>" +
        "</div>" +
        '<p class="jt-world-type">' + esc(system.sys_type || "World") + "</p>" +
        '<dl>' +
          "<div><dt>Power</dt><dd>" + pips(system.sys_power, 5, key) + "</dd></div>" +
          "<div><dt>Durability</dt><dd>" + esc(durability) + "</dd></div>" +
          "<div><dt>Influence</dt><dd>" + esc(system.sys_loyal ?? 0) + " / " + esc(system.sys_traitor ?? 0) + "</dd></div>" +
          "<div><dt>Links</dt><dd>" + (links.length ? links.length : "—") + "</dd></div>" +
        "</dl>" +
        (system.sys_struct ? '<p class="jt-world-note">' + esc(system.sys_struct) + "</p>" : "") +
        edit +
      "</article>";
    }).join("");
    var counts = controlCounts(list);
    el.innerHTML =
      '<h2 class="jt-title"><span>Register of Worlds</span></h2>' +
      '<p class="jt-kicker">' + list.length + " systems · " +
        counts.loyalist + " loyalist · " + counts.traitor + " traitor · " + counts.contested + " contested</p>" +
      '<div class="jt-world-grid">' + (cards || '<p class="jt-empty">No systems match.</p>') + "</div>";
  }

  function dossier(el, system, forcesHere, linkNames) {
    if (!el || !system) return;
    var key = controllerKey(system.sys_controller);
    var durability = system.sys_durability != null && system.sys_durability !== "" ? system.sys_durability : 5;
    var links = (linkNames || []).filter(Boolean);
    var forces = (forcesHere || []).map(function (force) {
      var label = force.legion || force.force_type || force.game_system || force.allegiance || "";
      return '<li><div><strong>' + esc(force.force_name || "Force") + "</strong>" +
        (label ? '<em>' + esc(label) + "</em>" : "") +
        "</div>" + pips(force.strength, 3, controllerKey(force.allegiance)) + "</li>";
    }).join("");
    el.innerHTML =
      '<p class="jt-dossier-type">' + esc(system.sys_type || "World") + "</p>" +
      '<p class="jt-dossier-badge"><span class="badge ' + key + '">' + esc(system.sys_controller || "Neutral") + "</span></p>" +
      '<dl class="jt-dossier-stats">' +
        "<div><dt>Power</dt><dd>" + pips(system.sys_power, 5, key) + "</dd></div>" +
        "<div><dt>Durability</dt><dd>" + esc(durability) + "</dd></div>" +
        "<div><dt>Influence</dt><dd>" + esc(system.sys_loyal ?? 0) + " loyal / " + esc(system.sys_traitor ?? 0) + " traitor</dd></div>" +
      "</dl>" +
      (system.sys_struct ? '<p class="jt-dossier-note">' + esc(system.sys_struct) + "</p>" : "") +
      '<p class="jt-dossier-links"><span>Warp links</span> ' + (links.length ? esc(links.join(", ")) : "—") + "</p>" +
      '<h3>Forces present</h3>' +
      (forces ? "<ul>" + forces + "</ul>" : '<p class="jt-empty">No forces currently present.</p>');
  }

  window.JT = {
    phaseBanner: phaseBanner,
    orderOfBattle: orderOfBattle,
    worldCards: worldCards,
    dossier: dossier
  };
})();
