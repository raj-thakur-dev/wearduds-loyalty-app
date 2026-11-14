/* Wearduds Club storefront runtime. No dependencies.
   Talks to the app through the Shopify app proxy (/apps/club/*), which signs
   every request; the server only trusts the signed customer id. */
(function () {
  "use strict";
  if (window.WeardudsClub) return;

  var cfg = Object.assign(
    { proxy: "/apps/club", signedIn: false, loginUrl: "/account/login", registerUrl: "/account/register", accent: "", clubPageUrl: "/pages/wearduds-club" },
    window.WDClubConfig || {}
  );
  var REF_KEY = "wdc_ref";
  var state = null;
  var loading = null;
  var listeners = [];
  var lastCartSubtotal = null;

  /* ---------- helpers ---------- */
  function h(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === "class") node.className = v;
        else if (k === "text") node.textContent = v;
        else if (k.slice(0, 2) === "on" && typeof v === "function") node.addEventListener(k.slice(2), v);
        else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
        else node.setAttribute(k, v === true ? "" : v);
      }
    }
    for (var i = 2; i < arguments.length; i++) append(node, arguments[i]);
    return node;
  }
  function append(node, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) return child.forEach(function (c) { append(node, c); });
    node.appendChild(typeof child === "object" ? child : document.createTextNode(String(child)));
  }
  function pts(n) { return Number(n || 0).toLocaleString("en-IN"); }
  function money(n) {
    var v = Math.round(Number(n || 0) * 100) / 100;
    try {
      return new Intl.NumberFormat("en-IN", { style: "currency", currency: (state && state.program.currency) || "INR", maximumFractionDigits: v % 1 === 0 ? 0 : 2 }).format(v);
    } catch (e) { return "₹" + v; }
  }
  function worth(points) { return money(Number(points || 0) * ((state && state.program.pointValue) || 0.1)); }
  function date(iso) { return iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : ""; }
  function plural(n, one, many) { return n === 1 ? one : many; }
  function icon(path, label) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2"); svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round");
    if (label) { svg.setAttribute("role", "img"); svg.setAttribute("aria-label", label); } else svg.setAttribute("aria-hidden", "true");
    path.split("|").forEach(function (d) { var p = document.createElementNS("http://www.w3.org/2000/svg", "path"); p.setAttribute("d", d); svg.appendChild(p); });
    return svg;
  }
  var ICONS = {
    tag: "M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z|M7.5 7.5h.01",
    close: "M18 6 6 18|M6 6l12 12",
    copy: "M9 9h11v11H9z|M5 15H4V4h11v1",
  };

  function copy(text, btn) {
    var done = function () { if (btn) { var t = btn.textContent; btn.textContent = "Copied"; setTimeout(function () { btn.textContent = t; }, 1600); } };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, done);
    else { var ta = h("textarea", { style: { position: "fixed", opacity: "0" } }); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); } catch (e) { /* copy unsupported */ } ta.remove(); done(); }
  }

  /* ---------- API ---------- */
  function request(path, opts) {
    return fetch(cfg.proxy + path, Object.assign({ credentials: "same-origin", headers: { Accept: "application/json" } }, opts || {})).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) { var err = new Error(body.error || "Something went wrong. Try again."); err.code = body.code; throw err; }
        return body;
      });
    });
  }
  var reported = false;
  function load(force) {
    if (loading && !force) return loading;
    var params = [];
    if (lastCartSubtotal !== null) params.push("cart=" + encodeURIComponent(lastCartSubtotal));
    if (!reported) {
      var sf = [];
      if (window.WDClubEmbed) sf.push("e");
      if (document.querySelector("[data-wdc-page]")) sf.push("p");
      if (sf.length) params.push("sf=" + sf.join(","));
      reported = true;
    }
    var q = params.length ? "?" + params.join("&") : "";
    loading = request("/state" + q).then(function (s) {
      state = s; loading = null; claimReferral(); emit(); return s;
    }, function (err) { loading = null; throw err; });
    return loading;
  }
  function act(name, body) {
    return request("/action/" + name, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body || {}) });
  }
  function emit() { listeners.forEach(function (fn) { try { fn(state); } catch (e) { console.error(e); } }); }
  function onState(fn) { listeners.push(fn); if (state) fn(state); }

  /* ---------- referrals: ?ref=CODE in any link ---------- */
  function captureReferral() {
    try {
      var params = new URLSearchParams(location.search);
      var code = params.get("ref") || params.get("wdref");
      if (code && /^[A-Za-z0-9-]{4,20}$/.test(code)) {
        localStorage.setItem(REF_KEY, code.toUpperCase());
        // Also on the cart, so a referral still counts if they check out without signing in first.
        fetch("/cart/update.js", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ attributes: { _club_ref: code.toUpperCase() } }) }).catch(function () {});
      }
    } catch (e) { /* storage blocked (private mode); referral just isn't remembered */ }
  }
  function claimReferral() {
    var code;
    try { code = localStorage.getItem(REF_KEY); } catch (e) { return; }
    if (!code || !state || !state.member || state.member.referral.code === code) return;
    try { localStorage.removeItem(REF_KEY); } catch (e) { /* ignore */ }
    act("referral", { code: code }).then(function (res) { if (res && res.linked) load(true); }).catch(function () {});
  }

  /* ---------- shared pieces ---------- */
  function wovenLabel(s, opts) {
    opts = opts || {};
    var m = s.member;
    var label = h("div", { class: "wdc-label" + (opts.className ? " " + opts.className : "") });
    if (!m) {
      var signup = s.earn.find(function (e) { return e.key === "signup"; });
      append(label, [
        h("div", { class: "wdc-label__top" }, h("span", { class: "wdc-label__name", text: s.program.name })),
        h("p", { class: "wdc-label__guest-title", text: s.program.widget.guestHeadline || "Get paid to get dressed." }),
        h("p", { style: { margin: "0 0 14px" }, text: signup ? "Join free and start with " + pts(signup.points) + " points (" + worth(signup.points) + " off)." : s.program.widget.guestBody }),
        h("div", { class: "wdc-page__actions" },
          h("a", { class: "wdc-btn", href: cfg.registerUrl, text: "Join the club" }),
          h("a", { class: "wdc-btn wdc-btn--ghost", href: cfg.loginUrl, text: "Sign in" }))
      ]);
      return label;
    }
    var tier = m.tier;
    append(label, [
      h("div", { class: "wdc-label__top" },
        h("span", { class: "wdc-label__name", text: m.firstName ? m.firstName : s.program.name }),
        tier ? h("span", { class: "wdc-label__tier", style: { "--tier": tier.color } }, h("i"), tier.name) : null),
      h("p", { class: "wdc-label__worth", "aria-label": m.worthLabel + " to spend" }, m.worthLabel),
      h("p", { class: "wdc-label__points", style: { margin: 0 } },
        pts(m.balance) + " " + plural(m.balance, "point", "points") + " to spend",
        m.pending ? h("span", { class: "wdc-label__pending", text: pts(m.pending) + " more unlock after your order is delivered" }) : null)
    ]);
    return label;
  }

  function tierProgress(s) {
    var m = s.member;
    if (!m || !m.nextTier) return m && m.tier ? h("p", { class: "wdc-progress__text", text: "You're at the top tier. Thanks for riding with us." }) : null;
    var fill = h("div", { class: "wdc-progress__fill" });
    requestAnimationFrame(function () { fill.style.width = m.tierProgress + "%"; });
    return h("div", { class: "wdc-progress" },
      h("div", { class: "wdc-progress__bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(m.tierProgress), "aria-label": "Progress to " + m.nextTier.name }, fill),
      h("p", { class: "wdc-progress__text", text: pts(m.nextTier.pointsNeeded) + " points to " + m.nextTier.name + (m.nextTier.multiplier > 1 ? ", where every order earns " + m.nextTier.multiplier + "x" : "") }));
  }

  function alertBox(kind, text) { return h("div", { class: "wdc-alert wdc-alert--" + kind, role: kind === "error" ? "alert" : "status", text: text }); }

  function codeTag(c, fresh) {
    var copyBtn = h("button", { type: "button", class: "wdc-btn wdc-btn--small wdc-btn--ghost", text: "Copy" });
    copyBtn.addEventListener("click", function () { copy(c.code, copyBtn); });
    return h("div", { class: "wdc-code" + (fresh ? " wdc-pop" : "") },
      h("span", { class: "wdc-code__value", text: c.code }),
      h("div", { class: "wdc-code__actions" }, copyBtn, h("a", { class: "wdc-btn wdc-btn--small", href: c.applyUrl, text: "Use now" })),
      h("span", { class: "wdc-code__meta", text: c.label + (c.minSubtotal ? " on orders over " + money(c.minSubtotal) : "") + (c.expiresAt ? ". Use by " + date(c.expiresAt) : "") }));
  }

  /* Rewards list with an inline "spend points?" confirmation. */
  function rewardsList(s, ctx) {
    var wrap = h("div");
    var issued = h("div");
    (s.codes || []).forEach(function (c) { issued.appendChild(codeTag(c)); });
    if (s.codes && s.codes.length) append(wrap, [h("p", { class: "wdc-section-title", style: { marginTop: "8px" }, text: "Your codes" }), issued]);
    else append(wrap, issued);

    var list = h("ul", { class: "wdc-list", "aria-label": "Rewards" });
    s.rewards.forEach(function (r) {
      var row = h("li", { class: "wdc-row wdc-reward" + (r.canRedeem ? "" : " wdc-reward--locked") });
      var meta = pts(r.points) + " points" + (r.minSubtotal ? ", orders over " + money(r.minSubtotal) : "") + (r.minTier ? ", " + r.minTier + " members" : "");
      append(row, h("div", null, h("div", { class: "wdc-reward__value", text: r.title }), h("div", { class: "wdc-row__meta", text: meta })));
      if (!s.member) {
        append(row, h("span", { class: "wdc-row__meta", text: "Sign in" }));
      } else if (!r.canRedeem) {
        append(row, h("span", { class: "wdc-row__meta", text: r.tierLocked ? "Unlocks at " + r.minTier : pts(r.pointsNeeded) + " to go" }));
      } else {
        var btn = h("button", { type: "button", class: "wdc-btn wdc-btn--small", text: "Get code", "aria-expanded": "false" });
        btn.addEventListener("click", function () {
          if (row.querySelector(".wdc-confirm")) return;
          btn.setAttribute("aria-expanded", "true");
          var yes = h("button", { type: "button", class: "wdc-btn wdc-btn--small wdc-btn--accent", text: "Spend " + pts(r.points) + " points" });
          var no = h("button", { type: "button", class: "wdc-link", text: "Keep them" });
          var box = h("div", { class: "wdc-confirm" }, h("p", { text: "Swap " + pts(r.points) + " points for " + r.title + "? You'll get a code for your next order." }), yes, no);
          no.addEventListener("click", function () { box.remove(); btn.setAttribute("aria-expanded", "false"); btn.focus(); });
          yes.addEventListener("click", function () {
            yes.disabled = true; yes.textContent = "Getting your code";
            act("redeem", { rewardId: r.id }).then(function (res) {
              box.remove();
              issued.prepend(codeTag({ code: res.code, label: res.label, minSubtotal: res.minSubtotal, expiresAt: res.expiresAt, applyUrl: res.applyUrl }, true));
              load(true);
              if (ctx && ctx.onRedeemed) ctx.onRedeemed(res);
            }, function (err) {
              yes.disabled = false; yes.textContent = "Spend " + pts(r.points) + " points";
              var old = box.querySelector(".wdc-alert"); if (old) old.remove();
              box.appendChild(alertBox("error", err.message));
            });
          });
          row.appendChild(box);
          yes.focus();
        });
        append(row, btn);
      }
      list.appendChild(row);
    });
    append(wrap, list);
    if (s.member && s.program.maxRedeemPercent < 100) append(wrap, h("p", { class: "wdc-note", text: "Points can pay for up to " + s.program.maxRedeemPercent + "% of an order. 100 points = " + worth(100) + "." }));
    return wrap;
  }

  function birthdayForm() {
    var months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    var m = h("select", { class: "wdc-select", id: "wdc-bm" }, h("option", { value: "", text: "Month" }), months.map(function (n, i) { return h("option", { value: String(i + 1), text: n }); }));
    var d = h("select", { class: "wdc-select", id: "wdc-bd" }, h("option", { value: "", text: "Day" }), Array.from({ length: 31 }, function (_, i) { return h("option", { value: String(i + 1), text: String(i + 1) }); }));
    var save = h("button", { type: "submit", class: "wdc-btn wdc-btn--small", text: "Save birthday" });
    var form = h("form", { class: "wdc-inline", style: { gridColumn: "1 / -1" } },
      h("div", { class: "wdc-field" }, h("label", { for: "wdc-bm", text: "Month" }), m),
      h("div", { class: "wdc-field" }, h("label", { for: "wdc-bd", text: "Day" }), d), save);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var old = form.parentNode.querySelector(".wdc-alert"); if (old) old.remove();
      if (!m.value || !d.value) { form.after(alertBox("error", "Pick a month and a day.")); return; }
      save.disabled = true;
      act("birthday", { month: m.value, day: d.value }).then(function () { load(true); }, function (err) { save.disabled = false; form.after(alertBox("error", err.message)); });
    });
    return form;
  }

  function referralBox(s) {
    var link = location.origin + "/?ref=" + encodeURIComponent(s.member.referral.code);
    var friend = s.earn.find(function (e) { return e.key === "referral"; });
    var bonus = friend && friend.friendPoints ? " and " + pts(friend.friendPoints) + " points (" + worth(friend.friendPoints) + " off)" : "";
    var msg = "Join the " + s.program.name + " with my link" + bonus + ": " + link;
    var copyBtn = h("button", { type: "button", class: "wdc-btn wdc-btn--small wdc-btn--ghost", text: "Copy link" });
    copyBtn.addEventListener("click", function () { copy(link, copyBtn); });
    var share = navigator.share
      ? h("button", { type: "button", class: "wdc-btn wdc-btn--small", text: "Share", onclick: function () { navigator.share({ text: msg }).catch(function () {}); } })
      : h("a", { class: "wdc-btn wdc-btn--small", href: "https://wa.me/?text=" + encodeURIComponent(msg), target: "_blank", rel: "noopener", text: "Send on WhatsApp" });
    return h("div", { style: { gridColumn: "1 / -1", display: "grid", gap: "8px" } },
      h("input", { class: "wdc-input", readonly: true, value: link, "aria-label": "Your referral link", onfocus: function (e) { e.target.select(); } }),
      h("div", { class: "wdc-inline" }, copyBtn, share),
      s.member.referral.signedUp ? h("p", { class: "wdc-note", text: s.member.referral.signedUp + " " + plural(s.member.referral.signedUp, "friend has", "friends have") + " joined, " + s.member.referral.rewarded + " ordered." }) : null);
  }

  function instagramBox(s, row) {
    var btn = h("button", { type: "button", class: "wdc-btn wdc-btn--small", text: "Verify follow" });
    btn.addEventListener("click", function () {
      btn.disabled = true;
      act("instagram").then(function (res) {
        btn.remove();
        if (res.verified) { load(true); return; }
        var copyBtn = h("button", { type: "button", class: "wdc-btn wdc-btn--small wdc-btn--ghost", text: "Copy code" });
        copyBtn.addEventListener("click", function () { copy(res.code, copyBtn); });
        row.appendChild(h("div", { class: "wdc-confirm" },
          h("p", null, "Follow @" + res.handle + ", then DM us this code: ", h("strong", { text: res.code })),
          copyBtn,
          h("a", { class: "wdc-btn wdc-btn--small", href: "https://ig.me/m/" + encodeURIComponent(res.handle), target: "_blank", rel: "noopener", text: "Open Instagram" })));
      }, function (err) { btn.disabled = false; row.appendChild(alertBox("error", err.message)); });
    });
    return btn;
  }

  function earnList(s) {
    var list = h("ul", { class: "wdc-list", "aria-label": "Ways to earn" });
    s.earn.forEach(function (e) {
      var row = h("li", { class: "wdc-row" });
      append(row, h("div", null, h("div", { class: "wdc-row__title", text: e.title }), e.detail ? h("div", { class: "wdc-row__meta", text: e.detail }) : null));
      var right;
      if (e.status === "done") right = h("span", { class: "wdc-done", text: "Done" });
      else if (e.points) right = h("span", { class: "wdc-row__pts", text: "+" + pts(e.points) });
      else right = h("span", { class: "wdc-row__meta", text: "Every order" });
      append(row, right);
      if (s.member && e.status !== "done") {
        if (e.key === "birthday") append(row, birthdayForm());
        if (e.key === "referral") append(row, referralBox(s));
        if (e.key === "instagram") { row.removeChild(right); append(row, instagramBox(s, row)); }
      }
      list.appendChild(row);
    });
    return list;
  }

  function activityList(s) {
    if (!s.member) return h("p", { class: "wdc-note", text: "Sign in to see your points history." });
    if (!s.history.length) return h("p", { class: "wdc-note", text: "Nothing yet. Your first order starts the count." });
    var list = h("ul", { class: "wdc-list", "aria-label": "Points history" });
    s.history.forEach(function (e) {
      list.appendChild(h("li", { class: "wdc-row" },
        h("div", null, h("div", { class: "wdc-row__title", text: e.description }), h("div", { class: "wdc-row__meta", text: date(e.date) + (e.pending ? ", unlocks after delivery" : "") })),
        h("span", { class: "wdc-row__pts" + (e.points < 0 ? " wdc-row__pts--minus" : ""), text: (e.points > 0 ? "+" : "") + pts(e.points) })));
    });
    var wrap = h("div", null, list);
    if (s.member.nextExpiry) append(wrap, h("p", { class: "wdc-note", text: pts(s.member.nextExpiry.points) + " points expire on " + date(s.member.nextExpiry.date) + ". Use them before then." }));
    return wrap;
  }

  function tabs(defs, initial, onSelect) {
    var bar = h("div", { class: "wdc-tabs", role: "tablist" });
    var panels = h("div");
    var buttons = [];
    var uid = "wdc" + Math.random().toString(36).slice(2, 7);
    defs.forEach(function (d, i) {
      var b = h("button", { type: "button", class: "wdc-tab", role: "tab", id: uid + "-t" + i, "aria-controls": uid + "-p" + i, "aria-selected": String(d.key === initial), tabindex: d.key === initial ? "0" : "-1", text: d.label });
      var p = h("div", { class: "wdc-tabpanel", role: "tabpanel", id: uid + "-p" + i, "aria-labelledby": uid + "-t" + i, hidden: d.key !== initial }, d.render());
      b.addEventListener("click", function () { select(i); });
      b.addEventListener("keydown", function (ev) {
        if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") { ev.preventDefault(); var n = (i + (ev.key === "ArrowRight" ? 1 : defs.length - 1)) % defs.length; select(n); buttons[n].focus(); }
      });
      buttons.push(b); bar.appendChild(b); panels.appendChild(p);
    });
    function select(i) {
      buttons.forEach(function (b, j) { b.setAttribute("aria-selected", String(i === j)); b.tabIndex = i === j ? 0 : -1; panels.children[j].hidden = i !== j; });
      current = defs[i].key;
      if (onSelect) onSelect(current);
    }
    var current = initial;
    return { node: h("div", null, bar, panels), current: function () { return current; } };
  }

  /* ---------- Floating panel ---------- */
  var panel, overlay, panelBody, launcher, lastFocus, currentTab = "rewards";

  function buildPanel() {
    overlay = h("div", { class: "wdc-overlay", hidden: true, onclick: close });
    panelBody = h("div", { class: "wdc-panel__body" });
    panel = h("div", { class: "wdc wdc-panel", role: "dialog", "aria-modal": "true", "aria-labelledby": "wdc-panel-title", hidden: true, tabindex: "-1" },
      h("div", { class: "wdc-grabber", "aria-hidden": "true" }),
      h("div", { class: "wdc-panel__head" },
        h("h2", { class: "wdc-panel__title", id: "wdc-panel-title", text: (state && state.program.name) || "Rewards" }),
        h("button", { type: "button", class: "wdc-panel__close", "aria-label": "Close rewards", onclick: close }, icon(ICONS.close))),
      panelBody);
    if (cfg.accent) panel.style.setProperty("--wdc-accent", cfg.accent);
    panel.addEventListener("keydown", trapFocus);
    var host = h("div", { class: "wdc" }, overlay, panel);
    document.body.appendChild(host);
  }

  function renderPanel() {
    if (!panel) return;
    panel.querySelector(".wdc-panel__title").textContent = state.program.name;
    panelBody.replaceChildren();
    append(panelBody, [wovenLabel(state), tierProgress(state)]);
    var t = tabs([
      { key: "rewards", label: "Rewards", render: function () { return rewardsList(state); } },
      { key: "earn", label: "Earn", render: function () { return earnList(state); } },
      { key: "activity", label: "Activity", render: function () { return activityList(state); } },
    ], currentTab, function (key) { currentTab = key; });
    panelBody.appendChild(t.node);
    append(panelBody, h("p", { class: "wdc-note", style: { marginTop: "20px" } }, h("a", { href: (state.program.widget && state.program.widget.clubPageUrl) || cfg.clubPageUrl, class: "wdc-link", text: "How the club works" })));
  }

  function open(tab) {
    if (!panel) buildPanel();
    if (typeof tab === "string") currentTab = tab;
    lastFocus = document.activeElement;
    overlay.hidden = false; panel.hidden = false;
    document.documentElement.classList.add("wdc-locked");
    requestAnimationFrame(function () { overlay.classList.add("is-open"); panel.classList.add("is-open"); });
    if (state) renderPanel();
    else panelBody.replaceChildren(h("div", { class: "wdc-skel", style: { height: "180px" } }), h("div", { class: "wdc-skel", style: { height: "220px", marginTop: "20px" } }));
    load(true).then(renderPanel, function (err) { panelBody.replaceChildren(alertBox("error", err.message)); });
    panel.focus();
  }

  function close() {
    if (!panel || panel.hidden) return;
    overlay.classList.remove("is-open"); panel.classList.remove("is-open");
    document.documentElement.classList.remove("wdc-locked");
    var done = function () { overlay.hidden = true; panel.hidden = true; };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) done(); else setTimeout(done, 260);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function trapFocus(e) {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key !== "Tab") return;
    var f = panel.querySelectorAll('a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])');
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function buildLauncher() {
    if (!cfg.showLauncher || launcher) return;
    launcher = h("button", { type: "button", class: "wdc wdc-launcher" + (cfg.launcherPosition === "left" ? " wdc-launcher--left" : ""), "aria-haspopup": "dialog", onclick: function () { open(); } },
      icon(ICONS.tag), h("span", { class: "wdc-launcher__text", text: cfg.launcherLabel || "Rewards" }));
    if (cfg.accent) launcher.style.setProperty("--wdc-accent", cfg.accent);
    document.body.appendChild(launcher);
  }
  function updateLauncher(s) {
    // Before launch, only members (testers) see the widget.
    var visible = s.program.live || !!s.member;
    if (!visible) { if (launcher) launcher.hidden = true; return; }
    buildLauncher();
    if (!launcher) return;
    launcher.hidden = false;
    var text = launcher.querySelector(".wdc-launcher__text");
    if (s.member && s.member.balance > 0) { text.textContent = s.member.worthLabel; launcher.setAttribute("aria-label", "Rewards: " + s.member.worthLabel + " to spend"); }
    else { text.textContent = cfg.launcherLabel || "Rewards"; launcher.removeAttribute("aria-label"); }
  }

  /* ---------- Club page section ---------- */
  function renderClubPage(root) {
    var s = state;
    root.replaceChildren();
    var m = s.member;
    var hero = h("div", { class: "wdc-page__hero" },
      h("div", null,
        h("h1", { class: "wdc-page__headline", text: root.dataset.headline || s.program.name }),
        h("p", { class: "wdc-page__lede", text: root.dataset.lede || ("Every ₹1 you spend earns " + (s.program.pointsPerCurrency === 1 ? "a point" : s.program.pointsPerCurrency + " points") + ". 100 points take " + worth(100) + " off your next order. The more you wear, the higher your tier and the faster you earn.") }),
        m ? h("div", { class: "wdc-page__actions" },
          h("button", { type: "button", class: "wdc-btn", onclick: function () { open("rewards"); }, text: "Use my points" }),
          h("button", { type: "button", class: "wdc-btn wdc-btn--ghost", onclick: function () { open("earn"); }, text: "Earn more" }))
          : h("div", { class: "wdc-page__actions" }, h("a", { class: "wdc-btn", href: cfg.registerUrl, text: "Join the club" }), h("a", { class: "wdc-btn wdc-btn--ghost", href: cfg.loginUrl, text: "Sign in" }))),
      h("div", null, wovenLabel(s, { className: "wdc-page__label" }), tierProgress(s)));
    append(root, hero);

    var earnCol = h("section", { "aria-labelledby": "wdc-earn-h" }, h("h2", { id: "wdc-earn-h", text: "Earn" }), h("p", { class: "wdc-page__sub", text: "Shopping is the big one. These add up too." }), earnList(s));
    var rewards = h("div", { class: "wdc-rewards-grid" });
    s.rewards.forEach(function (r) {
      rewards.appendChild(h("div", { class: "wdc-tag" + (r.canRedeem ? "" : " wdc-tag--locked") },
        h("span", { class: "wdc-tag__value", text: r.title }),
        h("span", { class: "wdc-tag__meta", text: pts(r.points) + " points" }),
        r.minSubtotal ? h("span", { class: "wdc-tag__meta", text: "Orders over " + money(r.minSubtotal) }) : null,
        m && !r.canRedeem ? h("span", { class: "wdc-tag__meta", text: pts(r.pointsNeeded) + " to go" }) : null));
    });
    var redeemCol = h("section", { "aria-labelledby": "wdc-redeem-h" },
      h("h2", { id: "wdc-redeem-h", text: "Spend" }),
      h("p", { class: "wdc-page__sub", text: "Swap points for money off. Or choose exactly how many to use in your cart." }),
      rewards,
      m ? h("div", { style: { marginTop: "16px" } }, h("button", { type: "button", class: "wdc-btn", onclick: function () { open("rewards"); }, text: "Get a code" })) : null);
    append(root, h("div", { class: "wdc-page__grid" }, earnCol, redeemCol));

    // Tiers: a real comparison table, because it's comparison data.
    var tiers = s.program.tiers;
    var perkRows = Math.max.apply(null, tiers.map(function (t) { return t.perks.length; }).concat([0]));
    var current = m && m.tier ? m.tier.id : null;
    var table = h("table", { class: "wdc-tiers" },
      h("thead", null, h("tr", null, h("td"), tiers.map(function (t) { return h("th", { scope: "col", class: t.id === current ? "is-current" : null }, t.name, t.id === current ? h("span", { class: "wdc-sr", text: " (your tier)" }) : null); }))),
      h("tbody", null,
        h("tr", null, h("th", { scope: "row", text: "Lifetime points" }), tiers.map(function (t) { return h("td", { class: t.id === current ? "is-current" : null, text: t.threshold ? pts(t.threshold) + "+" : "Start here" }); })),
        h("tr", null, h("th", { scope: "row", text: "Points per ₹1" }), tiers.map(function (t) { return h("td", { class: t.id === current ? "is-current" : null, text: t.multiplier + "x" }); })),
        Array.from({ length: perkRows }, function (_, i) {
          return h("tr", null, h("th", { scope: "row", text: i === 0 ? "Perks" : "" }), tiers.map(function (t) { return h("td", { class: t.id === current ? "is-current" : null, text: t.perks[i] || "" }); }));
        })));
    append(root, h("section", { style: { marginTop: "56px" }, "aria-labelledby": "wdc-tiers-h" },
      h("h2", { id: "wdc-tiers-h", text: "Tiers" }),
      h("p", { class: "wdc-page__sub", text: "Based on every point you've ever earned, so spending points never drops your tier." }),
      h("div", { class: "wdc-tiers-wrap" }, table)));

    if (m && s.history && s.history.length) {
      append(root, h("section", { style: { marginTop: "56px" } }, h("h2", { text: "Your activity" }), activityList(s)));
    }
    var faq = (s.program.widget && s.program.widget.faq) || [];
    if (faq.length) {
      append(root, h("section", { class: "wdc-faq", style: { marginTop: "56px" }, "aria-labelledby": "wdc-faq-h" },
        h("h2", { id: "wdc-faq-h", text: "Questions" }),
        faq.map(function (f) { return h("details", null, h("summary", { text: f.q }), h("p", { text: f.a })); })));
    }
  }

  /* ---------- Cart block ---------- */
  function cartSubtotal() {
    return fetch("/cart.js", { credentials: "same-origin" }).then(function (r) { return r.json(); }).then(function (c) {
      lastCartSubtotal = (c.items_subtotal_price || c.total_price || 0) / 100;
      return lastCartSubtotal;
    });
  }

  function renderCart(root) {
    var s = state;
    root.replaceChildren();
    var box = h("div", { class: "wdc-cart" });
    var rate = s.program.pointsPerCurrency * ((s.member && s.member.tier && s.member.tier.multiplier) || 1);
    var earnNote = lastCartSubtotal ? "This order earns about " + pts(Math.floor(lastCartSubtotal * rate)) + " points once delivered." : null;
    if (!s.member) {
      append(box, [h("div", { class: "wdc-cart__title", text: "Pay with points" }),
        h("p", { class: "wdc-note", style: { margin: "6px 0 12px" } }, "Members save on every order. ", earnNote),
        h("a", { class: "wdc-btn wdc-btn--small", href: cfg.loginUrl, text: "Sign in to use points" })]);
      root.appendChild(box); return;
    }
    var m = s.member;
    var slider = s.program.slider;
    append(box, h("div", { class: "wdc-cart__head" }, h("span", { class: "wdc-cart__title", text: "Pay with points" }), h("span", { class: "wdc-row__meta", text: pts(m.balance) + " points (" + m.worthLabel + ")" })));
    if (!slider || !m.slider) { append(box, h("p", { class: "wdc-note", text: earnNote })); root.appendChild(box); return; }
    var max = m.slider.max;
    if (max < slider.min) {
      var short = slider.min - m.balance;
      append(box, h("p", { class: "wdc-note", style: { marginTop: "8px" }, text: short > 0
        ? "You need " + pts(short) + " more points to start using them."
        : "Points can cover up to " + s.program.maxRedeemPercent + "% of an order. Add a little more to use them." }));
      if (earnNote) append(box, h("p", { class: "wdc-note", text: earnNote }));
      root.appendChild(box); return;
    }
    var id = "wdc-range-" + Math.random().toString(36).slice(2, 6);
    var value = h("div", { class: "wdc-cart__value", "aria-live": "polite" });
    var range = h("input", { type: "range", class: "wdc-range", id: id, min: String(slider.min), max: String(max), step: String(slider.step), value: String(max) });
    var btn = h("button", { type: "button", class: "wdc-btn wdc-btn--accent wdc-btn--block" });
    function sync() { var p = Number(range.value); value.textContent = worth(p) + " off"; btn.textContent = "Use " + pts(p) + " points"; range.setAttribute("aria-valuetext", pts(p) + " points, " + worth(p) + " off"); }
    range.addEventListener("input", sync); sync();
    var err = h("div");
    btn.addEventListener("click", function () {
      btn.disabled = true; btn.textContent = "Applying";
      act("redeem", { points: Number(range.value) }).then(function (res) { window.location.href = res.applyUrl; }, function (e) { btn.disabled = false; sync(); err.replaceChildren(alertBox("error", e.message)); });
    });
    append(box, [value, h("label", { for: id, class: "wdc-sr", text: "Points to use" }), range,
      h("div", { class: "wdc-row__meta", style: { display: "flex", justifyContent: "space-between", marginBottom: "12px" } }, h("span", { text: pts(slider.min) }), h("span", { text: pts(max) + " max" })),
      btn, err, earnNote ? h("p", { class: "wdc-note", text: earnNote }) : null]);
    root.appendChild(box);
  }

  /* ---------- Account card (themes with classic accounts) ---------- */
  function renderAccount(root) {
    root.replaceChildren(wovenLabel(state), tierProgress(state) || "",
      h("div", { class: "wdc-page__actions", style: { marginTop: "14px" } },
        h("button", { type: "button", class: "wdc-btn", onclick: function () { open("rewards"); }, text: "Use my points" }),
        h("a", { class: "wdc-btn wdc-btn--ghost", href: (state.program.widget && state.program.widget.clubPageUrl) || cfg.clubPageUrl, text: "How it works" })));
  }

  /* ---------- mount ---------- */
  function mountAll() {
    var pages = document.querySelectorAll("[data-wdc-page]");
    var carts = document.querySelectorAll("[data-wdc-cart]");
    var accounts = document.querySelectorAll("[data-wdc-account]");
    function safe(fn, root) {
      try { fn(root); } catch (err) { console.error("[Wearduds Club]", err); if (root) root.replaceChildren(alertBox("error", "Rewards couldn't load. Refresh to try again.")); }
    }
    onState(function () {
      pages.forEach(function (r) { safe(renderClubPage, r); });
      carts.forEach(function (r) { safe(renderCart, r); });
      accounts.forEach(function (r) { safe(renderAccount, r); });
      safe(function () { updateLauncher(state); });
      if (panel && !panel.hidden) safe(renderPanel);
    });
    var start = carts.length ? cartSubtotal().catch(function () {}) : Promise.resolve();
    start.then(function () { return load(); }).catch(function (err) {
      [].concat(Array.from(pages), Array.from(carts), Array.from(accounts)).forEach(function (root) { root.replaceChildren(alertBox("error", err.message)); });
    });
    // Theme cart drawers and pages announce updates in different ways; listen for the common ones.
    ["cart:updated", "cart:change", "cart:refresh", "theme:cart:change"].forEach(function (ev) {
      document.addEventListener(ev, function () { if (carts.length) cartSubtotal().then(function () { load(true); }); });
    });
    // Any link to #club or element with data-wdc-open opens the panel (e.g. a bottom-nav item).
    document.addEventListener("click", function (e) {
      var t = e.target.closest && e.target.closest('[data-wdc-open], a[href="#club"], a[href$="#club"]');
      if (t) { e.preventDefault(); open(t.getAttribute("data-wdc-open") || undefined); }
    });
    if (location.hash === "#club") open();
  }

  captureReferral();
  window.WeardudsClub = { open: open, close: close, refresh: function () { return load(true); }, onChange: onState, get state() { return state; } };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountAll);
  else mountAll();
})();
