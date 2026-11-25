// SharePoint connector via Microsoft Graph (app-only, client credentials).
// Credentials: the Command Centre's own Entra app (ENTRA_TENANT_ID / ENTRA_CLIENT_ID /
// ENTRA_CLIENT_SECRET — the same app as Microsoft sign-in) unless a site was added with its own.
// The app holds the Graph application permission Sites.Selected, so it only sees the sites an
// admin has granted it (Grant-PnPAzureADAppSitePermission … -Permissions Read).
//
// In demo mode ("Demo" ticked) it returns sample libraries so the flow can be shown without a tenant.
import crypto from "node:crypto";
import { classify, extractMeta } from "./indexer.js";
import { canExtract, extractText } from "./extract.js";
import { parseInvoiceRegister } from "./register.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
const MAX_FILES = 5000; // per site
const MAX_DOWNLOAD = 25 * 1024 * 1024; // bytes; bigger files are listed by name only
const CONCURRENCY = 4;
const tokens = new Map();
const textCache = new Map(); // `${sp.id}:${item.id}` → { modified, text, register } — re-syncs skip unchanged files

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

// Graph call with back-off on throttling (429/503 + Retry-After).
async function graph(sp, url, tries = 4) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url.startsWith("http") ? url : GRAPH + url, { headers: { Authorization: `Bearer ${await getToken(sp)}` } });
    if (res.ok) return res;
    if ((res.status === 429 || res.status === 503) && attempt < tries) {
      await sleep(Math.min(Number(res.headers.get("retry-after")) || 2 ** attempt, 60) * 1000);
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
const folderOf = (parentPath = "") => decodeURIComponent(parentPath.split("root:")[1] || "").replace(/^\/+/, "");

// "/BJFC_Accounts/Quotations/ " → "BJFC_Accounts/Quotations"; accepts a list or one path per line.
export const cleanPaths = (v) => [...new Set((Array.isArray(v) ? v : String(v || "").split(/\r?\n/)).map((p) => String(p).trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")).filter(Boolean))].slice(0, 50);
const encPath = (p) => p.split("/").map(encodeURIComponent).join("/");
const samePath = (a, b) => a.toLowerCase() === b.toLowerCase();
const ITEM_FIELDS = "id,name,size,lastModifiedDateTime,webUrl,file,folder,parentReference";

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
  if (root.file) return items.push({ ...root, drive }), true;
  const queue = [root.id];
  while (queue.length && items.length < MAX_FILES) {
    let url = `/drives/${drive.id}/items/${queue.shift()}/children?$select=${ITEM_FIELDS}&$top=200`;
    while (url && items.length < MAX_FILES) {
      const j = await (await graph(sp, url)).json();
      for (const it of j.value) {
        if (it.folder) queue.push(it.id);
        else if (it.file) items.push({ ...it, drive });
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
    const d = toDoc(sp, relPath, `${inv.number}${label ? ` – ${label}` : ""}`, text, { itemId: `${file.id}#${inv.row}`, size: text.length, modified: file.lastModifiedDateTime, webUrl: file.webUrl });
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

// Index every file in the site's document libraries (or just sp.libraries if set), or only the
// folders in sp.folders (paths from the library root) when the site is limited to some. Text is
// extracted from text, PDF, Word, Excel and PowerPoint files; others are indexed by name.
// sp.invoiceRegister (path of the schedule-of-invoices workbook) adds one invoice per row.
// Returns { docs, errors } — one unreadable file doesn't fail the sync.
export async function syncLibrary(sp) {
  if (sp.demo) return { docs: demoFiles.map(([lib, name, text]) => toDoc(sp, `${lib}/${name}`, name, text)), errors: [] };
  const site = await resolveSite(sp);
  const drives = (await (await graph(sp, `/sites/${site.id}/drives`)).json()).value;
  const items = [];
  const errors = [];
  const register = cleanPaths(sp.invoiceRegister)[0];
  const scope = cleanPaths(sp.folders);
  if (scope.length && register && !scope.some((f) => samePath(f, register) || register.toLowerCase().startsWith(f.toLowerCase() + "/"))) scope.push(register);
  const found = new Set();
  for (const drive of drives) {
    if (sp.libraries?.length && !sp.libraries.includes(drive.name)) continue;
    if (scope.length) {
      for (const p of scope) if (await walkPath(sp, drive, p, items)) found.add(p);
      continue;
    }
    let url = `/drives/${drive.id}/root/delta?$select=id,name,size,lastModifiedDateTime,webUrl,file,parentReference,deleted`;
    while (url) {
      const j = await (await graph(sp, url)).json();
      for (const it of j.value) if (it.file && !it.deleted) items.push({ ...it, drive });
      url = j["@odata.nextLink"];
      if (items.length >= MAX_FILES) {
        errors.push(`Stopped at ${MAX_FILES} files — narrow the libraries for this site.`);
        url = null;
      }
    }
  }
  for (const p of scope) if (!found.has(p)) errors.push(`${p}: no such folder or file in this site's libraries`);
  if (scope.length && items.length >= MAX_FILES) errors.push(`Stopped at ${MAX_FILES} files — choose fewer or smaller folders for this site.`);
  const docs = [];
  const seen = new Set();
  await pool(items.slice(0, MAX_FILES), CONCURRENCY, async (it) => {
    const key = `${sp.id}:${it.id}`;
    seen.add(key);
    const folder = folderOf(it.parentReference?.path);
    const relPath = [it.drive.name, folder, it.name].filter(Boolean).join("/");
    const isRegister = Boolean(register) && samePath([folder, it.name].filter(Boolean).join("/"), register);
    let text = "";
    if (canExtract(extOf(it.name)) && it.size <= MAX_DOWNLOAD) {
      const hit = textCache.get(key);
      if (hit && hit.modified === it.lastModifiedDateTime && !isRegister) text = hit.text;
      else {
        try {
          // The register is re-read every sync: "overdue" depends on today's date, not just the file.
          const buf = Buffer.from(await (await graph(sp, `/drives/${it.drive.id}/items/${it.id}/content`)).arrayBuffer());
          text = await extractText(buf, extOf(it.name));
          textCache.set(key, { modified: it.lastModifiedDateTime, text });
          if (isRegister) {
            const reg = parseInvoiceRegister(buf, { sheet: sp.invoiceRegisterSheet });
            if (reg) docs.push(...registerDocs(sp, it, relPath, reg));
            else errors.push(`${relPath}: no sheet with "Inv No." and "Date of Pmt" columns — not read as the invoice register`);
          }
        } catch (e) {
          errors.push(`${relPath}: ${e.message}`);
        }
      }
    }
    docs.push(toDoc(sp, relPath, it.name, text, { itemId: it.id, size: it.size, modified: it.lastModifiedDateTime, webUrl: it.webUrl }));
  });
  if (register && !docs.some((d) => d.fromRegister) && !errors.some((e) => e.includes(register))) errors.push(`${register}: invoice register not found`);
  for (const k of textCache.keys()) if (k.startsWith(`${sp.id}:`) && !seen.has(k)) textCache.delete(k);
  return { docs, errors };
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
