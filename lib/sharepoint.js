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
import { DATA_DIR } from "./config.js";
import { classify, extractMeta } from "./indexer.js";
import { canExtract, extractText } from "./extract.js";
import { parseInvoiceRegister } from "./register.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
// Per site: how many files are listed, and how many of those (newest first) also get their text read.
const maxFiles = () => Number(process.env.SHAREPOINT_MAX_FILES) || 5000;
const maxTextFiles = () => (process.env.SHAREPOINT_TEXT_FILES ? Number(process.env.SHAREPOINT_TEXT_FILES) || 0 : Infinity);
const MAX_DOWNLOAD = 25 * 1024 * 1024; // bytes; bigger files are listed by name only
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
  loaded.delete(sp.id);
  try { fs.rmSync(cacheFile(sp), { force: true }); } catch {}
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
  };
}

// "/drives/b!x/root:/Projects/2026" → "Projects/2026"
// Decoded per segment, and left as-is when it isn't valid percent-encoding (names with a stray "%").
const safeDecode = (seg) => { try { return decodeURIComponent(seg); } catch { return seg; } };
const folderOf = (parentPath = "") => (parentPath.split("root:")[1] || "").split("/").map(safeDecode).join("/").replace(/^\/+/, "");

// "/BJFC_Accounts/Quotations/ " → "BJFC_Accounts/Quotations"; accepts a list or one path per line.
export const cleanPaths = (v) => [...new Set((Array.isArray(v) ? v : String(v || "").split(/\r?\n/)).map((p) => String(p).trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")).filter(Boolean))].slice(0, 50);
const encPath = (p) => p.split("/").map(encodeURIComponent).join("/");
const samePath = (a, b) => a.toLowerCase() === b.toLowerCase();
const ITEM_FIELDS = "id,name,size,lastModifiedDateTime,webUrl,file,folder,parentReference";

// Only what a sync needs from a Graph item — a big library is hundreds of thousands of these.
const slim = (it, drive) => ({ id: it.id, name: it.name, size: it.size || 0, modified: it.lastModifiedDateTime, webUrl: it.webUrl, folder: folderOf(it.parentReference?.path), driveId: drive.id, driveName: drive.name });

// Everything under one folder (or the one file) at `p`, relative to the library root. Used when a
// site is limited to chosen folders: a whole-library delta would list every file just to drop most.
async function walkPath(sp, drive, p, items) {
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
      type: "invoice", ext: ".xlsx", fromRegister: true,
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
// (paths from the library root) when the site is limited to some. Every file is listed by name;
// text is read from text, PDF, Word, Excel and PowerPoint files — all of them, or with
// SHAREPOINT_TEXT_FILES set, the most recently changed that many.
// sp.invoiceRegister (path of the schedule-of-invoices workbook) adds one invoice per row.
// A big library takes a long time, so onDocs(docs) is called as the picture fills in: the invoices
// first, then every file with the text already known, then as more text is read.
// Returns { docs, errors } — one unreadable file doesn't fail the sync.
export async function syncLibrary(sp, { onDocs = () => {} } = {}) {
  if (sp.demo) return { docs: demoFiles.map(([lib, name, text]) => toDoc(sp, `${lib}/${name}`, name, text)), errors: [] };
  loadCache(sp);
  const site = await resolveSite(sp);
  const drives = (await (await graph(sp, `/sites/${site.id}/drives`)).json()).value.filter((d) => !sp.libraries?.length || sp.libraries.includes(d.name));
  const errors = [];
  const register = cleanPaths(sp.invoiceRegister)[0];
  const scope = cleanPaths(sp.folders);
  const relPathOf = (it) => [it.driveName, it.folder, it.name].filter(Boolean).join("/");
  // With a register, it alone says what an invoice is: other files that look like one stay findable as plain files.
  const fileDoc = (it, text) => {
    const d = toDoc(sp, relPathOf(it), it.name, text, { itemId: it.id, size: it.size, modified: it.modified, webUrl: it.webUrl });
    if (register && d.type === "invoice") d.type = "other";
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
  for (const drive of drives) {
    if (scope.length) continue;
    let url = `/drives/${drive.id}/root/delta?$select=id,name,size,lastModifiedDateTime,webUrl,file,parentReference,deleted&$top=1000`; // big pages: 5× fewer requests
    while (url) {
      const j = await (await graph(sp, url)).json();
      for (const it of j.value) if (it.file && !it.deleted) items.push(slim(it, drive));
      url = items.length >= cap ? null : j["@odata.nextLink"];
    }
  }
  for (const p of scope) {
    let found = false;
    for (const drive of drives) if (await walkPath(sp, drive, p, items)) found = true;
    if (!found) errors.push(`${p}: no such folder or file in this site's libraries`);
  }
  const byId = new Map();
  for (const it of items) if (!byId.has(it.id)) byId.set(it.id, it); // overlapping folders, or the register listed again
  const files = [...byId.values()].slice(0, cap);
  if (byId.size >= cap) errors.push(`Stopped at ${cap} files — ${scope.length ? "choose fewer or smaller folders" : "limit this site to some folders"}, or raise SHAREPOINT_MAX_FILES.`);

  // 3. Which files get their text: the newest readable ones, as many as allowed.
  const readable = files.filter((it) => it !== regItem && canExtract(extOf(it.name)) && it.size <= MAX_DOWNLOAD).sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
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
