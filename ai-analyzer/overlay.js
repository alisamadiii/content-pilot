/**
 * AI-analyzer preview overlay. Injected inline on every page by integration.mjs,
 * ONLY inside the live-preview dev server. Inert unless the page is framed
 * (the hub is the only thing that ever frames the preview URL).
 *
 * Pick mode is OFF by default so the client can browse their site normally —
 * a floating bottom-right button toggles it (state survives navigation via
 * sessionStorage). While on, clicking an editable element posts its source
 * ref + text + page up to the hub, which attaches that context to the next AI
 * chat message so the AI edits the right file without scanning the repo.
 * Every page load also posts a `preview-navigate` message so the hub's page
 * tree follows in-frame navigation.
 */

(function () {
  // Only active when embedded in the hub editor.
  if (window.parent === window) return;
  if (window.__aiAnalyzerBound) return;

  var EDITABLE =
    "h1,h2,h3,h4,h5,h6,p,span,a,button,img,li,blockquote,figcaption," +
    "label,input:not([type=hidden]):not([aria-hidden=true]),textarea";
  var ACCENT = "#4f7fff";
  var STORE_KEY = "ai-analyzer-active";

  function isActive() {
    try {
      return sessionStorage.getItem(STORE_KEY) === "1";
    } catch (err) {
      return false;
    }
  }

  function setActive(on) {
    try {
      sessionStorage.setItem(STORE_KEY, on ? "1" : "0");
    } catch (err) {
      /* storage unavailable — state just won't survive navigation */
    }
    syncUi();
  }

  function post(message) {
    try {
      window.parent.postMessage(message, "*");
    } catch (err) {
      /* cross-origin parent — nothing to do */
    }
  }

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

  var dot, hint, toggle;

  // The hub can hide the floating toggle (it renders its own cursor button in
  // the canvas header) and drive pick mode over postMessage. Hub builds that
  // predate these messages simply never send them.
  var launcherHidden = false;

  window.addEventListener("message", function (e) {
    if (e.source !== window.parent) return;
    var d = e.data;
    if (!d || d.cms !== 1 || typeof d.type !== "string") return;
    if (d.type === "chrome") {
      launcherHidden = d.launcher === "hidden";
      syncUi();
    } else if (d.type === "pick-mode") {
      setActive(!!d.active);
    }
  });

  // Cursor-arrow glyph for the toggle button.
  var ICON =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" ' +
    'xmlns="http://www.w3.org/2000/svg"><path d="M4 3l7.6 18 2.3-7.6L21 11 4 3z" ' +
    'stroke="currentColor" stroke-width="2" stroke-linejoin="round" fill="none"/></svg>';

  function syncUi() {
    var on = isActive();
    if (dot) dot.style.display = on ? "" : "none";
    if (hint) hint.style.display = on ? "" : "none";
    if (toggle) {
      toggle.style.display = launcherHidden ? "none" : "";
      toggle.style.background = on ? ACCENT : "#fff";
      toggle.style.color = on ? "#fff" : ACCENT;
      toggle.setAttribute("aria-pressed", on ? "true" : "false");
      toggle.title = on ? "Turn off element picking" : "Point the AI at an element";
    }
    if (!on) target = null;
  }

  function makeOverlay() {
    if (document.getElementById("ai-analyzer-dot")) {
      syncUi();
      return;
    }

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

    toggle = document.createElement("button");
    toggle.id = "ai-analyzer-toggle";
    toggle.type = "button";
    toggle.innerHTML = ICON;
    toggle.style.cssText =
      "position:fixed;bottom:16px;right:16px;z-index:2147483647;" +
      "width:42px;height:42px;border-radius:50%;display:flex;align-items:center;" +
      "justify-content:center;cursor:pointer;border:2px solid " +
      ACCENT +
      ";box-shadow:0 4px 16px rgba(0,0,0,.2);padding:0;" +
      "transition:background .15s ease,color .15s ease,transform .1s ease;";
    toggle.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      setActive(!isActive());
    });
    toggle.addEventListener("mousedown", function () {
      toggle.style.transform = "scale(.92)";
    });
    toggle.addEventListener("mouseup", function () {
      toggle.style.transform = "";
    });

    document.body.appendChild(dot);
    document.body.appendChild(hint);
    document.body.appendChild(toggle);
    syncUi();
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
    if (
      el.closest("#ai-analyzer-dot") ||
      el.closest("#ai-analyzer-hint") ||
      el.closest("#ai-analyzer-toggle")
    )
      return null;
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
        if (!isActive()) return;
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
        // Pick mode off → the page behaves normally (links navigate).
        if (!isActive()) return;
        // ⌘/Ctrl-click passes through so the client can follow links.
        if (e.metaKey || e.ctrlKey) return;
        var el = editableFrom(e.target);
        if (!el) return;
        e.preventDefault();
        e.stopPropagation();
        post({
          cms: 1,
          v: 2,
          type: "element-pick",
          sourceRef: sourceRefFor(el),
          elementText: elementTextFor(el).slice(0, 300),
          pageUrl: location.href,
          pagePath: location.pathname,
        });
      },
      true
    );

    requestAnimationFrame(frame);
  }

  function init() {
    if (window.parent === window) return;
    makeOverlay();
    bindOnce();
    // Sidebar sync: tell the hub which page the frame is on — every load,
    // regardless of pick-mode state.
    post({
      cms: 1,
      v: 2,
      type: "preview-navigate",
      pagePath: location.pathname,
      pageUrl: location.href,
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
  // Astro ClientRouter swaps <body> on view transitions — recreate overlay DOM.
  document.addEventListener("astro:page-load", init);
})();
