// dashboard.ts — GET /dashboard: one self-contained page over the per-key usage ledger.
//
// Owner's ask (fire17, 2026-10-01 02:07, WhatsApp voice): "I want to see the overall, but also
// understand from it — like a pie chart — how it was used in terms of tokens".
//
// The page is STATIC: no data, no key, no external request (no CDN, no font, no image) — so the
// route is public, like /health's liveness answer. It asks for a key once (input box, kept in
// localStorage; `#key=` in the URL fragment is accepted too, since a fragment never reaches a
// server log, and is wiped from the address bar as soon as it is read), then calls
// /v1/usage/keys?group=model,day and /v1/usage with it. The same visibility rule applies as for
// any caller: a store key sees only its own usage; the legacy key or local keyless sees all.
// Charts are inline SVG drawn by vanilla JS; every label from the ledger is set via textContent.
// Palette: the dataviz reference categorical steps for a dark surface, fixed order, entity-keyed.

export const DASHBOARD_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

export const DASHBOARD_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="referrer" content="no-referrer">
<title>APIPlan usage</title>
<style>
:root {
  color-scheme: dark;
  --bg: #111110; --surface: #1a1a19; --surface-2: #232321; --line: #2e2e2b;
  --text: #ffffff; --text-2: #c3c2b7; --muted: #8b8a82;
  --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; --s5: #d55181; --s6: #008300; --s7: #9085e9; --other: #6b6a64;
  --warn: #c98500; --crit: #e66767; --ok: #199e70;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text); }
body { font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; padding: 16px; padding-bottom: 40px; max-width: 1180px; margin: 0 auto; }
h1 { font-size: 18px; margin: 0; font-weight: 650; letter-spacing: .01em; }
h2 { font-size: 13px; margin: 0 0 12px; font-weight: 600; color: var(--text-2); text-transform: uppercase; letter-spacing: .06em; }
.top { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.meta { color: var(--muted); font-size: 12px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.seg { display: inline-flex; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.seg button { background: none; border: 0; color: var(--text-2); padding: 7px 12px; font: inherit; cursor: pointer; min-height: 34px; }
.seg button[aria-pressed="true"] { background: var(--surface-2); color: var(--text); font-weight: 600; }
button.link { background: none; border: 0; color: var(--text-2); font: inherit; font-size: 12px; text-decoration: underline; cursor: pointer; padding: 4px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 16px; min-width: 0; }
.grid { display: grid; gap: 12px; margin-bottom: 12px; }
.kpis { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
.kpi .v { font-size: 26px; font-weight: 650; font-variant-numeric: tabular-nums; margin-top: 2px; }
.kpi .l { color: var(--text-2); font-size: 12px; }
.kpi .s { color: var(--muted); font-size: 12px; margin-top: 2px; }
.pies { grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); }
.pie { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; justify-content: center; }
.pie svg { flex: 0 0 auto; width: 150px; height: 150px; }
.pie svg circle.sl { cursor: pointer; transition: stroke-width .12s; }
.pie svg circle.sl.hot { stroke-width: 24; }
.legend { list-style: none; margin: 0; padding: 0; flex: 1 1 200px; min-width: 0; font-size: 13px; }
.legend li { display: grid; grid-template-columns: 12px minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 3px 0; cursor: default; }
.legend li.hot .nm { color: var(--text); font-weight: 600; }
.sw { width: 12px; height: 12px; border-radius: 3px; }
.nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-2); }
.vl { font-variant-numeric: tabular-nums; color: var(--text); text-align: right; }
.vl small { color: var(--muted); margin-left: 6px; }
.note { color: var(--muted); font-size: 12px; margin-top: 8px; }
.acct { grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
.bar { margin: 10px 0 2px; }
.bar .row { display: flex; justify-content: space-between; font-size: 12px; color: var(--text-2); }
.bar .row b { color: var(--text); font-variant-numeric: tabular-nums; }
.track { height: 8px; background: var(--surface-2); border-radius: 4px; overflow: hidden; margin-top: 4px; }
.fill { height: 100%; border-radius: 4px; background: var(--s1); }
.fill.warn { background: var(--warn); } .fill.crit { background: var(--crit); }
.strip { position: relative; }
.strip svg { width: 100%; height: 130px; display: block; }
.strip .ax { display: flex; justify-content: space-between; color: var(--muted); font-size: 11px; margin-top: 4px; }
.tip { position: absolute; pointer-events: none; background: #000; border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; font-size: 12px; white-space: nowrap; z-index: 5; display: none; }
.tip b { display: block; margin-bottom: 2px; }
.keys { list-style: none; padding: 0; margin: 8px 0 0; display: flex; gap: 12px; flex-wrap: wrap; font-size: 12px; color: var(--text-2); }
.keys li { display: flex; align-items: center; gap: 6px; }
.tbl { overflow-x: auto; -webkit-overflow-scrolling: touch; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; font-size: 13px; }
th, td { text-align: right; padding: 8px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
th:first-child, td:first-child { text-align: left; }
th { color: var(--muted); font-weight: 500; font-size: 12px; }
td .id { color: var(--muted); font-size: 11px; display: block; }
tr:last-child td { border-bottom: 0; }
.err { background: #2a1616; border: 1px solid #5a2a2a; color: #ffd9d9; border-radius: 10px; padding: 10px 12px; margin-bottom: 12px; display: none; }
.gate { max-width: 460px; margin: 10vh auto; }
.gate p { color: var(--text-2); margin: 0 0 12px; }
.gate input { width: 100%; background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 12px; font: 14px ui-monospace, Menlo, monospace; }
.gate button.go { margin-top: 10px; width: 100%; background: var(--s1); color: #fff; border: 0; border-radius: 8px; padding: 12px; font: inherit; font-weight: 600; cursor: pointer; }
.empty { color: var(--muted); font-size: 13px; padding: 24px 0; text-align: center; }
[hidden] { display: none !important; }
</style>
</head>
<body>
<div id="gate" class="gate card" hidden>
  <h1>APIPlan usage</h1>
  <p id="gateMsg">Paste an APIPlan serve key. It stays in this browser (localStorage) and is sent only to this server.</p>
  <form id="gateForm" autocomplete="off">
    <input id="keyIn" type="password" placeholder="apk_…" spellcheck="false" autocapitalize="off" aria-label="API key">
    <button class="go" type="submit">Show usage</button>
  </form>
</div>

<main id="app" hidden>
  <div class="top">
    <div>
      <h1>APIPlan usage</h1>
      <div class="meta"><span id="scope"></span><span id="updated"></span><button class="link" id="forget" type="button">change key</button></div>
    </div>
    <div class="seg" id="range" role="group" aria-label="Time range">
      <button type="button" data-since="24h">24h</button><button type="button" data-since="7d">7d</button><button type="button" data-since="30d">30d</button><button type="button" data-since="all">All</button>
    </div>
  </div>
  <div class="err" id="err"></div>

  <section class="grid kpis" id="kpis"></section>
  <section class="grid acct" id="acct"></section>

  <section class="grid pies">
    <div class="card"><h2>Cost by key</h2><div class="pie" id="pieKey"></div></div>
    <div class="card"><h2>Tokens by type</h2><div class="pie" id="pieType"></div></div>
    <div class="card"><h2>Cost by model</h2><div class="pie" id="pieModel"></div></div>
  </section>

  <section class="card" style="margin-bottom:12px">
    <h2>Tokens per day</h2>
    <div class="strip" id="strip"></div>
  </section>

  <section class="card">
    <h2>Per key</h2>
    <div class="tbl" id="table"></div>
  </section>
</main>

<script>
"use strict";
(() => {
  const LS_KEY = "apiplan.dashboard.key", LS_SINCE = "apiplan.dashboard.since";
  const TYPES = [
    { k: "input_tokens", name: "Input", c: "var(--s1)" },
    { k: "output_tokens", name: "Output", c: "var(--s2)" },
    { k: "cache_read_tokens", name: "Cache read", c: "var(--s3)" },
    { k: "cache_write_tokens", name: "Cache write", c: "var(--s4)" },
  ];
  const HUES = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)", "var(--s6)", "var(--s7)"];
  const $ = (id) => document.getElementById(id);
  const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} }, del(k) { try { localStorage.removeItem(k); } catch {} } };

  // A key in the fragment (#key=…) never reaches a server log; take it, keep it, wipe the bar.
  let key = "";
  const frag = /(?:^|&)key=([^&]+)/.exec(location.hash.slice(1));
  if (frag) { key = decodeURIComponent(frag[1]).trim(); store.set(LS_KEY, key); history.replaceState(null, "", location.pathname + location.search); }
  else key = store.get(LS_KEY) || "";
  let since = store.get(LS_SINCE) || "7d";
  const tz = -new Date().getTimezoneOffset();

  // ── formatting ──
  const nf = new Intl.NumberFormat("en-US");
  const tok = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + "M" : n >= 1e4 ? (n / 1e3).toFixed(1) + "k" : nf.format(n);
  const usd = (n) => !n ? "$0" : n < 0.01 ? "$" + n.toPrecision(3) : n < 100 ? "$" + n.toFixed(n < 1 ? 4 : 2) : "$" + nf.format(Math.round(n));
  const pct = (a, b) => b ? (a / b * 100 < 1 && a > 0 ? "<1%" : Math.round(a / b * 100) + "%") : "0%";
  const mask = (k) => { const m = /^apk_([a-z0-9]{8})_/.exec(k); return m ? "key " + m[1] : k ? "owner key" : "no key (this machine)"; };
  const when = (iso) => { if (!iso) return "—"; const d = new Date(iso); return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); };
  const until = (iso) => { if (!iso) return ""; const s = (Date.parse(iso) - Date.now()) / 1000; if (!(s > 0)) return "resetting"; const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return "resets in " + (h >= 24 ? Math.floor(h / 24) + "d " + (h % 24) + "h" : h ? h + "h " + m + "m" : m + "m"); };

  // ── tiny DOM builders (text only via textContent — ledger labels are caller-chosen) ──
  const h = (tag, attrs, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) { if (k === "class") e.className = v; else if (k === "style") e.style.cssText = v; else e.setAttribute(k, v); } for (const c of kids.flat()) if (c != null) e.append(c instanceof Node ? c : String(c)); return e; };
  const SVG = "http://www.w3.org/2000/svg";
  const s = (tag, attrs) => { const e = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, String(v)); return e; };

  async function get(path) {
    const headers = key ? { authorization: "Bearer " + key } : {};
    const r = await fetch(path, { headers, cache: "no-store" });
    if (r.status === 401) { const e = new Error("unauthorized"); e.status = 401; throw e; }
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error((j && (j.error && (j.error.message || j.error))) || ("HTTP " + r.status));
    return j;
  }

  function showGate(msg) {
    $("app").hidden = true; $("gate").hidden = false;
    if (msg) $("gateMsg").textContent = msg;
    $("keyIn").value = ""; $("keyIn").focus();
  }
  $("gateForm").addEventListener("submit", (ev) => { ev.preventDefault(); key = $("keyIn").value.trim(); if (key) store.set(LS_KEY, key); else store.del(LS_KEY); refresh(); });
  $("forget").addEventListener("click", () => { key = ""; store.del(LS_KEY); showGate("Paste an APIPlan serve key. It stays in this browser (localStorage) and is sent only to this server."); });
  for (const b of $("range").querySelectorAll("button")) b.addEventListener("click", () => { since = b.dataset.since; store.set(LS_SINCE, since); refresh(); });

  // ── donut ──
  // slices: [{ name, value, color, sub }]; folds anything past 7 into "Other".
  function donut(el, slices, fmt, emptyText, note) {
    el.replaceChildren();
    let list = slices.filter((x) => x.value > 0).sort((a, b) => b.value - a.value);
    if (list.length > 7) { const rest = list.slice(6); list = list.slice(0, 6).concat([{ name: "Other (" + rest.length + ")", value: rest.reduce((a, x) => a + x.value, 0), color: "var(--other)" }]); }
    const total = list.reduce((a, x) => a + x.value, 0);
    if (!total) { el.append(h("div", { class: "empty" }, emptyText)); return; }
    const R = 56, C = 2 * Math.PI * R, GAP = list.length > 1 ? 2 : 0;
    const svg = s("svg", { viewBox: "0 0 150 150", role: "img", "aria-label": list.map((x) => x.name + " " + fmt(x.value)).join(", ") });
    svg.append(s("circle", { cx: 75, cy: 75, r: R, fill: "none", stroke: "var(--surface-2)", "stroke-width": 18 }));
    const cv = s("text", { x: 75, y: 74, "text-anchor": "middle", fill: "var(--text)", "font-size": 17, "font-weight": 650 });
    const cl = s("text", { x: 75, y: 93, "text-anchor": "middle", fill: "var(--muted)", "font-size": 11 });
    const center = (v, l) => { cv.textContent = v; cl.textContent = l; };
    center(fmt(total), "total");
    const ul = h("ul", { class: "legend" });
    let off = 0;
    const rows = [];
    list.forEach((x, i) => {
      const len = x.value / total * C;
      const c = s("circle", { class: "sl", cx: 75, cy: 75, r: R, fill: "none", stroke: x.color, "stroke-width": 18,
        "stroke-dasharray": Math.max(len - GAP, 0.5) + " " + (C - Math.max(len - GAP, 0.5)), "stroke-dashoffset": -off, transform: "rotate(-90 75 75)", "pointer-events": "stroke" });
      off += len;
      const t = s("title"); t.textContent = x.name + ": " + fmt(x.value) + " (" + pct(x.value, total) + ")"; c.append(t);
      const li = h("li", {}, h("span", { class: "sw", style: "background:" + x.color }), h("span", { class: "nm", title: x.name }, x.name),
        h("span", { class: "vl" }, fmt(x.value), h("small", {}, pct(x.value, total))));
      const on = () => { rows.forEach((r) => { r[0].classList.remove("hot"); r[1].classList.remove("hot"); }); c.classList.add("hot"); li.classList.add("hot"); center(fmt(x.value), x.name.length > 16 ? x.name.slice(0, 15) + "…" : x.name); };
      const offf = () => { c.classList.remove("hot"); li.classList.remove("hot"); center(fmt(total), "total"); };
      for (const n of [c, li]) { n.addEventListener("mouseenter", on); n.addEventListener("mouseleave", offf); n.addEventListener("click", on); }
      rows.push([c, li]);
      svg.append(c); ul.append(li);
    });
    svg.append(cv, cl);
    el.append(svg, ul);
    if (note) el.append(h("div", { class: "note", style: "flex-basis:100%" }, note));
  }

  // ── per-day stacked strip ──
  function strip(el, days) {
    el.replaceChildren();
    if (!days || !days.length) { el.append(h("div", { class: "empty" }, "No requests in this window.")); return; }
    const W = 600, H = 130, n = days.length, step = W / n, bw = Math.max(Math.min(step - 3, 36), 1.5);
    const max = Math.max(1, ...days.map((d) => d.total_tokens));
    const svg = s("svg", { viewBox: "0 0 " + W + " " + H, preserveAspectRatio: "none", role: "img", "aria-label": "Tokens per day" });
    svg.append(s("line", { x1: 0, x2: W, y1: H - 0.5, y2: H - 0.5, stroke: "var(--line)" }));
    const tip = h("div", { class: "tip" });
    days.forEach((d, i) => {
      const x = i * step + (step - bw) / 2;
      let y = H;
      const segs = TYPES.map((t) => ({ t, v: d[t.k] || 0 })).filter((q) => q.v > 0);
      segs.forEach((q, j) => {
        const hgt = q.v / max * (H - 6);
        const top = j === segs.length - 1;
        const gap = j > 0 && hgt > 3 ? 1 : 0;
        y -= hgt;
        svg.append(s("rect", { x, y, width: bw, height: Math.max(hgt - gap, 0.6), fill: q.t.c, rx: top ? Math.min(3, bw / 3) : 0 }));
      });
      const hit = s("rect", { x: i * step, y: 0, width: step, height: H, fill: "transparent" });
      const show = (ev) => {
        tip.replaceChildren(h("b", {}, d.day), tok(d.total_tokens) + " tokens · " + usd(d.cost_usd), h("br"), nf.format(d.requests) + " requests" + (d.errors ? " · " + d.errors + " errors" : ""),
          ...TYPES.filter((t) => d[t.k]).map((t) => [h("br"), h("span", { style: "color:" + t.c }, "■ "), t.name + " " + tok(d[t.k])]));
        tip.style.display = "block";
        const box = el.getBoundingClientRect();
        const px = ((i + 0.5) / n) * box.width;
        tip.style.left = Math.min(Math.max(px - tip.offsetWidth / 2, 0), box.width - tip.offsetWidth) + "px";
        tip.style.top = "-8px"; tip.style.transform = "translateY(-100%)";
      };
      hit.addEventListener("mouseenter", show); hit.addEventListener("click", show); hit.addEventListener("mouseleave", () => { tip.style.display = "none"; });
      svg.append(hit);
    });
    const lab = (d) => { const [y, m, dd] = d.split("-"); return new Date(+y, +m - 1, +dd).toLocaleDateString(undefined, { month: "short", day: "numeric" }); };
    el.append(svg, h("div", { class: "ax" }, h("span", {}, lab(days[0].day)), h("span", {}, "peak " + tok(max) + " tokens/day"), h("span", {}, lab(days[n - 1].day))), tip,
      h("ul", { class: "keys" }, TYPES.map((t) => h("li", {}, h("span", { class: "sw", style: "background:" + t.c }), t.name))));
  }

  function kpis(o, keysCount) {
    const el = $("kpis"); el.replaceChildren();
    const card = (l, v, sub) => h("div", { class: "card kpi" }, h("div", { class: "l" }, l), h("div", { class: "v" }, v), sub ? h("div", { class: "s" }, sub) : null);
    el.append(
      card("Requests", nf.format(o.requests), o.errors ? o.errors + " errors" : "no errors"),
      card("Tokens", tok(o.total_tokens), tok(o.input_tokens) + " in · " + tok(o.output_tokens) + " out"),
      card("Cost (API value)", usd(o.cost_usd), o.unpriced_requests ? o.unpriced_requests + " unpriced requests" : "at published list rates"),
      card("Keys", nf.format(keysCount), "with traffic in this window"),
    );
  }

  function account(u) {
    const el = $("acct"); el.replaceChildren();
    for (const [prov, v] of Object.entries(u || {})) {
      if (!v) continue;
      const bar = (label, w) => {
        if (!w) return h("div", { class: "bar" }, h("div", { class: "row" }, h("span", {}, label), h("b", {}, "—")));
        const p = Math.max(0, Math.min(100, Number(w.used_percent) || 0));
        return h("div", { class: "bar" }, h("div", { class: "row" }, h("span", {}, label + " · " + until(w.resets_at)), h("b", {}, Math.round(p) + "%" + (p >= 90 ? " critical" : p >= 75 ? " high" : ""))),
          h("div", { class: "track" }, h("div", { class: "fill" + (p >= 90 ? " crit" : p >= 75 ? " warn" : ""), style: "width:" + p + "%" })));
      };
      el.append(h("div", { class: "card" }, h("h2", {}, prov === "openai" ? "OpenAI / Codex" : prov === "anthropic" ? "Anthropic" : prov),
        v.error ? h("div", { class: "note" }, "unavailable: " + v.error) : [bar("5-hour", v.five_hour), bar("Weekly", v.seven_day)],
        h("div", { class: "note" }, [v.plan, v.source].filter(Boolean).join(" · "))));
    }
  }

  function table(rows) {
    const el = $("table"); el.replaceChildren();
    if (!rows.length) { el.append(h("div", { class: "empty" }, "No requests in this window.")); return; }
    const th = ["Key", "Reqs", "Err", "Input", "Output", "Cache R", "Cache W", "Tokens", "Cost", "Last used"];
    el.append(h("table", {}, h("thead", {}, h("tr", {}, th.map((t) => h("th", {}, t)))),
      h("tbody", {}, rows.map((r) => h("tr", {}, h("td", {}, h("span", {}, r.label), h("span", { class: "id" }, r.key_id)), h("td", {}, nf.format(r.requests)), h("td", {}, nf.format(r.errors)),
        h("td", {}, tok(r.input_tokens)), h("td", {}, tok(r.output_tokens)), h("td", {}, tok(r.cache_read_tokens)), h("td", {}, tok(r.cache_write_tokens)),
        h("td", {}, tok(r.total_tokens)), h("td", {}, usd(r.cost_usd)), h("td", {}, when(r.last_used)))))));
  }

  // Colour follows the entity (key id / model name, sorted), never its rank in this window.
  const colorer = (names) => { const m = new Map([...new Set(names)].sort().map((n, i) => [n, HUES[i % HUES.length]])); return (n) => m.get(n) || "var(--other)"; };

  function render(k) {
    const b = k.breakdown, o = b.overall;
    $("scope").textContent = (k.scope === "all" ? "all keys" : "this key only") + " · " + mask(key);
    for (const btn of $("range").querySelectorAll("button")) btn.setAttribute("aria-pressed", String(btn.dataset.since === since));
    const active = k.keys.filter((r) => r.requests > 0);
    kpis(o, active.length);
    const kc = colorer(k.keys.map((r) => r.key_id));
    const byCost = active.some((r) => r.cost_usd > 0);
    donut($("pieKey"), active.map((r) => ({ name: r.label, value: byCost ? r.cost_usd : r.total_tokens, color: kc(r.key_id) })), byCost ? usd : tok,
      "No requests in this window.", byCost ? null : "No priced usage yet — slices show tokens.");
    donut($("pieType"), TYPES.map((t) => ({ name: t.name, value: o[t.k], color: t.c })), tok, "No tokens in this window.");
    const models = b.by_model || [];
    const mc = colorer(models.map((m) => m.model));
    const mCost = models.some((m) => m.cost_usd > 0);
    donut($("pieModel"), models.map((m) => ({ name: m.model, value: mCost ? m.cost_usd : m.total_tokens, color: mc(m.model) })), mCost ? usd : tok,
      "No requests in this window.", mCost ? null : "No priced usage yet — slices show tokens.");
    strip($("strip"), b.by_day);
    table(active);
  }

  let busy = false;
  async function refresh() {
    if (busy) return; busy = true;
    const err = $("err");
    try {
      const k = await get("v1/usage/keys?since=" + encodeURIComponent(since) + "&group=model,day&tz=" + tz);
      $("gate").hidden = true; $("app").hidden = false; err.style.display = "none";
      render(k);
      $("updated").textContent = "updated " + new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) + " · every 60 s";
      // Subscription windows are slower (upstream, cached server-side); they fill in when ready.
      get("v1/usage").then(account, (e) => { $("acct").replaceChildren(h("div", { class: "card note" }, "Account windows unavailable: " + e.message)); });
    } catch (e) {
      if (e.status === 401) showGate(key ? "That key was refused (wrong or revoked). Paste another." : "This server needs a key. Paste an APIPlan serve key.");
      else { err.textContent = "Could not load usage: " + e.message; err.style.display = "block"; }
    } finally { busy = false; }
  }
  refresh();
  setInterval(() => { if (!document.hidden && !$("app").hidden) refresh(); }, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !$("app").hidden) refresh(); });
})();
</script>
</body>
</html>
`;
