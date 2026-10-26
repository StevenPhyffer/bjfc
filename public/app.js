// BJFC Command Centre — front end (no build step, plain ES modules)
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const zar = (n, dp = 0) => (n == null ? "—" : "R " + Number(n).toLocaleString("en-ZA", { minimumFractionDigits: dp, maximumFractionDigits: dp }).replace(/ /g, " "));
const zarShort = (n) => (n >= 1e6 ? `R ${(n / 1e6).toFixed(2)}m` : n >= 1e3 ? `R ${Math.round(n / 1e3)}k` : zar(n));
const fdate = (s) => (s ? new Date(s).toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" }) : "—");
const icon = (id, cls = "i") => `<svg class="${cls}"><use href="#i-${id}"/></svg>`;
const api = async (url, opts = {}) => {
  const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...opts, body: opts.body && JSON.stringify(opts.body) });
  if (res.status === 401 && url !== "/api/password") { location.href = "/login.html"; throw new Error("Signed out"); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || res.statusText);
  return j;
};
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};
function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show" + (err ? " err" : "");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.className = "toast"), 3200);
}

const TYPE_LABEL = { quote: "Quote", invoice: "Invoice", report: "Report", minutes: "Minutes", drawing: "Drawing", spreadsheet: "Sheet", policy: "Policy", other: "File" };
const statusBadge = (s) => {
  if (!s) return "";
  const l = s.toLowerCase();
  const cls = /overdue|declined|expired/.test(l) ? "critical" : /unpaid|awaiting|draft|preparation|submitted/.test(l) ? "warning" : /paid|accepted|connected/.test(l) ? "good" : "neutral";
  return `<span class="badge ${cls}">${esc(s)}</span>`;
};
const ftype = (d) => `<div class="ftype ${d.sourceType === "sharepoint" ? "sp" : d.type}">${esc(d.sourceType === "sharepoint" ? "SP" : (d.ext || "").replace(".", "").slice(0, 4) || "—")}</div>`;

// ---------------- Theme ----------------
function currentTheme() {
  const t = document.documentElement.dataset.theme;
  return t || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}
function setTheme(t) {
  if (t === "system") { delete document.documentElement.dataset.theme; store.set("bjfc-theme", null); }
  else { document.documentElement.dataset.theme = t; store.set("bjfc-theme", t); }
  $("#theme-btn use").setAttribute("href", currentTheme() === "dark" ? "#i-sun" : "#i-moon");
}
$("#theme-btn").onclick = () => setTheme(currentTheme() === "dark" ? "light" : "dark");
setTheme(store.get("bjfc-theme") || "system");
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => setTheme(store.get("bjfc-theme") || "system"));

// ---------------- Status / nav badges ----------------
let STATUS = {};
async function refreshStatus() {
  try {
    const [s, f, m] = await Promise.all([api("/api/status"), api("/api/financials"), api("/api/monitor")]);
    STATUS = s;
    $("#n-quotes").textContent = f.quotes.count;
    $("#n-invoices").textContent = f.invoices.count;
    $("#n-files").textContent = s.index.files;
    const crit = m.alerts.length;
    $("#n-alerts").textContent = crit || "";
    $("#n-alerts").className = "count" + (crit ? " alert" : "");
    $("#bn-alerts").hidden = !crit;
    $("#bn-alerts").textContent = crit;
    const pill = $("#ai-pill");
    pill.classList.toggle("offline", s.aiMode !== "claude");
    $("#ai-pill-t").textContent = s.aiMode === "claude" ? "AI agent online" : "Offline demo mode";
    $("#ai-pill-s").textContent = s.aiMode === "claude" ? "Ready" : "Add an API key in Settings";
  } catch {}
}

// ---------------- Router ----------------
const pages = {};
let cleanup = null;
function route() {
  const [p, qs] = (location.hash.slice(2) || "overview").split("?");
  const params = new URLSearchParams(qs || "");
  const name = pages[p] ? p : "overview";
  if (cleanup) { cleanup(); cleanup = null; }
  const navKey = name === "documents" ? (params.get("type") === "quote" ? "quotes" : params.get("type") === "invoice" ? "invoices" : "documents") : name;
  $$("#nav a, #bottom-nav a").forEach((a) => a.classList.toggle("active", a.dataset.page === navKey));
  $("#app").classList.remove("nav-open");
  $(".content").scrollTop = 0;
  cleanup = pages[name](params) || null;
}
window.addEventListener("hashchange", route);
$("#menu-btn").onclick = () => $("#app").classList.toggle("nav-open");
$("#nav-close").onclick = $("#nav-scrim").onclick = () => $("#app").classList.remove("nav-open");
$("#search-btn").onclick = () => { location.hash = "#/documents"; setTimeout(() => $("#q")?.focus(), 50); };
$("#global-search").onsubmit = (e) => {
  e.preventDefault();
  const q = $("input", e.target).value.trim();
  if (q) location.hash = `#/documents?q=${encodeURIComponent(q)}`;
};
const setTitle = (t, sub = "") => { $("#page-title").textContent = t; $("#page-sub").textContent = sub; document.title = `${t} · BJFC Command Centre`; };
const view = (html) => ($("#view").innerHTML = html);

// ---------------- Charts (single-series sparkline + 2-series line chart) ----------------
function sparkline(values, max = 100) {
  if (!values.length) return "";
  const w = 200, h = 36;
  const pts = values.map((v, i) => `${((i / Math.max(1, values.length - 1)) * w).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts.join(" ")}" fill="none" stroke="var(--series)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
}
function lineChart(history) {
  const W = 600, H = 150, pl = 30, pb = 18;
  const x = (i) => pl + (i / Math.max(1, history.length - 1)) * (W - pl - 4);
  const y = (v) => 4 + (1 - v / 100) * (H - pb - 4);
  const path = (k) => history.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join("");
  const grid = [0, 25, 50, 75, 100].map((v) => `<line x1="${pl}" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)"/><text x="${pl - 6}" y="${y(v) + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${v}%</text>`).join("");
  return `<div class="chart" data-chart>
    <div class="legend"><span><i style="background:var(--series)"></i>CPU</span><span><i style="background:var(--series-2)"></i>Memory</span><span class="muted" style="margin-left:auto">Last ${Math.round((history.length * 3) / 60)} min</span></div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="CPU and memory usage over time">
      ${grid}
      <path d="${path("mem")}" fill="none" stroke="var(--series-2)" stroke-width="2" vector-effect="non-scaling-stroke"/>
      <path d="${path("cpu")}" fill="none" stroke="var(--series)" stroke-width="2" vector-effect="non-scaling-stroke"/>
      <line class="xh" y1="4" y2="${H - pb}" stroke="var(--muted)" stroke-dasharray="3 3" style="display:none"/>
      <rect x="${pl}" y="0" width="${W - pl}" height="${H}" fill="transparent" class="hit"/>
    </svg><div class="tip"></div></div>`;
}
function bindChart(el, history) {
  const svg = $("svg", el), tip = $(".tip", el), xh = $(".xh", el), hit = $(".hit", el);
  hit.onmousemove = (e) => {
    const r = svg.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left - (30 / 600) * r.width) / (r.width * (566 / 600))));
    const i = Math.round(frac * (history.length - 1));
    const p = history[i];
    if (!p) return;
    const px = 30 + (i / Math.max(1, history.length - 1)) * 566;
    xh.setAttribute("x1", px); xh.setAttribute("x2", px); xh.style.display = "";
    tip.style.display = "block";
    tip.innerHTML = `<b>${new Date(p.t).toLocaleTimeString()}</b><br>CPU ${p.cpu}% · Memory ${p.mem}%`;
    const left = (px / 600) * r.width;
    tip.style.left = Math.min(left + 10, r.width - 150) + "px";
    tip.style.top = "24px";
  };
  hit.onmouseleave = () => { tip.style.display = "none"; xh.style.display = "none"; };
}

// ---------------- Document drawer ----------------
async function openDoc(id) {
  const dr = $("#drawer");
  dr.innerHTML = `<div class="dh"><h3>Loading…</h3></div>`;
  dr.classList.add("open"); $("#scrim").classList.add("open");
  try {
    const d = await api(`/api/documents/${id}`);
    const m = d.meta || {};
    const kv = [
      ["Type", TYPE_LABEL[d.type]], ["Number", m.number], ["Client", m.client], ["Project", m.project],
      ["Date", m.date], [d.type === "quote" ? "Valid until" : "Due date", m.dueDate], ["Total (incl. VAT)", m.total != null && zar(m.total, 2)],
      ["Balance due", m.balance != null && d.type === "invoice" && zar(m.balance, 2)], ["Prepared by", m.preparedBy],
      ["Location", `${d.sourceName} › ${d.folder}`], ["Modified", fdate(d.modified)], ["Size", `${(d.size / 1024).toFixed(1)} KB`],
    ].filter(([, v]) => v);
    dr.innerHTML = `
      <div class="dh">${ftype(d)}<div style="flex:1;min-width:0"><h3>${esc(d.name)}</h3><div class="small muted">${esc(d.relPath)}</div></div>
        ${statusBadge(m.status)}<button class="icon-btn" data-close aria-label="Close">${icon("x")}</button></div>
      <div class="db">
        <div class="kv">${kv.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("")}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn primary" data-ask>${icon("spark")} Ask AI about this</button>
          ${d.sourceType === "sharepoint" ? (d.webUrl ? `<a class="btn" target="_blank" rel="noopener" href="${esc(d.webUrl)}">${icon("ext")} Open in SharePoint</a>` : "") : `<a class="btn" target="_blank" href="/api/documents/${d.id}/raw">${icon("ext")} Open file</a>`}
        </div>
        ${d.textIndexed ? `<div class="doc-text">${esc(d.text)}</div>` : `<div class="callout">${icon("info")}<div>This is a binary file (PDF / CAD). The demo indexes its name and location; PDF and Word text extraction is on the roadmap.</div></div>`}
      </div>`;
    $("[data-close]", dr).onclick = closeDrawer;
    $("[data-ask]", dr).onclick = () => { closeDrawer(); askAssistant(`Summarise ${m.number || d.name} (doc id ${d.id}) and tell me anything I should act on.`); };
  } catch (e) {
    dr.innerHTML = `<div class="dh"><h3>Couldn't open document</h3><button class="icon-btn" data-close>${icon("x")}</button></div><div class="db">${esc(e.message)}</div>`;
    $("[data-close]", dr).onclick = closeDrawer;
  }
}
function closeDrawer() { $("#drawer").classList.remove("open"); $("#scrim").classList.remove("open"); }
$("#scrim").onclick = closeDrawer;
document.addEventListener("keydown", (e) => e.key === "Escape" && closeDrawer());
document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-doc]");
  if (a) { e.preventDefault(); openDoc(a.dataset.doc); }
});

// ---------------- Markdown (safe: escape first, then format) ----------------
function md(src) {
  const inline = (s) =>
    s.replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>")
      .replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, "$1<i>$2</i>")
      .replace(/\[([^\]]+)\]\(doc:([\w]+)\)/g, '<a class="doc" data-doc="$2" href="#">$1</a>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const lines = esc(src).split("\n");
  let out = "", i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) { let code = ""; i++; while (i < lines.length && !/^```/.test(lines[i])) code += lines[i++] + "\n"; i++; out += `<pre><code>${code}</code></pre>`; continue; }
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || "")) {
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const aligns = cells(lines[i + 1]).map((c) => (/-:$/.test(c) ? "r" : ""));
      let t = `<table><thead><tr>${cells(l).map((c, k) => `<th class="${aligns[k] || ""}">${inline(c)}</th>`).join("")}</tr></thead><tbody>`;
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { t += `<tr>${cells(lines[i]).map((c, k) => `<td class="${aligns[k] || ""}">${inline(c)}</td>`).join("")}</tr>`; i++; }
      out += t + "</tbody></table>"; continue;
    }
    let m;
    if ((m = l.match(/^(#{1,4})\s+(.*)/))) { out += `<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`; i++; continue; }
    if (/^\s*[-*]\s+/.test(l)) { out += "<ul>"; while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { let item = lines[i++].replace(/^\s*[-*]\s+/, ""); while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i])) item += "<br>" + lines[i++].trim().replace(/^&gt;\s?/, ""); out += `<li>${inline(item)}</li>`; } out += "</ul>"; continue; }
    if (/^\s*\d+[.)]\s+/.test(l)) { out += "<ol>"; while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) out += `<li>${inline(lines[i++].replace(/^\s*\d+[.)]\s+/, ""))}</li>`; out += "</ol>"; continue; }
    if (/^&gt;\s?/.test(l)) { out += `<blockquote>${inline(l.replace(/^&gt;\s?/, ""))}</blockquote>`; i++; continue; }
    if (/^\s*(---|\*\*\*)\s*$/.test(l)) { out += "<hr>"; i++; continue; }
    if (!l.trim()) { i++; continue; }
    let para = l; i++;
    while (i < lines.length && lines[i].trim() && !/^(#|\s*[-*]\s|\s*\d+[.)]\s|```|\s*\||&gt;)/.test(lines[i])) para += "<br>" + lines[i++];
    out += `<p>${inline(para)}</p>`;
  }
  return out;
}

// =====================================================================
// Pages
// =====================================================================
const SUGGESTIONS = [
  ["Which invoices are overdue?", "and who should I chase first"],
  ["Show all open quotes", "awaiting client response"],
  ["How is the business doing?", "cash flow, debtors & advice"],
  ["Is the server healthy?", "CPU, disks, backups"],
  ["Find the Sandhaven stormwater report", "search across PC & server"],
  ["What do we have for Thukela Agri?", "every file for one client"],
];
function askAssistant(q) {
  pendingQuestion = q;
  location.hash = "#/assistant";
}
let pendingQuestion = null;

pages.overview = () => {
  const hr = new Date().getHours();
  setTitle("Overview", new Date().toLocaleDateString("en-ZA", { weekday: "long", day: "numeric", month: "long", year: "numeric" }));
  view(`
    <div class="stack">
      <section class="card hero">
        <div><h2>Good ${hr < 12 ? "morning" : hr < 17 ? "afternoon" : "evening"}. What do you need to know today?</h2>
        <p>Your AI assistant can search every file on the office PC, the file server and SharePoint — and keep an eye on the systems.</p></div>
        <form class="ask" id="ask"><input placeholder="e.g. Pull up all invoices for Ridgeview Estates" aria-label="Ask the assistant"/><button class="btn primary">${icon("send")} Ask</button></form>
        <div class="suggest">${SUGGESTIONS.slice(0, 4).map(([q]) => `<button data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div>
      </section>
      <section class="grid g-4" id="kpis">${'<div class="card kpi"><div class="label">Loading…</div><div class="value">—</div></div>'.repeat(4)}</section>
      <section class="grid g-main">
        <div class="card"><div class="card-h"><h2>Needs attention</h2><span class="sub">Overdue invoices & system alerts</span><div class="right"><a class="btn sm" href="#/documents?type=invoice&status=overdue">All overdue</a></div></div><div class="card-b"><div class="list" id="attention"></div></div></div>
        <div class="card"><div class="card-h"><h2>Environment</h2><div class="right"><a class="btn sm" href="#/monitor">Monitor</a></div></div><div class="card-b" id="env"></div></div>
      </section>
      <section class="grid g-2">
        <div class="card"><div class="card-h"><h2>Open quotes</h2><span class="sub">Awaiting client response</span><div class="right"><a class="btn sm" href="#/documents?type=quote">All quotes</a></div></div><div class="card-b"><div class="list" id="openq"></div></div></div>
        <div class="card"><div class="card-h"><h2>Recently changed files</h2><div class="right"><a class="btn sm" href="#/documents">All files</a></div></div><div class="card-b"><div class="list" id="recent"></div></div></div>
      </section>
    </div>`);
  $("#ask").onsubmit = (e) => { e.preventDefault(); const q = $("input", e.target).value.trim(); if (q) askAssistant(q); };
  $$(".suggest button").forEach((b) => (b.onclick = () => askAssistant(b.dataset.q)));

  const docRow = (d, right) => `<div class="list-row" data-doc="${d.id}">${ftype(d)}<div class="grow"><div class="t">${esc(d.meta?.number ? `${d.meta.number} · ${d.meta.client || ""}` : d.name)}</div><div class="meta">${esc(d.meta?.project || `${d.sourceName} › ${d.folder}`)}</div></div>${right || ""}</div>`;
  const load = async () => {
    const [f, overdue, openq, recent, mon] = await Promise.all([
      api("/api/financials"), api("/api/documents?type=invoice&status=overdue&sort=overdue"), api("/api/documents?type=quote&status=open"), api("/api/documents?sort=date"), api("/api/monitor"),
    ]);
    $("#kpis").innerHTML = `
      <div class="card kpi clickable" data-go="#/documents?type=invoice&status=unpaid"><div class="label"><span class="ic">${icon("cash")}</span>Outstanding debtors</div><div class="value">${zarShort(f.invoices.outstanding)}</div><div class="foot"><b>${f.invoices.unpaid}</b> unpaid invoices</div></div>
      <div class="card kpi clickable" data-go="#/documents?type=invoice&status=overdue"><div class="label"><span class="ic" style="background:var(--critical-bg);color:var(--critical-ink)">${icon("clock")}</span>Overdue</div><div class="value">${zarShort(f.invoices.overdueValue)}</div><div class="foot"><b>${f.invoices.overdue}</b> invoices past due date</div></div>
      <div class="card kpi clickable" data-go="#/documents?type=quote&status=open"><div class="label"><span class="ic">${icon("quote")}</span>Open quotes</div><div class="value">${zarShort(f.quotes.openValue)}</div><div class="foot"><b>${f.quotes.open}</b> awaiting · win rate <b>${f.quotes.winRate != null ? Math.round(f.quotes.winRate * 100) + "%" : "—"}</b></div></div>
      <div class="card kpi clickable" data-go="#/documents"><div class="label"><span class="ic">${icon("folder")}</span>Files indexed</div><div class="value">${STATUS.index?.files ?? "—"}</div><div class="foot">Billed last 90 days <b>${zarShort(f.invoices.billedLast90Days)}</b></div></div>`;
    $$("[data-go]").forEach((el) => (el.onclick = () => (location.hash = el.dataset.go)));
    const alertRows = mon.alerts.slice(0, 3).map((a) => `<div class="list-row" onclick="location.hash='#/monitor'"><div class="ftype" style="background:var(--${a.level}-bg);color:var(--${a.level}-ink)">${icon("pulse")}</div><div class="grow"><div class="t">${esc(a.machine)}</div><div class="meta">${esc(a.message)}</div></div><span class="badge ${a.level}">${a.level === "warning" ? "Warning" : a.level === "critical" ? "Critical" : "Serious"}</span></div>`);
    const invRows = overdue.slice(0, 5).map((d) => docRow(d, `<div style="text-align:right"><div class="amt">${zar(d.meta.balance)}</div><div class="small" style="color:var(--critical-ink)">${d.meta.daysOverdue} days late</div></div>`));
    $("#attention").innerHTML = [...invRows, ...alertRows].join("") || `<div class="empty">All clear 🎉</div>`;
    $("#openq").innerHTML = openq.slice(0, 5).map((d) => docRow(d, `<div class="amt">${zar(d.meta.total)}</div>`)).join("") || `<div class="empty">No open quotes</div>`;
    $("#recent").innerHTML = recent.slice(0, 5).map((d) => docRow(d, `<span class="small muted">${fdate(d.modified)}</span>`)).join("");
    $("#env").innerHTML = mon.machines.map((m) => {
      const l = m.latest || {};
      const icn = m.kind === "local" ? "pc" : /nas/i.test(m.name) ? "nas" : "server";
      const bad = mon.alerts.filter((a) => a.machine === m.name);
      const worst = bad.find((a) => a.level === "critical") ? "critical" : bad.length ? "warning" : "good";
      return `<div class="list-row" onclick="location.hash='#/monitor'" style="align-items:center"><div class="ftype">${icon(icn)}</div>
        <div class="grow"><div style="display:flex;gap:8px;align-items:center"><div class="t">${esc(m.name)}</div></div><div class="meta">CPU ${(l.cpu ?? 0).toFixed(0)}% · Mem ${(l.memory?.percent ?? 0).toFixed(0)}%</div>${sparkline((m.history || []).map((p) => p.cpu))}</div>
        <span class="badge ${worst}">${worst === "good" ? "Healthy" : worst === "critical" ? "Critical" : `${bad.length} warning${bad.length > 1 ? "s" : ""}`}</span></div>`;
    }).join("");
  };
  load().catch((e) => toast(e.message, true));
};

// ---------------- Assistant ----------------
const chatState = { id: store.get("bjfc-conv") || crypto.randomUUID(), log: [] };
store.set("bjfc-conv", chatState.id);
const TOOL_LABEL = { search_documents: "Searching files", list_documents: "Listing documents", read_document: "Reading document", financial_summary: "Crunching the numbers", get_system_status: "Checking systems", search_sharepoint: "Searching SharePoint" };

pages.assistant = () => {
  setTitle("AI Assistant", STATUS.aiMode === "claude" ? "Ask about your files, finances and systems" : "Offline demo mode");
  view(`<div class="card chat">
    <div class="chat-head"><span class="chip accent">${icon("spark")} ${STATUS.aiMode === "claude" ? "AI Assistant" : "Offline demo"}</span>
      <span class="small muted" id="scope"></span><div style="margin-left:auto"><button class="btn sm" id="new-chat">${icon("plus")} New chat</button></div></div>
    <div class="chat-log" id="log"></div>
    <div class="composer"><form id="composer"><textarea rows="1" placeholder="${matchMedia("(max-width: 760px)").matches ? "Ask anything…" : "Ask about quotes, invoices, clients, projects, or your systems…"}" aria-label="Message"></textarea><button class="btn primary" id="send">${icon("send")}</button></form>
    <div class="note">The assistant only reads files from folders you've allowed under Data sources. It never edits or deletes anything.</div></div>
  </div>`);
  api("/api/sources").then((s) => { $("#scope") && ($("#scope").textContent = `Can see: ${s.filter((x) => x.enabled && x.agentAccess).map((x) => x.name.split(" – ")[0]).join(", ")}`); }).catch(() => {});
  const log = $("#log"), ta = $("#composer textarea");
  const renderAll = () => {
    if (!chatState.log.length) {
      log.innerHTML = `<div class="welcome"><h2>How can I help, boss?</h2><div class="muted">I can find any document, pull up quotes and invoices, give business advice and check on your IT systems.</div>
        <div class="prompts">${SUGGESTIONS.map(([q, s]) => `<button data-q="${esc(q)}"><b>${esc(q)}</b><span>${esc(s)}</span></button>`).join("")}</div></div>`;
      $$(".prompts button", log).forEach((b) => (b.onclick = () => send(b.dataset.q)));
      return;
    }
    log.innerHTML = chatState.log.map(renderMsg).join("");
    log.scrollTop = log.scrollHeight;
  };
  const renderMsg = (m) => m.role === "user"
    ? `<div class="msg user"><div class="av">You</div><div class="bubble">${esc(m.text)}</div></div>`
    : `<div class="msg ai"><div class="av">AI</div><div class="bubble">${m.steps.length ? `<div class="steps">${m.steps.map((s) => `<span class="step ${s.done ? (s.error ? "err" : "done") : ""}">${s.done ? "" : '<span class="spin"></span>'}${esc(s.label)}${s.count != null ? ` · ${s.count}` : ""}</span>`).join("")}</div>` : ""}
        <div class="md">${m.text ? md(m.text) : m.error ? "" : '<span class="typing"><i></i><i></i><i></i></span>'}${m.error ? `<p class="err">⚠ ${esc(m.error)}</p>` : ""}</div></div></div>`;

  let busy = false;
  async function send(text) {
    if (busy || !text.trim()) return;
    busy = true; $("#send").disabled = true;
    chatState.log.push({ role: "user", text });
    const ai = { role: "ai", text: "", steps: [] };
    chatState.log.push(ai);
    renderAll();
    const update = () => { const last = $$(".msg", log).pop(); if (last) last.outerHTML = renderMsg(ai); log.scrollTop = log.scrollHeight; };
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId: chatState.id, message: text }) });
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = "", raf = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n"); buf = parts.pop();
        for (const p of parts) {
          if (!p.startsWith("data: ")) continue;
          const ev = JSON.parse(p.slice(6));
          if (ev.type === "text") ai.text += ev.text;
          else if (ev.type === "tool") ai.steps.push({ id: ev.id, label: describeTool(ev.name, ev.input) });
          else if (ev.type === "tool_result") { const s = ai.steps.find((x) => x.id === ev.id); if (s) Object.assign(s, { done: true, count: ev.count, error: ev.error }); }
          else if (ev.type === "error") ai.error = ev.error;
        }
        cancelAnimationFrame(raf); raf = requestAnimationFrame(update);
      }
    } catch (e) { ai.error = e.message; }
    ai.text = ai.text.trim();
    if (!ai.text && !ai.error) ai.error = "No response.";
    busy = false; if ($("#send")) { $("#send").disabled = false; update(); }
  }
  const describeTool = (name, input = {}) => {
    const base = TOOL_LABEL[name] || name;
    const bits = [input.query && `“${input.query}”`, input.status, input.doc_type && input.doc_type + "s", input.client].filter(Boolean);
    return bits.length ? `${base}: ${bits.join(" ")}` : base;
  };
  $("#composer").onsubmit = (e) => { e.preventDefault(); const t = ta.value; ta.value = ""; ta.style.height = ""; send(t); };
  ta.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#composer").requestSubmit(); } };
  ta.oninput = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 160) + "px"; };
  $("#new-chat").onclick = async () => {
    await api("/api/chat/reset", { method: "POST", body: { conversationId: chatState.id } }).catch(() => {});
    chatState.id = crypto.randomUUID(); store.set("bjfc-conv", chatState.id); chatState.log = []; renderAll(); ta.focus();
  };
  renderAll();
  ta.focus();
  if (pendingQuestion) { const q = pendingQuestion; pendingQuestion = null; send(q); }
};

// ---------------- Documents (all / quotes / invoices) ----------------
pages.documents = (params) => {
  const type = params.get("type") || "";
  const state = { type, status: params.get("status") || "", q: params.get("q") || "", source: "" };
  const titles = { quote: "Quotes", invoice: "Invoices" };
  setTitle(titles[type] || "All files", type ? "" : "Office PC, file server & SharePoint");
  const statusTabs = type === "invoice" ? [["", "All"], ["unpaid", "Unpaid"], ["overdue", "Overdue"], ["paid", "Paid"]]
    : type === "quote" ? [["", "All"], ["open", "Awaiting"], ["accepted", "Accepted"], ["declined", "Declined"], ["expired", "Expired"]]
    : [["", "All"], ["t:report", "Reports"], ["t:minutes", "Minutes"], ["t:spreadsheet", "Sheets"], ["t:drawing", "Drawings"], ["t:quote", "Quotes"], ["t:invoice", "Invoices"]];
  view(`<div class="stack">
    ${type ? `<section class="grid g-4" id="doc-kpis"></section>` : ""}
    <div class="card">
      <div class="toolbar">
        <div class="tabs" id="tabs">${statusTabs.map(([v, l]) => `<button data-v="${v}" class="${(v.startsWith("t:") ? state.type === v.slice(2) && !type : state.status === v) || (!v && !state.status && (type || !state.type)) ? "on" : ""}">${l}</button>`).join("")}</div>
        <input class="input" id="q" placeholder="Filter by keyword, client, number…" value="${esc(state.q)}" style="max-width:300px;flex:1"/>
        <select class="input" id="src" style="max-width:220px"><option value="">All locations</option></select>
        <span class="small muted" id="cnt" style="margin-left:auto"></span>
        ${type ? `<button class="btn sm" id="ask-ai">${icon("spark")} Ask AI</button>` : ""}
      </div>
      <div class="table-wrap" id="tbl"><div class="empty">Loading…</div></div>
    </div></div>`);
  api("/api/sources").then((srcs) => {
    api("/api/sharepoint").then((sps) => {
      $("#src").innerHTML += [...srcs.map((s) => [s.id, s.name]), ...sps.map((s) => [s.id, "SharePoint – " + s.displayName])].map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("");
    });
  });
  if (type) {
    api("/api/financials").then((f) => {
      const k = type === "invoice"
        ? [["Total invoices", f.invoices.count, ""], ["Outstanding", zarShort(f.invoices.outstanding), `${f.invoices.unpaid} unpaid`], ["Overdue", zarShort(f.invoices.overdueValue), `${f.invoices.overdue} invoices`], ["Billed (90 days)", zarShort(f.invoices.billedLast90Days), "incl. VAT"]]
        : [["Total quotes", f.quotes.count, ""], ["Awaiting response", f.quotes.open, ""], ["Pipeline value", zarShort(f.quotes.openValue), "incl. VAT"], ["Win rate", f.quotes.winRate != null ? Math.round(f.quotes.winRate * 100) + "%" : "—", "accepted vs declined"]];
      $("#doc-kpis").innerHTML = k.map(([l, v, s]) => `<div class="card kpi"><div class="label">${l}</div><div class="value">${v}</div><div class="foot">${s}</div></div>`).join("");
    });
    $("#ask-ai").onclick = () => askAssistant(type === "invoice" ? "Review my unpaid invoices and tell me who to chase first." : "Review my open quotes — which should I follow up and why?");
  }
  const load = async () => {
    const qs = new URLSearchParams();
    if (state.type) qs.set("type", state.type);
    if (state.status) qs.set("status", state.status);
    if (state.q) qs.set("q", state.q);
    if (state.source) qs.set("source", state.source);
    if (state.status === "overdue") qs.set("sort", "overdue");
    const rows = await api("/api/documents?" + qs);
    $("#cnt").textContent = `${rows.length} file${rows.length === 1 ? "" : "s"}`;
    if (!rows.length) return ($("#tbl").innerHTML = `<div class="empty">Nothing found.</div>`);
    const t = state.type;
    const head = t === "invoice" ? "<th>Invoice</th><th>Client</th><th>Project</th><th>Date</th><th>Due</th><th>Status</th><th class='num'>Total</th><th class='num'>Balance</th>"
      : t === "quote" ? "<th>Quote</th><th>Client</th><th>Project</th><th>Date</th><th>Status</th><th class='num'>Total (incl. VAT)</th>"
      : "<th>Name</th><th>Type</th><th>Location</th><th>Modified</th>";
    // Cell classes (c-*) drive the stacked-card layout on phones.
    const row = (d) => {
      const m = d.meta || {};
      if (t === "invoice") return `<td class="name c-title">${esc(m.number || d.name)}</td><td class="c-sub">${esc(m.client)}</td><td class="small c-hide">${esc(m.project)}</td><td class="small c-meta" data-label="Issued">${fdate(m.date)}</td><td class="small c-hide">${fdate(m.dueDate)}</td><td class="c-status">${statusBadge(m.status)}${m.daysOverdue ? ` <span class="small" style="color:var(--critical-ink)">${m.daysOverdue}d</span>` : ""}</td><td class="num c-hide">${zar(m.total, 2)}</td><td class="num c-amount"><b>${zar(m.balance, 2)}</b></td>`;
      if (t === "quote") return `<td class="name c-title">${esc(m.number || d.name)}</td><td class="c-sub">${esc(m.client)}</td><td class="small c-meta">${esc(m.project)}</td><td class="small c-hide">${fdate(m.date)}</td><td class="c-status">${statusBadge(m.status)}</td><td class="num c-amount"><b>${zar(m.total, 2)}</b></td>`;
      return `<td class="c-title" style="grid-column:1/-1"><div style="display:flex;gap:10px;align-items:center">${ftype(d)}<div style="min-width:0"><div class="name" style="overflow-wrap:anywhere">${esc(d.name)}</div>${d.snippet ? `<div class="small muted" style="max-width:520px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.snippet)}</div>` : ""}</div></div></td><td class="c-hide"><span class="chip">${esc(TYPE_LABEL[d.type])}</span></td><td class="small c-meta indent">${esc(d.sourceName)}<div class="muted c-hide-m">${esc(d.folder)}</div></td><td class="small c-status">${fdate(d.modified)}</td>`;
    };
    $("#tbl").innerHTML = `<table class="t cards"><thead><tr>${head}</tr></thead><tbody>${rows.map((d) => `<tr class="click" data-doc="${d.id}">${row(d)}</tr>`).join("")}</tbody></table>`;
  };
  $$("#tabs button").forEach((b) => (b.onclick = () => {
    $$("#tabs button").forEach((x) => x.classList.toggle("on", x === b));
    const v = b.dataset.v;
    if (v.startsWith("t:")) { state.type = v.slice(2); state.status = ""; } else { state.status = v; if (!type) state.type = ""; }
    load();
  }));
  let deb;
  $("#q").oninput = (e) => { clearTimeout(deb); deb = setTimeout(() => { state.q = e.target.value.trim(); load(); }, 200); };
  $("#src").onchange = (e) => { state.source = e.target.value; load(); };
  load().catch((e) => toast(e.message, true));
};

// ---------------- Monitor ----------------
pages.monitor = () => {
  setTitle("System monitor", "Live — refreshes every 3 seconds");
  view(`<div class="stack"><div class="card"><div class="card-h"><h2>Active alerts</h2><div class="right"><button class="btn sm" id="ask-it">${icon("spark")} Ask AI for advice</button></div></div><div class="card-b" id="alerts"></div></div><div class="stack" id="machines"></div></div>`);
  $("#ask-it").onclick = () => askAssistant("Look at the system status and alerts. What's the biggest IT risk right now and what should I do about it?");
  const LEVEL = { good: "Healthy", warning: "Warning", serious: "Serious", critical: "Critical" };
  const pctCls = (p) => (p >= 90 ? "critical" : p >= 85 ? "warning" : "");
  const draw = async () => {
    const mon = await api("/api/monitor");
    $("#alerts").innerHTML = mon.alerts.length ? mon.alerts.map((a) => `<div class="alert-row"><span class="badge ${a.level}">${LEVEL[a.level]}</span><div><b>${esc(a.machine)}</b> — ${esc(a.message)}</div></div>`).join("") : `<div class="empty">No alerts — everything looks healthy.</div>`;
    const host = $("#machines");
    const first = !host.children.length;
    if (first) host.innerHTML = mon.machines.map((m) => `<div class="card machine" id="m-${m.id}"></div>`).join("");
    for (const m of mon.machines) {
      const l = m.latest || {};
      const el = $(`#m-${m.id}`);
      if (!el) continue;
      const icn = m.kind === "local" ? "pc" : /nas/i.test(m.name) ? "nas" : "server";
      el.innerHTML = `
        <div class="head"><div class="ic">${icon(icn)}</div><div style="flex:1;min-width:0"><h3>${esc(m.name)} ${m.kind === "simulated" ? '<span class="sim-tag" title="Simulated for the demo — connect a real monitoring agent in production">SIMULATED</span>' : ""}</h3>
          <div class="small muted">${esc(l.os || m.role || "")}${l.host ? " · " + esc(l.host) : ""}${l.uptimeHours ? ` · up ${l.uptimeHours > 48 ? Math.round(l.uptimeHours / 24) + " days" : Math.round(l.uptimeHours) + " h"}` : ""}</div></div>
          <span class="badge ${l.online ? "good" : "critical"}">${l.online ? "Online" : "Offline"}</span></div>
        <div class="body"><div>
          <div class="gauges">
            <div class="gauge"><div class="l">CPU</div><div class="v">${(l.cpu ?? 0).toFixed(0)}%</div><div class="s">${l.cores || "?"} cores · load ${(l.load?.[0] ?? 0).toFixed(2)}</div></div>
            <div class="gauge"><div class="l">Memory</div><div class="v">${(l.memory?.percent ?? 0).toFixed(0)}%</div><div class="s">${(l.memory?.usedGB ?? 0).toFixed(1)} / ${(l.memory?.totalGB ?? 0).toFixed(0)} GB</div></div>
            <div class="gauge"><div class="l">Busiest disk</div><div class="v">${Math.max(0, ...(l.disks || []).map((d) => d.percent))}%</div><div class="s">${(l.disks || []).length} volume(s)</div></div>
          </div>
          ${lineChart(m.history || [])}
        </div><div>
          <div class="small muted" style="font-weight:600;margin-bottom:8px">STORAGE</div>
          ${(l.disks || []).map((d) => `<div class="disk"><div class="row"><span>${esc(d.mount)}</span><span class="muted">${d.usedGB.toLocaleString()} / ${d.totalGB.toLocaleString()} GB · <b style="color:var(--text)">${d.percent}%</b></span></div><div class="bar ${pctCls(d.percent)}"><i style="width:${d.percent}%"></i></div></div>`).join("") || '<div class="muted small">No disks reported</div>'}
          ${l.services ? `<div class="small muted" style="font-weight:600;margin:14px 0 4px">SERVICES</div>${l.services.map((s) => `<div class="svc"><span class="badge ${s.status}">${LEVEL[s.status]}</span><div class="grow"><div>${esc(s.name)}</div><div class="d">${esc(s.detail)}</div></div></div>`).join("")}` : ""}
          ${l.processes ? `<div class="small muted" style="font-weight:600;margin:14px 0 4px">TOP PROCESSES</div><table class="t"><tbody>${l.processes.map((p) => `<tr><td class="small">${esc(p.name)}</td><td class="num small">${p.cpu.toFixed(1)}% CPU</td><td class="num small muted">${p.mem.toFixed(1)}% mem</td></tr>`).join("")}</tbody></table>` : ""}
        </div></div>`;
      bindChart($("[data-chart]", el), m.history || []);
    }
  };
  draw().catch((e) => toast(e.message, true));
  const t = setInterval(() => draw().catch(() => {}), 3000);
  return () => clearInterval(t);
};

// ---------------- Data sources ----------------
pages.sources = () => {
  setTitle("Data sources", "What the AI agent can see");
  view(`<div class="stack">
    <div class="card"><div class="card-h"><h2>Computer & server folders</h2><span class="sub">Files are read in place — nothing is uploaded or moved</span><div class="right"><button class="btn sm" id="rescan">${icon("refresh")} Rescan now</button></div></div>
      <div class="card-b"><div id="src-list"></div>
      <form id="add-src" class="form-grid" style="margin-top:14px;padding-top:16px;border-top:1px solid var(--border)">
        <div class="field"><label>Folder path</label><input class="input" name="path" list="vols" placeholder="/Volumes/Projects or ~/Documents" required/><datalist id="vols"></datalist><span class="hint">For a server share: connect it in Finder (Go › Connect to Server, e.g. smb://BJFC-SRV01/Projects), then pick it from /Volumes.</span></div>
        <div class="field"><label>Display name</label><input class="input" name="name" placeholder="e.g. Server – Projects share"/></div>
        <div class="field"><label>Type</label><select class="input" name="type"><option value="local">This computer</option><option value="server">Network server / NAS</option></select></div>
        <div class="field" style="align-content:end"><button class="btn primary">${icon("plus")} Add folder</button></div>
      </form></div></div>

    <div class="card"><div class="card-h"><div class="ftype sp-logo" style="width:34px;height:34px">S</div><div><h2>SharePoint</h2><div class="sub">Connect Microsoft 365 sites so the agent can search them alongside local files</div></div></div>
      <div class="card-b"><div id="sp-list"></div>
      <form id="add-sp" class="form-grid" style="margin-top:14px;padding-top:16px;border-top:1px solid var(--border)">
        <div class="field full"><label>SharePoint site URL</label><input class="input" name="siteUrl" placeholder="https://bjfc.sharepoint.com/sites/Projects" required/></div>
        <div class="field"><label>Display name</label><input class="input" name="displayName" placeholder="e.g. Projects intranet"/></div>
        <div class="field"><label>Directory (tenant) ID</label><input class="input sp-cred" name="tenantId" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"/></div>
        <div class="field"><label>Application (client) ID</label><input class="input sp-cred" name="clientId" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"/></div>
        <div class="field"><label>Client secret</label><input class="input sp-cred" name="clientSecret" type="password" autocomplete="off" placeholder="Stored locally on this computer only"/></div>
        <label class="check full"><input type="checkbox" name="agentAccess" checked/><span><b>Allow the AI agent to search this site</b><br><span class="small muted">You can switch this off at any time.</span></span></label>
        <label class="check full"><input type="checkbox" name="demo" id="sp-demo"/><span><b>Demo mode</b> — simulate a connection with sample libraries (no Microsoft 365 credentials needed)</span></label>
        <div class="full" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><button class="btn primary" id="sp-btn">${icon("plus")} Connect site</button><span class="small muted" id="sp-msg"></span></div>
        <details class="full"><summary class="small" style="cursor:pointer;font-weight:600">How to get these details (5 minutes, done once by your IT admin)</summary>
          <ol class="steps-list" style="margin-top:8px">
            <li>Go to <b>entra.microsoft.com</b> › App registrations › <b>New registration</b> (name it "BJFC Command Centre").</li>
            <li>Copy the <b>Application (client) ID</b> and <b>Directory (tenant) ID</b> from the Overview page.</li>
            <li>Certificates & secrets › <b>New client secret</b> — copy the value.</li>
            <li>API permissions › Add › Microsoft Graph › Application permissions › <b>Sites.Read.All</b> (or Sites.Selected to restrict to specific sites) › <b>Grant admin consent</b>.</li>
            <li>Paste the three values above and press <b>Connect site</b>. Access is read-only.</li>
          </ol></details>
      </form></div></div></div>`);

  const srcIcon = (t) => icon(t === "server" ? "server" : "pc");
  const renderSources = (list) => {
    $("#src-list").innerHTML = list.map((s) => `<div class="src" data-id="${s.id}"><div class="ic">${srcIcon(s.type)}</div>
      <div class="grow"><b>${esc(s.name)}</b> ${s.exists ? `<span class="chip">${s.files} files</span>` : '<span class="badge critical">Folder not found</span>'}<div class="small muted mono">${esc(s.path)}</div></div>
      <div class="toggles"><label><span class="switch"><input type="checkbox" data-k="enabled" ${s.enabled ? "checked" : ""}/><span></span></span>Indexed</label>
      <label><span class="switch"><input type="checkbox" data-k="agentAccess" ${s.agentAccess ? "checked" : ""}/><span></span></span>AI access</label>
      <button class="btn sm ghost danger" data-del>${icon("trash")}</button></div></div>`).join("") || `<div class="empty">No folders yet.</div>`;
    $$("#src-list .src").forEach((row) => {
      $$("input[data-k]", row).forEach((inp) => (inp.onchange = async () => { renderSources(await api(`/api/sources/${row.dataset.id}`, { method: "PATCH", body: { [inp.dataset.k]: inp.checked } })); refreshStatus(); }));
      $("[data-del]", row).onclick = async () => { renderSources(await api(`/api/sources/${row.dataset.id}`, { method: "DELETE" })); toast("Folder removed"); refreshStatus(); };
    });
  };
  const renderSp = (list) => {
    $("#sp-list").innerHTML = list.map((s) => `<div class="src" data-id="${s.id}"><div class="ic sp-logo">S</div>
      <div class="grow"><b>${esc(s.displayName)}</b> ${statusBadge(s.status === "connected" ? "Connected" : s.status)} ${s.demo ? '<span class="sim-tag">DEMO</span>' : ""}
        <div class="small muted">${esc(s.siteUrl)}</div>
        <div class="small muted">${(s.availableLibraries || []).map((l) => esc(l.name)).join(" · ")}${s.lastSync ? ` — ${s.syncedFiles} files synced ${new Date(s.lastSync).toLocaleTimeString()}` : ""}</div></div>
      <div class="toggles"><label><span class="switch"><input type="checkbox" data-k="agentAccess" ${s.agentAccess ? "checked" : ""}/><span></span></span>AI access</label>
      <button class="btn sm" data-sync>${icon("refresh")} Sync</button><button class="btn sm ghost danger" data-del>${icon("trash")}</button></div></div>`).join("")
      || `<div class="callout">${icon("info")}<div>No SharePoint sites connected yet. Add one below — or tick <b>Demo mode</b> to show how it works.</div></div>`;
    $$("#sp-list .src").forEach((row) => {
      const id = row.dataset.id;
      $("input[data-k]", row).onchange = async (e) => renderSp(await api(`/api/sharepoint/${id}`, { method: "PATCH", body: { agentAccess: e.target.checked } }));
      $("[data-sync]", row).onclick = async () => { try { renderSp(await api(`/api/sharepoint/${id}/sync`, { method: "POST" })); toast("SharePoint synced"); refreshStatus(); } catch (e) { toast(e.message, true); } };
      $("[data-del]", row).onclick = async () => { renderSp(await api(`/api/sharepoint/${id}`, { method: "DELETE" })); toast("Site disconnected"); refreshStatus(); };
    });
  };
  api("/api/sources").then(renderSources);
  api("/api/sharepoint").then(renderSp);
  api("/api/volumes").then((v) => ($("#vols").innerHTML = v.map((p) => `<option value="${esc(p)}">`).join("")));
  $("#sp-demo").onchange = (e) => $$(".sp-cred").forEach((i) => (i.disabled = e.target.checked));
  $("#rescan").onclick = async () => { const r = await api("/api/rescan", { method: "POST" }); toast(`Indexed ${r.files} files in ${r.ms} ms`); api("/api/sources").then(renderSources); refreshStatus(); };
  $("#add-src").onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try { renderSources(await api("/api/sources", { method: "POST", body: f })); e.target.reset(); toast("Folder added and indexed"); refreshStatus(); } catch (err) { toast(err.message, true); }
  };
  $("#add-sp").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd);
    body.agentAccess = fd.has("agentAccess"); body.demo = fd.has("demo");
    $("#sp-btn").disabled = true; $("#sp-msg").textContent = "Connecting to Microsoft 365…";
    try {
      await api("/api/sharepoint", { method: "POST", body });
      renderSp(await api("/api/sharepoint"));
      e.target.reset(); $$(".sp-cred").forEach((i) => (i.disabled = false));
      $("#sp-msg").textContent = ""; toast("SharePoint site connected"); refreshStatus();
    } catch (err) { $("#sp-msg").textContent = err.message; }
    $("#sp-btn").disabled = false;
  };
};

// ---------------- Settings ----------------
pages.settings = () => {
  setTitle("Settings");
  view(`<div class="grid g-2" style="align-items:start">
    <div class="card"><div class="card-h"><h2>AI engine</h2></div><div class="card-b"><form id="ai-form" class="stack" style="gap:14px">
      <div class="field"><label>Anthropic API key</label><div style="display:flex;gap:8px"><input class="input" name="apiKey" type="password" autocomplete="off" placeholder="sk-ant-…"/><button class="btn" type="button" id="rm-key">Remove</button></div><span class="hint" id="key-hint"></span></div>
      <div class="field"><label>Model</label><select class="input" name="model">
        <option value="claude-opus-5-5">Claude Opus 5.5 — best quality (recommended)</option>
        <option value="claude-sonnet-5-5">Claude Sonnet 5.5 — faster, lower cost</option>
        <option value="claude-haiku-4-5">Claude Haiku 4.5 — fastest, cheapest</option></select></div>
      <div class="field"><label>Thinking effort</label><select class="input" name="effort"><option value="low">Low — quick answers</option><option value="medium">Medium — balanced</option><option value="high">High — deeper analysis</option></select></div>
      <div class="field"><label>Mode</label><select class="input" name="aiMode"><option value="claude">Live AI (uses the API key)</option><option value="offline">Offline demo (no internet needed)</option></select></div>
      <div><button class="btn primary">Save</button></div></form></div></div>
    <div class="stack">
      <div class="card"><div class="card-h"><h2>Account</h2><span class="sub" id="me"></span></div><div class="card-b"><form id="pw-form" class="stack" style="gap:12px">
        <div class="field"><label>Current password</label><input class="input" name="current" type="password" autocomplete="current-password" required/></div>
        <div class="field"><label>New password</label><input class="input" name="password" type="password" autocomplete="new-password" minlength="10" required/><span class="hint">At least 10 characters. Changing it signs out your other devices.</span></div>
        <div><button class="btn primary">Change password</button></div></form></div></div>
      <div class="card"><div class="card-h"><h2>Users</h2><span class="sub">People who can sign in</span></div><div class="card-b"><div id="users"></div>
        <form id="user-form" class="form-grid" style="margin-top:12px;padding-top:14px;border-top:1px solid var(--border)">
          <div class="field"><label>Name</label><input class="input" name="name" required/></div>
          <div class="field"><label>Email</label><input class="input" name="email" type="email" required/></div>
          <div class="field"><label>Temporary password</label><input class="input" name="password" type="text" minlength="10" autocomplete="off" required/></div>
          <div class="field"><label>Role</label><select class="input" name="role"><option value="user">User</option><option value="admin">Admin</option></select></div>
          <div class="full"><button class="btn">${icon("plus")} Add user</button></div></form></div></div>
      <div class="card"><div class="card-h"><h2>Appearance</h2></div><div class="card-b"><div class="tabs" id="theme-tabs"><button data-t="system">System</button><button data-t="light">${icon("sun")} Light</button><button data-t="dark">${icon("moon")} Dark</button></div></div></div>
      <div class="card"><div class="card-h"><h2>Privacy & security</h2></div><div class="card-b"><ul class="steps-list">
        <li>Runs on this computer only (localhost) — not reachable from the internet.</li>
        <li>Files are read in place and never modified, moved or deleted.</li>
        <li>Only excerpts the agent needs for a question are sent to Anthropic's API; Anthropic doesn't train on API data.</li>
        <li>The API key and SharePoint secrets are stored locally on this machine.</li>
        <li>You control exactly which folders and sites the agent can see under Data sources.</li></ul></div></div>
      <div class="card"><div class="card-h"><h2>Index</h2></div><div class="card-b small" id="idx-info"></div></div>
    </div></div>`);
  const f = $("#ai-form");
  api("/api/settings").then((s) => {
    f.model.value = s.model; f.effort.value = s.effort || "medium"; f.aiMode.value = s.aiMode || "claude";
    $("#key-hint").textContent = s.hasKey ? `Key saved (${s.apiKey}). Leave blank to keep it.` : "No key saved — the assistant runs in offline demo mode.";
  });
  $("#rm-key").onclick = async () => { await api("/api/settings", { method: "POST", body: { removeKey: true } }); toast("API key removed"); refreshStatus(); pages.settings(); };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const b = Object.fromEntries(new FormData(f));
    try { await api("/api/settings", { method: "POST", body: b }); toast("Settings saved"); await refreshStatus(); pages.settings(); } catch (err) { toast(err.message, true); }
  };
  api("/api/me").then((m) => ($("#me").textContent = `${m.name} · ${m.email}`));
  const renderUsers = (list) => ($("#users").innerHTML = list.map((u) => `<div class="list-row" style="cursor:default"><div class="ftype">${esc(u.name.slice(0, 2))}</div><div class="grow"><div class="t">${esc(u.name)}</div><div class="meta">${esc(u.email)}</div></div><span class="chip">${esc(u.role)}</span></div>`).join(""));
  api("/api/users").then(renderUsers);
  $("#pw-form").onsubmit = async (e) => {
    e.preventDefault();
    try { await api("/api/password", { method: "POST", body: Object.fromEntries(new FormData(e.target)) }); e.target.reset(); toast("Password changed"); } catch (err) { toast(err.message, true); }
  };
  $("#user-form").onsubmit = async (e) => {
    e.preventDefault();
    try { renderUsers(await api("/api/users", { method: "POST", body: Object.fromEntries(new FormData(e.target)) })); e.target.reset(); toast("User added"); } catch (err) { toast(err.message, true); }
  };
  const tt = () => $$("#theme-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.t === (store.get("bjfc-theme") || "system")));
  $$("#theme-tabs button").forEach((b) => (b.onclick = () => { setTheme(b.dataset.t); tt(); }));
  tt();
  const i = STATUS.index || {};
  $("#idx-info").innerHTML = `<div class="kv"><div><span>Files indexed</span><b>${i.files ?? "—"}</b></div><div><span>Text searchable</span><b>${i.textIndexed ?? "—"}</b></div><div><span>Last scan</span><b>${i.scannedAt ? new Date(i.scannedAt).toLocaleTimeString() : "—"}</b></div><div><span>Scan time</span><b>${i.ms ?? "—"} ms</b></div></div>${(i.errors || []).map((e) => `<div class="small" style="color:var(--critical-ink);margin-top:8px">${esc(e)}</div>`).join("")}`;
};

// ---------------- Boot ----------------
api("/api/me").then((m) => {
  $("#user-name").textContent = m.name;
  $("#user-email").textContent = m.email;
  $("#user-av").textContent = m.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
}).catch(() => {});
$("#logout").onclick = async () => { await fetch("/api/logout", { method: "POST", headers: { "Content-Type": "application/json" } }); location.href = "/login.html"; };
await refreshStatus();
setInterval(refreshStatus, 15000);
route();
