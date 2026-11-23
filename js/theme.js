/* Picks the style before CSS runs. The current look is "current".
   A later switch can set data-theme="journal-tactica" on <html> first;
   this leaves an attribute that is already there alone. */
(function () {
  var root = document.documentElement;
  if (!root.hasAttribute("data-theme")) {
    root.setAttribute("data-theme", "current");
  }
})();
