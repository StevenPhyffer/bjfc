// SharePoint connector via Microsoft Graph (app-only, client credentials).
// Credentials: the Command Centre's own Entra app (ENTRA_TENANT_ID / ENTRA_CLIENT_ID /
// ENTRA_CLIENT_SECRET — the same app as Microsoft sign-in) unless a site was added with its own.
// The app holds the Graph application permission Sites.Selected, so it only sees the sites an
// admin has granted it (Grant-PnPAzureADAppSitePermission … -Permissions Read).
//
// In demo mode ("Demo" ticked) it returns sample libraries so the flow can be shown without a tenant.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, getConfig } from "./config.js";
import { classify, extractMeta } from "./indexer.js";
import { canExtract } from "./extract.js";
import { extractOffThread as extractText } from "./extractPool.js";
import { parseInvoiceRegister } from "./register.js";
import { categorise } from "./categorise.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
// Per site: how many files are listed, and how many of those (newest first) also get their text read.
const maxFiles = () => Number(process.env.SHAREPOINT_MAX_FILES) || 5000;
const maxTextFiles = () => (process.env.SHAREPOINT_TEXT_FILES ? Number(process.env.SHAREPOINT_TEXT_FILES) || 0 : Infinity);
const MAX_DOWNLOAD = 25 * 1024 * 1024; // bytes; bigger files are listed by name only
// Name-only folders are still opened once each, one at a time, to categorise them by content.
const MAX_SCAN = (Number(process.env.SHAREPOINT_SCAN_MB) || 10) * 1024 * 1024;
const scanOn = () => process.env.SHAREPOINT_SCAN !== "off";
const CONCURRENCY = 4;
const tokens = new Map();
const textCache = new Map(); // `${sp.id}:${item.id}` → { modified, text } — re-syncs skip unchanged files

// The extracted text is also kept on disk (DATA_DIR/sp-cache/<site>.jsonl, one line per file), so
// a restart or deploy doesn't download a large library again.
const cacheFile = (sp) => path.join(DATA_DIR, "sp-cache", `${String(sp.id).replace(/[^\w-]/g, "_")}.jsonl`);
const loaded = new Set();
function loadCache(sp) {
  if (loaded.has(sp.id)) return;
  loaded.add(sp.id);
  let raw;
  try { raw = fs.readFileSync(cacheFile(sp), "utf8"); } catch { return; }
  for (const line of raw.split("\n")) {
    try {
      const e = JSON.parse(line);
      textCache.set(`${sp.id}:${e.id}`, { modified: e.modified, text: e.text });
    } catch {} // blank or half-written last line
  }
}
function remember(sp, id, modified, text) {
  textCache.set(`${sp.id}:${id}`, { modified, text });
  try {
    fs.mkdirSync(path.dirname(cacheFile(sp)), { recursive: true });
    fs.appendFileSync(cacheFile(sp), JSON.stringify({ id, modified, text }) + "\n", { mode: 0o600 });
  } catch {} // the cache is an optimisation; the sync still works without it
}
// After a sync: drop what's no longer wanted, in memory and on disk (which also removes superseded lines).
function compactCache(sp, keep) {
  const lines = [];
  for (const [k, e] of textCache) {
    if (!k.startsWith(`${sp.id}:`)) continue;
    if (!keep.has(k)) textCache.delete(k);
    else lines.push(JSON.stringify({ id: k.slice(String(sp.id).length + 1), modified: e.modified, text: e.text }));
  }
  try {
    fs.mkdirSync(path.dirname(cacheFile(sp)), { recursive: true });
    fs.writeFileSync(cacheFile(sp) + ".tmp", lines.length ? lines.join("\n") + "\n" : "", { mode: 0o600 });
    fs.renameSync(cacheFile(sp) + ".tmp", cacheFile(sp));
  } catch {}
}
export function forgetSite(sp) {
  for (const k of [...textCache.keys()]) if (k.startsWith(`${sp.id}:`)) textCache.delete(k);
  for (const k of [...labels.keys()]) if (k.startsWith(`${sp.id}:`)) labels.delete(k);
  loaded.delete(sp.id);
  labelsLoaded.delete(sp.id);
  try { fs.rmSync(cacheFile(sp), { force: true }); } catch {}
  try { fs.rmSync(labelFile(sp), { force: true }); } catch {}
  try { fs.rmSync(listFile(sp), { force: true }); } catch {}
}

// Categories worked out from content, for files whose text isn't kept (name-only folders):
// DATA_DIR/sp-cache/<site>.labels.jsonl, one line per file — the label only, never the text.
// A line is written before a file is opened ("p") and replaced when it's done: if opening a file
// ever takes the server down, that file is skipped next time instead of doing it again.
const labels = new Map(); // `${sp.id}:${item.id}` → { modified, area, category } | { modified, skip }
const labelFile = (sp) => cacheFile(sp).replace(/\.jsonl$/, ".labels.jsonl");
const labelsLoaded = new Set();
function loadLabels(sp) {
  if (labelsLoaded.has(sp.id)) return;
  labelsLoaded.add(sp.id);
  let raw;
  try { raw = fs.readFileSync(labelFile(sp), "utf8"); } catch { return; }
  for (const line of raw.split("\n")) {
    try {
      const e = JSON.parse(line);
      if (e.x) labels.delete(`${sp.id}:${e.id}`); // mark withdrawn: try this file again
      else labels.set(`${sp.id}:${e.id}`, e.a ? { modified: e.m, area: e.a, category: e.c } : { modified: e.m, skip: true });
    } catch {}
  }
}
const labelLine = (id, l) => JSON.stringify(l.skip ? { id, m: l.modified, p: 1 } : { id, m: l.modified, a: l.area, c: l.category }) + "\n";
function setLabel(sp, id, l) {
  labels.set(`${sp.id}:${id}`, l);
  try {
    fs.mkdirSync(path.dirname(labelFile(sp)), { recursive: true });
    fs.appendFileSync(labelFile(sp), labelLine(id, l), { mode: 0o600 });
  } catch {}
}
function compactLabels(sp, keep) {
  let out = "";
  for (const [k, l] of labels) {
    if (!k.startsWith(`${sp.id}:`)) continue;
    if (!keep.has(k)) labels.delete(k);
    else out += labelLine(k.slice(String(sp.id).length + 1), l);
  }
  try {
    fs.mkdirSync(path.dirname(labelFile(sp)), { recursive: true });
    fs.writeFileSync(labelFile(sp) + ".tmp", out, { mode: 0o600 });
    fs.renameSync(labelFile(sp) + ".tmp", labelFile(sp));
  } catch {}
}

// The last listing, kept on disk (DATA_DIR/sp-cache/<site>.list.jsonl) so a restart shows the
// library at once instead of an empty one for the ten minutes a big listing takes. File names,
// dates and categories only: text is left out and put back from the text cache on loading
// (invoice-register rows keep theirs — they are the dashboard's figures).
const listFile = (sp) => cacheFile(sp).replace(/\.jsonl$/, ".list.jsonl");
function saveSnapshot(sp, docs) {
  let fd;
  try {
    fs.mkdirSync(path.dirname(listFile(sp)), { recursive: true });
    fd = fs.openSync(listFile(sp) + ".tmp", "w", 0o600);
    for (let i = 0; i < docs.length; i += 500) {
      fs.writeSync(fd, docs.slice(i, i + 500).map((d) => JSON.stringify(d.fromRegister ? d : { ...d, text: "" })).join("\n") + "\n");
    }
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(listFile(sp) + ".tmp", listFile(sp));
  } catch {
    if (fd != null) try { fs.closeSync(fd); } catch {}
  }
}
export function loadSnapshot(sp) {
  let raw;
  try { raw = fs.readFileSync(listFile(sp), "utf8"); } catch { return []; }
  loadCache(sp);
  const docs = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const d = JSON.parse(line);
      if (!d.fromRegister && d.textIndexed) d.text = textCache.get(`${sp.id}:${d.remote?.itemId}`)?.text || "";
      d.textIndexed = Boolean(d.text);
      d.agentAccess = sp.agentAccess !== false;
      docs.push(d);
    } catch {} // half-written last line
  }
  return docs;
}

// Reading a PDF takes a few hundred MB for a moment, so files that are opened without being
// kept — the categorising scan and liveText — go through here one at a time.
let serialQueue = Promise.resolve();
function serial(fn) {
  const run = serialQueue.then(fn);
  serialQueue = run.catch(() => {});
  return run;
}

// ---------------- Credentials ----------------
const appCreds = () => ({ tenantId: process.env.ENTRA_TENANT_ID, clientId: process.env.ENTRA_CLIENT_ID, clientSecret: process.env.ENTRA_CLIENT_SECRET });
export const appCredentialsAvailable = () => Object.values(appCreds()).every(Boolean);

export function credsFor(sp) {
  if (sp.tenantId && sp.clientId && sp.clientSecret) return { tenantId: sp.tenantId, clientId: sp.clientId, clientSecret: sp.clientSecret };
  if (appCredentialsAvailable()) return appCreds();
  throw new Error("No Microsoft app credentials: set ENTRA_TENANT_ID, ENTRA_CLIENT_ID and ENTRA_CLIENT_SECRET, or add the site with its own.");
}

async function getToken(sp) {
  const c = credsFor(sp);
  const key = `${c.tenantId}|${c.clientId}`;
  const cached = tokens.get(key);
  if (cached && cached.exp > Date.now() + 60000) return cached.token;
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(c.tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error_description?.split("\r\n")[0] || j.error || `Token request failed (${res.status})`);
  tokens.set(key, { token: j.access_token, exp: Date.now() + j.expires_in * 1000 });
  return j.access_token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY_MS = Number(process.env.SHAREPOINT_RETRY_MS) || 1000; // first back-off step

// Graph call with back-off on throttling (429/503 + Retry-After), server hiccups and dropped
// connections — listing a big library is hundreds of requests, and one blip mustn't end the sync.
async function graph(sp, url, tries = 5) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      // Never wait forever on a stalled connection: 2 minutes for a listing, 10 for a file download.
      res = await fetch(url.startsWith("http") ? url : GRAPH + url, { headers: { Authorization: `Bearer ${await getToken(sp)}` }, signal: AbortSignal.timeout(url.endsWith("/content") ? 600000 : 120000) });
    } catch (e) {
      if (attempt >= tries) throw new Error(`Network error talking to Microsoft Graph: ${e.cause?.code || e.message}`);
      await sleep(RETRY_MS * 2 ** attempt);
      continue;
    }
    if (res.ok) return res;
    if ([429, 500, 502, 503, 504].includes(res.status) && attempt < tries) {
      const wait = res.headers.get("retry-after");
      await sleep(wait != null && wait !== "" ? Math.min(Number(wait) || 0, 60) * 1000 : RETRY_MS * 2 ** attempt);
      continue;
    }
    const j = await res.json().catch(() => ({}));
    if (res.status === 403 || res.status === 404) {
      throw new Error(`${j.error?.message || `Graph request failed (${res.status})`} — if this site is right, the app may not have been granted access to it yet (Sites.Selected).`);
    }
    throw new Error(j.error?.message || `Graph request failed (${res.status})`);
  }
}

async function resolveSite(sp) {
  const u = new URL(sp.siteUrl);
  const sitePath = u.pathname.replace(/\/$/, "");
  return (await graph(sp, `/sites/${u.hostname}:${sitePath || "/"}`)).json();
}

// ---------------- Demo data ----------------
const demoLibraries = [
  { name: "Documents", items: 1284 },
  { name: "Tenders & Proposals", items: 312 },
  { name: "Project Close-out", items: 86 },
];
const demoFiles = [
  ["Tenders & Proposals", "Tender – Coastal Road Rehabilitation (Bid Doc).txt", `TENDER SUBMISSION – Coastal Road Rehabilitation\nClient: Harbourline Developments\nClosing Date: 2026-10-21\nStatus: In preparation\nTender sum (estimate, incl. VAT): R 4 870 000,00\nTeam: L. van Wyk (Pr Eng), P. Govender\nCompulsory briefing attended. Outstanding: CIDB grading letter, B-BBEE affidavit.`],
  ["Tenders & Proposals", "Proposal – Midlands Poultry Effluent Treatment.txt", `PROPOSAL – Effluent treatment upgrade\nClient: Midlands Poultry Co-operative\nStatus: Submitted\nFee proposal (incl. VAT): R 1 265 000,00\nDecision expected within 6 weeks.`],
  ["Documents", "Company Profile 2026.txt", `BJ-FC Consulting Engineers – Company Profile\nFounded 2005 · Durban & Gauteng offices · Level 2 B-BBEE\nServices: civil, structural, water engineering, project management, environmental licensing support.`],
  ["Documents", "Professional Indemnity Insurance Schedule.txt", `PI INSURANCE SCHEDULE (demo)\nPolicy period ends: 2026-11-30\nLimit of indemnity: R 20 000 000\nAction: broker to confirm renewal terms.`],
  ["Project Close-out", "Seaview Schools – Close-out Report.txt", `CLOSE-OUT REPORT\nClient: Seaview Schools Trust\nProject: Condition assessment of existing buildings\nAll deliverables issued. Final account agreed. Lessons learned: earlier access to as-built drawings needed.`],
];

const extOf = (name) => (name.includes(".") ? "." + name.split(".").pop().toLowerCase() : "");

function toDoc(sp, relPath, name, text, extra = {}) {
  let type = classify(relPath, text);
  if (type === "other" && /tender|proposal/i.test(name)) type = "quote"; // fee proposals and bids count as quotes
  const folder = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
  return {
    id: crypto.createHash("sha1").update(sp.id + (extra.itemId || relPath)).digest("hex").slice(0, 12),
    name, path: `${sp.siteUrl}/${relPath}`, relPath, folder,
    ext: extOf(name), size: extra.size ?? text.length, modified: extra.modified || new Date(Date.now() - Math.random() * 30 * 86400000).toISOString(),
    sourceId: sp.id, sourceName: `SharePoint – ${sp.displayName || new URL(sp.siteUrl).pathname}`, sourceType: "sharepoint",
    agentAccess: sp.agentAccess !== false, type, text, textIndexed: Boolean(text), meta: text ? extractMeta(type, text) : {},
    webUrl: extra.webUrl,
    ...categoryFields(relPath, text),
  };
}
const categoryFields = (relPath, text, projects) => {
  const c = categorise({ relPath, text, projects });
  return { area: c.area, category: c.category, categorisedBy: c.by };
};

// "/drives/b!x/root:/Projects/2026" → "Projects/2026"
// Decoded per segment, and left as-is when it isn't valid percent-encoding (names with a stray "%").
const safeDecode = (seg) => { try { return decodeURIComponent(seg); } catch { return seg; } };
const folderOf = (parentPath = "") => (parentPath.split("root:")[1] || "").split("/").map(safeDecode).join("/").replace(/^\/+/, "");

// "/BJFC_Accounts/Quotations/ " → "BJFC_Accounts/Quotations"; accepts a list or one path per line.
export const cleanPaths = (v) => [...new Set((Array.isArray(v) ? v : String(v || "").split(/\r?\n/)).map((p) => String(p).trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")).filter(Boolean))].slice(0, 50);
const encPath = (p) => p.split("/").map(encodeURIComponent).join("/");
// Is `rel` the path `p` itself, or inside it? (case-insensitive, whole folder names only)
const under = (rel, p) => { rel = rel.toLowerCase(); p = p.toLowerCase(); return rel === p || rel.startsWith(p + "/"); };
const ITEM_FIELDS = "id,name,size,lastModifiedDateTime,webUrl,file,folder,parentReference";

// Only what a sync needs from a Graph item — a big library is hundreds of thousands of these.
const slim = (it, drive) => ({ id: it.id, name: it.name, size: it.size || 0, modified: it.lastModifiedDateTime, webUrl: it.webUrl, folder: folderOf(it.parentReference?.path), driveId: drive.id, driveName: drive.name });

// Everything under one folder (or the one file) at `p`, relative to the library root. Used when a
// site is limited to chosen folders: a whole-library delta would list every file just to drop most.
async function walkPath(sp, drive, p, items, skip = () => false) {
  let res;
  try {
    res = await graph(sp, `/drives/${drive.id}/root:/${encPath(p)}?$select=${ITEM_FIELDS}`);
  } catch (e) {
    if (/not (be )?found|does not exist/i.test(e.message)) return false;
    throw e;
  }
  const root = await res.json();
  if (root.file) return items.push(slim(root, drive)), true;
  const queue = [root.id];
  while (queue.length && items.length < maxFiles()) {
    let url = `/drives/${drive.id}/items/${queue.shift()}/children?$select=${ITEM_FIELDS}&$top=200`;
    while (url && items.length < maxFiles()) {
      const j = await (await graph(sp, url)).json();
      for (const it of j.value) {
        const rel = [folderOf(it.parentReference?.path), it.name].filter(Boolean).join("/");
        if (skip(rel)) continue;
        if (it.folder) queue.push(it.id);
        else if (it.file) items.push(slim(it, drive));
      }
      url = j["@odata.nextLink"];
    }
  }
  return true;
}

// One dashboard invoice per register row. They share the workbook's link; the totals come from here.
const money = (n) => `R ${n.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
function registerDocs(sp, file, relPath, reg) {
  return reg.invoices.map((inv) => {
    const label = [inv.project, inv.description].filter(Boolean).join(" · ");
    const text = [`Invoice No: ${inv.number}`, inv.date && `Date: ${inv.date}`, inv.project && `Project No: ${inv.project}`, inv.description && `Description: ${inv.description}`,
      `Total (incl. VAT): ${money(inv.total)}`, `Status: ${inv.status}`, inv.paidDate ? `Date of payment: ${inv.paidDate}` : `Balance Due: ${money(inv.balance)}`,
      `Source: ${file.name}, sheet "${reg.sheet}"`].filter(Boolean).join("\n");
    // Keyed by row: the same invoice number can appear twice in a register.
    const d = toDoc(sp, relPath, `${inv.number}${label ? ` – ${label}` : ""}`, text, { itemId: `${file.id}#${inv.row}`, size: text.length, modified: file.modified, webUrl: file.webUrl });
    return Object.assign(d, {
      type: "invoice", ext: ".xlsx", fromRegister: true, area: "Finance", category: "Invoices", categorisedBy: "content",
      meta: { number: inv.number, client: inv.project || "Unallocated", project: label || null, date: inv.date, dueDate: inv.dueDate, status: inv.status, total: inv.total, balance: inv.balance, daysOverdue: inv.daysOverdue, paidDate: inv.paidDate },
    });
  });
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

// ---------------- Public API ----------------
export async function testConnection(sp) {
  if (sp.demo) {
    await sleep(900);
    return { ok: true, demo: true, siteName: sp.displayName || "BJFC Intranet (demo)", libraries: demoLibraries };
  }
  const site = await resolveSite(sp);
  const drives = await (await graph(sp, `/sites/${site.id}/drives`)).json();
  return { ok: true, siteId: site.id, siteName: site.displayName, libraries: drives.value.map((d) => ({ id: d.id, name: d.name })) };
}

// Index the site's document libraries (or just sp.libraries), or only the folders in sp.folders
// and sp.listOnly (paths from the library root) when the site is limited to some; anything under
// sp.exclude is left out. Every file is listed by name. Text is read from text, PDF, Word, Excel
// and PowerPoint files — all of them, or with SHAREPOINT_TEXT_FILES set, the most recently changed
// that many — except under sp.listOnly: those files are never read in bulk and nothing of their
// content is kept here; liveText() fetches one from SharePoint when somebody asks for it.
// sp.invoiceRegister (path of the schedule-of-invoices workbook) adds one invoice per row.
// A big library takes a long time, so onDocs(docs) is called as the picture fills in: the invoices
// first, then every file with the text already known, then as more text is read.
// Returns { docs, errors } — one unreadable file doesn't fail the sync.
export async function syncLibrary(sp, { onDocs = () => {} } = {}) {
  if (sp.demo) return { docs: demoFiles.map(([lib, name, text]) => toDoc(sp, `${lib}/${name}`, name, text)), errors: [] };
  loadCache(sp);
  loadLabels(sp);
  const site = await resolveSite(sp);
  const drives = (await (await graph(sp, `/sites/${site.id}/drives`)).json()).value.filter((d) => !sp.libraries?.length || sp.libraries.includes(d.name));
  const errors = [];
  const register = cleanPaths(sp.invoiceRegister)[0];
  const scope = cleanPaths(sp.folders);
  const listOnly = cleanPaths(sp.listOnly);
  const exclude = cleanPaths(sp.exclude);
  const wholeScope = [...scope, ...listOnly];
  const relOf = (it) => [it.folder, it.name].filter(Boolean).join("/"); // from the library root
  const excluded = (rel) => exclude.some((p) => under(rel, p));
  // Name-only unless it's inside a folder chosen for indexing ("BJFC Admin" by name, but
  // "BJFC Admin/BJ-FC Quotations" indexed).
  const nameOnly = (it) => listOnly.some((p) => under(relOf(it), p)) && !scope.some((p) => under(relOf(it), p));
  const projects = new Map();
  const relPathOf = (it) => [it.driveName, it.folder, it.name].filter(Boolean).join("/");
  // With a register, it alone says what an invoice is: other files that look like one stay findable as plain files.
  const fileDoc = (it, text) => {
    const d = toDoc(sp, relPathOf(it), it.name, text, { itemId: it.id, size: it.size, modified: it.modified, webUrl: it.webUrl });
    if (register && d.type === "invoice") d.type = "other";
    // The Quotes page is for quotes that were read: a name-only file merely called "tender…" isn't one.
    if (d.type === "quote" && !text && nameOnly(it)) d.type = "other";
    // Area and category: from the text when there is some, else a label from an earlier scan, else the name.
    const label = !text && labels.get(`${sp.id}:${it.id}`);
    Object.assign(d, label && !label.skip && label.modified === it.modified ? { area: label.area, category: label.category, categorisedBy: "content" } : categoryFields(d.relPath, text, projects));
    // Where to fetch it from when its text isn't kept here (see liveText).
    d.remote = { driveId: it.driveId, itemId: it.id };
    return d;
  };
  const download = async (it) => Buffer.from(await (await graph(sp, `/drives/${it.driveId}/items/${it.id}/content`)).arrayBuffer());

  // 1. The invoice register, read fresh every sync: "overdue" depends on today's date, not just the file.
  let regItem = null;
  let regDocs = [];
  if (register) {
    for (const drive of drives) {
      const got = [];
      if (await walkPath(sp, drive, register, got) && got.length === 1) { regItem = got[0]; break; }
    }
    if (!regItem) errors.push(`${register}: invoice register not found`);
    else {
      try {
        const buf = await download(regItem);
        const reg = parseInvoiceRegister(buf, { sheet: sp.invoiceRegisterSheet });
        if (reg) regDocs = registerDocs(sp, regItem, relPathOf(regItem), reg);
        else errors.push(`${relPathOf(regItem)}: no sheet with "Inv No." and "Date of Pmt" columns — not read as the invoice register`);
        remember(sp, regItem.id, regItem.modified, await extractText(buf, extOf(regItem.name)));
      } catch (e) {
        errors.push(`${relPathOf(regItem)}: ${e.message}`);
      }
      if (regDocs.length) onDocs(regDocs);
    }
  }

  // 2. List the files.
  const items = regItem ? [regItem] : [];
  const cap = maxFiles();
  // Two ways to list. A few small folders: walk them (seconds). The whole site, or big
  // name-only folders: one delta listing of the library, kept only where it matches — a thousand
  // files a request, where a walk is a request per folder (the Admin tree took over an hour).
  const viaDelta = !scope.length || listOnly.length > 0;
  const seen = new Set();
  for (const drive of viaDelta ? drives : []) {
    let url = `/drives/${drive.id}/root/delta?$select=id,name,size,lastModifiedDateTime,webUrl,file,parentReference,deleted&$top=1000`; // big pages: 5× fewer requests
    while (url) {
      const j = await (await graph(sp, url)).json();
      for (const raw of j.value) {
        if (!raw.file || raw.deleted) continue;
        const it = slim(raw, drive);
        const rel = relOf(it);
        if (excluded(rel)) continue;
        const hit = wholeScope.find((p) => under(rel, p));
        if (wholeScope.length && !hit) continue;
        if (hit) seen.add(hit);
        items.push(it);
      }
      url = items.length >= cap ? null : j["@odata.nextLink"];
    }
  }
  for (const p of viaDelta ? [] : scope) {
    let found = false;
    for (const drive of drives) if (await walkPath(sp, drive, p, items, excluded)) found = true;
    if (found) seen.add(p);
  }
  if (items.length < cap) for (const p of wholeScope) if (!seen.has(p)) errors.push(`${p}: no such folder or file in this site's libraries${viaDelta ? " (or it is empty)" : ""}`);
  const byId = new Map();
  for (const it of items) if (!byId.has(it.id)) byId.set(it.id, it); // overlapping folders, or the register listed again
  const files = [...byId.values()].slice(0, cap);
  if (byId.size >= cap) errors.push(`Stopped at ${cap} files — ${scope.length ? "choose fewer or smaller folders" : "limit this site to some folders"}, or raise SHAREPOINT_MAX_FILES.`);

  // Known projects, for categorising: codes in the register, and the folders of a "…Projects" folder
  // whose names start with one ("ETH11 - Illovo Fire Station").
  for (const d of regDocs) if (/^[A-Z]{1,5}\d{1,3}[A-Z]?$/i.test(d.meta.client || "")) projects.set(d.meta.client.toUpperCase(), d.meta.client.toUpperCase());
  for (const it of files) {
    const [top, sub] = it.folder.split("/");
    const m = sub && /projects?\b/i.test(top) && sub.match(/^([A-Za-z]{1,5}) ?-?(\d{1,3}[A-Za-z]?)\b/);
    if (m) projects.set((m[1] + m[2]).toUpperCase(), sub);
  }

  // 3. Which files get their text: the newest readable ones, as many as allowed.
  const readable = files.filter((it) => it !== regItem && !nameOnly(it) && canExtract(extOf(it.name)) && it.size <= MAX_DOWNLOAD).sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
  const wanted = new Set(readable.slice(0, maxTextFiles()));
  if (regItem) wanted.add(regItem);
  const keep = new Set();
  const position = new Map();
  const todo = [];
  const docs = files.map((it, i) => {
    let text = "";
    if (wanted.has(it)) {
      const key = `${sp.id}:${it.id}`;
      const hit = textCache.get(key);
      if (hit && hit.modified === it.modified) { text = hit.text; keep.add(key); }
      else { todo.push(it); position.set(it, i); }
    }
    return fileDoc(it, text);
  });
  const all = () => regDocs.concat(docs);
  if (todo.length) onDocs(all());

  // 4. Read the rest, newest first, showing progress about once a minute.
  let shown = Date.now();
  await pool(todo, CONCURRENCY, async (it) => {
    try {
      const text = await extractText(await download(it), extOf(it.name));
      remember(sp, it.id, it.modified, text);
      keep.add(`${sp.id}:${it.id}`);
      docs[position.get(it)] = fileDoc(it, text);
    } catch (e) {
      errors.push(`${relPathOf(it)}: ${e.message}`);
    }
    if (Date.now() - shown > 60000) { shown = Date.now(); onDocs(all()); }
  });
  compactCache(sp, keep);

  // 5. Categorise the name-only files by what's in them: open each once (newest first, one at a
  // time), keep the label, drop the text. Later syncs only open files that are new or changed.
  const keepLabels = new Set();
  const scan = [];
  docs.forEach((d, i) => {
    const it = files[i];
    if (d.textIndexed || !nameOnly(it)) return;
    const key = `${sp.id}:${it.id}`;
    const l = labels.get(key);
    if (l && l.modified === it.modified) return void keepLabels.add(key);
    if (scanOn() && canExtract(extOf(it.name)) && it.size <= MAX_SCAN) scan.push(i);
  });
  saveSnapshot(sp, all()); // the listing is complete here; the scan below can run for hours
  scan.sort((a, b) => (files[a].modified < files[b].modified ? 1 : files[a].modified > files[b].modified ? -1 : 0));
  if (process.env.SHAREPOINT_SCAN_FILES) scan.length = Math.min(scan.length, Number(process.env.SHAREPOINT_SCAN_FILES) || 0); // at most this many per sync
  if (scan.length) onDocs(all());
  let unread = 0;
  for (const i of scan) {
    const it = files[i];
    const key = `${sp.id}:${it.id}`;
    keepLabels.add(key);
    setLabel(sp, it.id, { modified: it.modified, skip: true }); // until it has been read
    try {
      const text = await serial(async () => extractText(await download(it), extOf(it.name)));
      if (!text) continue; // scanned PDF, empty file: stays categorised by name
      const cat = categorise({ relPath: relPathOf(it), text, projects });
      setLabel(sp, it.id, { modified: it.modified, area: cat.area, category: cat.category });
      Object.assign(docs[i], { area: cat.area, category: cat.category, categorisedBy: "content" });
    } catch (e) {
      // A dropped connection isn't the file's fault: forget the mark so the next sync tries again.
      if (/network error|graph request failed|timed? ?out|terminated/i.test(e.message)) {
        labels.delete(key);
        keepLabels.delete(key);
        try { fs.appendFileSync(labelFile(sp), JSON.stringify({ id: it.id, x: 1 }) + "\n"); } catch {}
      }
      else unread++;
    }
    if (Date.now() - shown > 60000) { shown = Date.now(); onDocs(all()); }
  }
  if (unread) errors.push(`${unread} file(s) couldn't be opened to categorise them (password-protected or damaged) — categorised by name instead`);
  compactLabels(sp, keepLabels);
  saveSnapshot(sp, all());
  return { docs: all(), errors };
}

// Live search straight against SharePoint (used by the AI agent's search_sharepoint tool).
export async function searchSharePoint(sp, query) {
  if (sp.demo) {
    const q = query.toLowerCase().split(/\s+/);
    return demoFiles
      .filter(([lib, name, text]) => q.some((t) => (name + text).toLowerCase().includes(t)))
      .map(([lib, name, text]) => ({ site: sp.displayName, library: lib, name, preview: text.slice(0, 300) }));
  }
  const site = await resolveSite(sp);
  const j = await (await graph(sp, `/sites/${site.id}/drive/root/search(q='${encodeURIComponent(query.replace(/'/g, "''"))}')?$top=15`)).json();
  return j.value.map((i) => ({ site: sp.displayName, name: i.name, webUrl: i.webUrl, modified: i.lastModifiedDateTime }));
}

// Read one file straight from SharePoint, for a document whose text isn't kept here (name-only
// folders, or files past the text budget). Nothing is written to disk. The last few stay in
// memory so that opening a file and then asking the assistant about it is one download, not two.
const recent = new Map(); // doc id → { modified, text }
export const canReadLive = (d) => Boolean(d?.sourceType === "sharepoint" && d.remote && !d.textIndexed && canExtract(d.ext) && d.size <= MAX_DOWNLOAD);
export function liveText(d) {
  if (!canReadLive(d)) return Promise.reject(new Error(d?.size > MAX_DOWNLOAD ? "This file is too large to read here — open it in SharePoint." : "This kind of file can't be read as text — open it in SharePoint."));
  const sp = getConfig().sharepoint.find((s) => s.id === d.sourceId && s.status === "connected");
  if (!sp) return Promise.reject(new Error("That SharePoint site is no longer connected."));
  return serial(async () => {
    const hit = recent.get(d.id);
    if (hit && hit.modified === d.modified) return hit.text;
    const res = await graph(sp, `/drives/${d.remote.driveId}/items/${d.remote.itemId}/content`);
    const text = await extractText(Buffer.from(await res.arrayBuffer()), d.ext);
    recent.delete(d.id);
    recent.set(d.id, { modified: d.modified, text });
    if (recent.size > 8) recent.delete(recent.keys().next().value);
    return text;
  });
}
