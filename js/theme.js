/* Resolves the style before the stylesheets run, so the first paint is correct.
   A visitor choice in localStorage wins. Otherwise the site default on <html> is used.
   Missing or unknown values stay on the current look. */
(function () {
  var STORAGE_KEY = "sh-theme";
  var root = document.documentElement;

  function siteDefault() {
    return root.getAttribute("data-theme-default") === "journal-tactica" ? "journal-tactica" : "current";
  }

  function storedChoice() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      return null;
    }
  }

  function resolvedTheme(choice) {
    if (choice === "current" || choice === "journal-tactica") return choice;
    return siteDefault();
  }

  function apply(theme) {
    root.setAttribute("data-theme", theme === "journal-tactica" ? "journal-tactica" : "current");
  }

  apply(resolvedTheme(storedChoice()));

  function mountSwitch() {
    var menu = document.getElementById("site-menu");
    if (!menu || document.getElementById("theme-switch")) return;
    var wrap = document.createElement("div");
    wrap.className = "theme-switch";
    wrap.id = "theme-switch";
    var label = document.createElement("label");
    label.htmlFor = "theme-choice";
    label.textContent = "Style";
    var select = document.createElement("select");
    select.id = "theme-choice";
    select.setAttribute("aria-label", "Style");
    [
      ["site", "Use site default"],
      ["current", "Current"],
      ["journal-tactica", "Journal Tactica"]
    ].forEach(function (pair) {
      var opt = document.createElement("option");
      opt.value = pair[0];
      opt.textContent = pair[1];
      select.appendChild(opt);
    });
    var choice = storedChoice();
    select.value = choice === "current" || choice === "journal-tactica" ? choice : "site";
    select.addEventListener("change", function () {
      var value = select.value;
      try {
        if (value === "site") localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, value);
      } catch (err) {}
      apply(resolvedTheme(value === "site" ? null : value));
    });
    wrap.appendChild(label);
    wrap.appendChild(select);
    menu.appendChild(wrap);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountSwitch);
  else mountSwitch();

  window.SHTheme = {
    storageKey: STORAGE_KEY,
    siteDefault: siteDefault,
    apply: apply,
    resolvedTheme: resolvedTheme
  };
})();
