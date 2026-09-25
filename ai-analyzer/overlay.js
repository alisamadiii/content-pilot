/**
 * AI-analyzer preview overlay. Injected inline on every page by integration.mjs,
 * ONLY inside the live-preview dev server. Inert unless the page is framed
 * (the hub is the only thing that ever frames the preview URL).
 *
 * It never writes anything and needs no token: on click of an editable element
 * it posts the element's source ref + text + page up to the hub, which attaches
 * that context to the next AI chat message so the AI edits the right file
 * without scanning the whole repo.
 */

(function () {
  // Only active when embedded in the hub editor.
  if (window.parent === window) return;
  if (window.__aiAnalyzerBound) return;

  var EDITABLE =
    "h1,h2,h3,h4,h5,h6,p,span,a,button,img,li,blockquote,figcaption," +
    "label,input:not([type=hidden]):not([aria-hidden=true]),textarea";
  var ACCENT = "#4f7fff";

  function sourceRefFor(el) {
    var srcEl = el.closest("[data-cms-src]");
    return srcEl ? srcEl.getAttribute("data-cms-src") || "" : "";
  }

  function elementTextFor(el) {
    var tag = el.tagName.toLowerCase();
    if (tag === "img") {
      return (
        'image src="' +
        (el.getAttribute("src") || "") +
        '" alt="' +
        (el.getAttribute("alt") || "") +
        '"'
      );
    }
    if (tag === "input" || tag === "textarea") {
      return el.value || el.getAttribute("placeholder") || "";
    }
    return (el.textContent || "").replace(/\s+/g, " ").trim();
  }

  var dot, hint;

  function makeOverlay() {
    if (document.getElementById("ai-analyzer-dot")) return;

    dot = document.createElement("div");
    dot.id = "ai-analyzer-dot";
    dot.style.cssText =
      "position:fixed;top:0;left:0;pointer-events:none;z-index:2147483646;" +
      "will-change:transform,width,height;width:10px;height:10px;border-radius:50%;" +
      "background:" +
      ACCENT +
      ";border:2px solid " +
      ACCENT +
      ";box-sizing:border-box;opacity:1;" +
      "transition:background .18s ease,opacity .15s ease;";

    hint = document.createElement("div");
    hint.id = "ai-analyzer-hint";
    hint.style.cssText =
      "position:fixed;bottom:16px;left:50%;transform:translateX(-50%);" +
      "z-index:2147483647;background:#111;color:#fff;width:max-content;" +
      "font:13px/1 system-ui,sans-serif;padding:10px 16px;border-radius:24px;" +
      "box-shadow:0 4px 16px rgba(0,0,0,.25);pointer-events:none;";
    hint.textContent = "Click any element to point the AI at it · ⌘-click to follow links";

    document.body.appendChild(dot);
    document.body.appendChild(hint);
  }

  // ---------- hover morph animation ----------

  var mouse = { x: -100, y: -100 };
  var cur = { x: -100, y: -100, w: 10, h: 10, r: 5 };
  var target = null;

  function lerp(a, b, f) {
    return a + (b - a) * f;
  }

  function frame() {
    var goal;
    if (target && document.body.contains(target)) {
      var rect = target.getBoundingClientRect();
      goal = { x: rect.left, y: rect.top, w: rect.width, h: rect.height, r: 8 };
    } else {
      target = null;
      goal = { x: mouse.x - 5, y: mouse.y - 5, w: 10, h: 10, r: 5 };
    }
    var f = 0.22;
    cur.x = lerp(cur.x, goal.x, f);
    cur.y = lerp(cur.y, goal.y, f);
    cur.w = lerp(cur.w, goal.w, f);
    cur.h = lerp(cur.h, goal.h, f);
    cur.r = lerp(cur.r, goal.r, f);
    if (dot && document.body.contains(dot)) {
      dot.style.transform = "translate3d(" + cur.x + "px," + cur.y + "px,0)";
      dot.style.width = cur.w + "px";
      dot.style.height = cur.h + "px";
      dot.style.borderRadius = target ? cur.r + "px" : "50%";
      dot.style.background = target ? "transparent" : ACCENT;
    }
    requestAnimationFrame(frame);
  }

  // ---------- events ----------

  function editableFrom(node) {
    if (!(node instanceof Element)) return null;
    var el = node.closest(EDITABLE);
    if (!el || !el.closest("[data-cms-src]")) return null;
    if (el.closest("#ai-analyzer-dot") || el.closest("#ai-analyzer-hint")) return null;
    return el;
  }

  function bindOnce() {
    if (window.__aiAnalyzerBound) return;
    window.__aiAnalyzerBound = true;

    document.addEventListener(
      "mousemove",
      function (e) {
        mouse.x = e.clientX;
        mouse.y = e.clientY;
      },
      { passive: true }
    );

    document.addEventListener(
      "mouseover",
      function (e) {
        var el = editableFrom(e.target);
        if (el) target = el;
      },
      true
    );

    document.addEventListener(
      "mouseout",
      function (e) {
        if (
          target &&
          e.target instanceof Element &&
          e.target.closest(EDITABLE) === target
        ) {
          var to = e.relatedTarget;
          if (!(to instanceof Element) || editableFrom(to) !== target) target = null;
        }
      },
      true
    );

    document.addEventListener(
      "click",
      function (e) {
        // ⌘/Ctrl-click passes through so the client can follow links.
        if (e.metaKey || e.ctrlKey) return;
        var el = editableFrom(e.target);
        if (!el) return;
        e.preventDefault();
        e.stopPropagation();
        try {
          window.parent.postMessage(
            {
              cms: 1,
              v: 2,
              type: "element-pick",
              sourceRef: sourceRefFor(el),
              elementText: elementTextFor(el).slice(0, 300),
              pageUrl: location.href,
              pagePath: location.pathname,
            },
            "*"
          );
        } catch (err) {
          /* cross-origin parent — nothing to do */
        }
      },
      true
    );

    requestAnimationFrame(frame);
  }

  function init() {
    if (window.parent === window) return;
    makeOverlay();
    bindOnce();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
  // Astro ClientRouter swaps <body> on view transitions — recreate overlay DOM.
  document.addEventListener("astro:page-load", init);
})();
