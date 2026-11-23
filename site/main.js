// Bluvu marketing site.
// Media slots: each <figure class="slot" data-src="media/..."> shows the file once it's in site/media/,
// and a labelled placeholder until then. Drop a file with the listed name in and reload.
(function () {
  "use strict";

  var ICON_IMG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/></svg>';
  var ICON_VID = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="14" height="14" rx="2"/><path d="M17 10l4-2v8l-4-2z"/></svg>';

  function placeholder(slot) {
    var kind = slot.dataset.kind === "video" ? "video" : "image";
    slot.classList.add("is-empty");
    slot.innerHTML =
      '<div class="slot-ph">' + (kind === "video" ? ICON_VID : ICON_IMG) +
      '<span class="ph-id">' + slot.dataset.slot + "</span>" +
      '<span class="ph-label">' + (slot.dataset.label || "") + "</span>" +
      '<span class="ph-file">' + slot.dataset.src + "</span></div>";
  }

  function show(slot, el) {
    slot.classList.remove("is-empty");
    slot.innerHTML = "";
    slot.appendChild(el);
  }

  function load(slot) {
    var src = slot.dataset.src;
    var alt = slot.dataset.label || "";
    if (slot.dataset.kind === "video") {
      var v = document.createElement("video");
      v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true;
      v.setAttribute("muted", ""); v.setAttribute("playsinline", "");
      v.preload = "auto";
      v.setAttribute("aria-label", alt);
      if (slot.dataset.poster) {
        // Use the poster only if it exists, so a missing poster doesn't show a broken frame.
        var p = new Image();
        p.onload = function () { v.poster = slot.dataset.poster; };
        p.src = slot.dataset.poster;
      }
      v.addEventListener("loadeddata", function () {
        show(slot, v);
        var play = v.play();
        if (play && play.catch) play.catch(function () {});
      }, { once: true });
      v.addEventListener("error", function () { /* stays a placeholder */ }, { once: true });
      v.src = src;
    } else {
      var img = new Image();
      img.alt = alt;
      img.decoding = "async";
      img.onload = function () { show(slot, img); };
      img.src = src;
    }
  }

  var slots = Array.prototype.slice.call(document.querySelectorAll(".slot[data-src]"));
  slots.forEach(placeholder);

  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { io.unobserve(e.target); load(e.target); }
      });
    }, { rootMargin: "400px 0px" });
    slots.forEach(function (s) { io.observe(s); });
  } else {
    slots.forEach(load);
  }

  // Pause off-screen videos to save battery.
  if ("IntersectionObserver" in window) {
    var vio = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        var v = e.target.querySelector("video");
        if (!v) return;
        if (e.isIntersecting) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
        else v.pause();
      });
    });
    slots.filter(function (s) { return s.dataset.kind === "video"; }).forEach(function (s) { vio.observe(s); });
  }

  // Nav: border on scroll, mobile menu.
  var nav = document.querySelector(".nav");
  var toggle = document.querySelector(".nav-toggle");
  function onScroll() { nav.classList.toggle("scrolled", window.scrollY > 8); }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  toggle.addEventListener("click", function () {
    var open = nav.classList.toggle("open");
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  });
  document.querySelectorAll(".nav-links a").forEach(function (a) {
    a.addEventListener("click", function () { nav.classList.remove("open"); toggle.setAttribute("aria-expanded", "false"); });
  });

  // Code tabs.
  var tabs = document.querySelectorAll(".code-tabs button");
  tabs.forEach(function (t) {
    t.addEventListener("click", function () {
      tabs.forEach(function (o) { o.setAttribute("aria-selected", o === t ? "true" : "false"); });
      document.querySelectorAll(".code[data-pane]").forEach(function (p) { p.hidden = p.dataset.pane !== t.dataset.tab; });
    });
  });

  // Fade sections in as they scroll into view.
  var revealEls = document.querySelectorAll(".section-head, .card, .feature, .diagram, .steps li, .code-card, .specs, .quote, .gallery, .uses article, details");
  if ("IntersectionObserver" in window && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    var rio = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); rio.unobserve(e.target); } });
    }, { rootMargin: "0px 0px -8% 0px" });
    revealEls.forEach(function (el) { el.classList.add("reveal"); rio.observe(el); });
  }

  document.getElementById("year").textContent = new Date().getFullYear();
})();
