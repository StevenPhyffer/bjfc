// Walks the configured folders (local PC + server shares), reads text-based files,
// classifies them (quote / invoice / report ...) and pulls out business fields so
// the dashboard and the AI agent can answer "show me all unpaid invoices" instantly.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getConfig } from "./config.js";
import { categorise } from "./categorise.js";

const TEXT_EXT = new Set([".txt", ".md", ".csv", ".json", ".log", ".xml", ".html", ".htm", ".tsv"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "$RECYCLE.BIN", "System Volume Information", ".Trash"]);
const MAX_FILES = 20000;
const MAX_TEXT = 256 * 1024;

let index = { docs: [], byId: new Map(), scannedAt: null, errors: [] };
const extraDocs = new Map(); // docs contributed by other connectors (SharePoint)

export const getIndex = () => index;

export function parseAmount(str) {
  if (!str) return null;
  let s = String(str).replace(/[R\s ]/g, "");
  if (/,\d{2}$/.test(s)) s = s.replace(/\./g, "").replace(",", "."); // 1 234,56
  else s = s.replace(/,/g, ""); // 1,234.56
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

const field = (text, label) => {
  const m = text.match(new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, "im"));
  return m ? m[1].trim() : null;
};

export function classify(rel, text) {
  const hay = (rel + " " + text.slice(0, 600)).toLowerCase();
  if (/\b(tax invoice|invoice no|inv-\d)/.test(hay) || /invoices?[\\/]/.test(hay)) return "invoice";
  if (/\b(quotation|quote no|q-\d{4})/.test(hay) || /quotes?[\\/]/.test(hay)) return "quote";
  if (/minutes/.test(hay)) return "minutes";
  if (/\.(dwg|dxf)$/.test(rel.toLowerCase()) || /drawings?[\\/]/.test(hay)) return "drawing";
  if (/report|notes|assessment/.test(hay)) return "report";
  if (/\.(csv|xlsx?|tsv)$/.test(rel.toLowerCase())) return "spreadsheet";
  if (/polic(y|ies)|hr[\\/]/.test(hay)) return "policy";
  return "other";
}

export function extractMeta(type, text) {
  const meta = {
    number: field(text, "(?:Quote|Invoice) No"),
    client: field(text, "Client"),
    project: field(text, "Project"),
    date: field(text, "Date"),
    dueDate: field(text, "(?:Due Date|Valid Until)"),
    status: field(text, "Status"),
    total: parseAmount(field(text, "Total \\(incl\\. VAT\\)") || field(text, "Total")),
    balance: parseAmount(field(text, "Balance Due")),
    preparedBy: field(text, "(?:Prepared By|Engineer)"),
  };
  if (meta.client) meta.client = meta.client.replace(/\*+/g, "").trim();
  if (type === "invoice") {
    if (meta.balance == null) meta.balance = /paid/i.test(meta.status || "") ? 0 : meta.total;
    const due = meta.dueDate ? new Date(meta.dueDate) : null;
    const today = new Date();
    if (meta.balance > 0 && due && due < today) {
      meta.status = "Overdue";
      meta.daysOverdue = Math.floor((today - due) / 86400000);
    }
  }
  return meta;
}

function walk(dir, out, root, source) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    index.errors.push(`${dir}: ${e.code || e.message}`);
    return;
  }
  for (const ent of entries) {
    if (out.length >= MAX_FILES) return;
    if (ent.name.startsWith(".") || SKIP_DIRS.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out, root, source);
    else if (ent.isFile()) out.push(buildDoc(full, root, source));
  }
}

function buildDoc(full, root, source) {
  const stat = fs.statSync(full);
  const ext = path.extname(full).toLowerCase();
  const rel = path.relative(root, full);
  let text = "";
  if (TEXT_EXT.has(ext) && stat.size < 5 * 1024 * 1024) {
    try {
      text = fs.readFileSync(full, "utf8").slice(0, MAX_TEXT);
    } catch {}
  }
  if (text.startsWith("%DEMO PLACEHOLDER")) text = "";
  const type = classify(rel, text);
  const cat = categorise({ relPath: rel, text });
  return {
    area: cat.area, category: cat.category, categorisedBy: cat.by,
    id: crypto.createHash("sha1").update(full).digest("hex").slice(0, 12),
    name: path.basename(full),
    path: full,
    relPath: rel,
    folder: path.dirname(rel),
    ext,
    size: stat.size,
    modified: stat.mtime.toISOString(),
    sourceId: source.id,
    sourceName: source.name,
    sourceType: source.type,
    agentAccess: source.agentAccess !== false,
    type,
    text,
    textIndexed: Boolean(text),
    meta: text ? extractMeta(type, text) : {},
  };
}

export function rescan() {
  const started = Date.now();
  const cfg = getConfig();
  index = { docs: [], byId: new Map(), scannedAt: null, errors: [] };
  for (const src of cfg.sources.filter((s) => s.enabled)) {
    if (!fs.existsSync(src.path)) {
      index.errors.push(`${src.name}: folder not found (${src.path})`);
      continue;
    }
    walk(src.path, index.docs, src.path, src);
  }
  for (const d of extraDocs.values()) index.docs.push(d);
  for (const d of index.docs) index.byId.set(d.id, d);
  index.scannedAt = new Date().toISOString();
  index.ms = Date.now() - started;
  return index;
}

export function setExtraDocs(prefix, docs) {
  for (const k of [...extraDocs.keys()]) if (k.startsWith(prefix)) extraDocs.delete(k);
  for (const d of docs) extraDocs.set(`${prefix}:${d.id}`, d);
  rescan();
}

export const extraDocsFor = (prefix) => [...extraDocs].filter(([k]) => k.startsWith(`${prefix}:`)).map(([, d]) => d);

// Change connector docs in place (e.g. the AI-access switch) without re-syncing or re-scanning.
export function updateExtraDocs(prefix, fn) {
  for (const [k, d] of extraDocs) if (k.startsWith(`${prefix}:`)) fn(d);
}

// ---------- Search ----------
// ISO dates sort as plain strings; localeCompare is far too slow across a six-figure file list.
const newerFirst = (a, b) => (a < b ? 1 : a > b ? -1 : 0);
const tokenize = (s) => (s || "").toLowerCase().split(/[^a-z0-9\-]+/).filter((t) => t.length > 1);

const same = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();

export function search(query, { type, sourceId, area, folder, limit = 15, agentOnly = false } = {}) {
  const terms = tokenize(query);
  const inFolder = String(folder || "").toLowerCase();
  const results = [];
  for (const d of index.docs) {
    if (agentOnly && !d.agentAccess) continue;
    if (type && d.type !== type) continue;
    if (sourceId && d.sourceId !== sourceId) continue;
    if (area && !same(d.area, area)) continue;
    if (inFolder && !d.relPath.toLowerCase().includes(inFolder)) continue;
    const name = d.relPath.toLowerCase();
    const text = d.text.toLowerCase();
    const metaStr = Object.values(d.meta).join(" ").toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (name.includes(t)) score += 6;
      if (metaStr.includes(t)) score += 4;
      const hits = text.split(t).length - 1;
      score += Math.min(hits, 5);
    }
    if (!terms.length) score = 1;
    if (score > 0) results.push({ doc: d, score });
  }
  results.sort((a, b) => b.score - a.score || newerFirst(a.doc.modified, b.doc.modified));
  return results.slice(0, limit).map(({ doc, score }) => ({ ...summarize(doc), score, snippet: snippet(doc.text, terms) }));
}

function snippet(text, terms) {
  if (!text) return "";
  const lower = text.toLowerCase();
  let pos = -1;
  for (const t of terms) {
    pos = lower.indexOf(t);
    if (pos >= 0) break;
  }
  const start = Math.max(0, pos < 0 ? 0 : pos - 80);
  return text.slice(start, start + 220).replace(/\s+/g, " ").trim();
}

export function summarize(d) {
  return {
    id: d.id, name: d.name, relPath: d.relPath, folder: d.folder, type: d.type, ext: d.ext,
    size: d.size, modified: d.modified, sourceId: d.sourceId, sourceName: d.sourceName,
    sourceType: d.sourceType, textIndexed: d.textIndexed, meta: d.meta, webUrl: d.webUrl,
    area: d.area, category: d.category, categorisedBy: d.categorisedBy,
  };
}

export function listDocs({ type, status, client, sort = "date", limit = 50, agentOnly = false } = {}) {
  let docs = index.docs.filter((d) => (!agentOnly || d.agentAccess) && (!type || d.type === type));
  if (status) {
    const s = status.toLowerCase();
    docs = docs.filter((d) => {
      const st = (d.meta.status || "").toLowerCase();
      if (s === "unpaid" || s === "outstanding") return d.meta.balance > 0;
      if (s === "open" || s === "pending") return /awaiting|draft/.test(st);
      return st.includes(s);
    });
  }
  if (client) {
    const c = client.toLowerCase();
    docs = docs.filter((d) => (d.meta.client || "").toLowerCase().includes(c) || d.relPath.toLowerCase().includes(c));
  }
  const key = (d) => d.meta.date || d.modified;
  if (sort === "amount") docs.sort((a, b) => (b.meta.total || 0) - (a.meta.total || 0));
  else if (sort === "overdue") docs.sort((a, b) => (b.meta.daysOverdue || 0) - (a.meta.daysOverdue || 0));
  else docs.sort((a, b) => newerFirst(String(key(a)), String(key(b))));
  return docs.slice(0, limit).map(summarize);
}

// The documents page: every filter applies together, newest first unless asked otherwise.
// Returns { total, rows } — total is how many match, rows the first `limit` of them.
const KINDS = { pdf: [".pdf"], word: [".doc", ".docx"], excel: [".xls", ".xlsx", ".xlsm", ".csv"], drawing: [".dwg", ".dxf"], image: [".jpg", ".jpeg", ".png", ".heic", ".tif", ".tiff"], email: [".msg", ".eml"] };
// The date a document is listed under: its own date when it states one (an invoice's date), else
// when the file last changed. Dates typed in a document come in any format ("22 June 2026"), so
// they're normalised before sorting; an invoice-register row with no date sorts last, not under
// the day the workbook was saved.
function docDate(d) {
  const own = d.meta.date;
  if (own) {
    if (/^\d{4}-\d{2}-\d{2}/.test(own)) return own;
    const t = Date.parse(own);
    if (!Number.isNaN(t)) {
      const x = new Date(t); // read in local time, so written out from its local parts: no day shift
      return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
    }
  }
  return d.fromRegister ? "" : String(d.modified || "");
}
export function queryDocs({ q, type, status, sourceId, area, category, kind, since, sort, limit = 500 } = {}) {
  const terms = tokenize(q);
  const exts = KINDS[kind];
  const st = (status || "").toLowerCase();
  let rows = [];
  for (const d of index.docs) {
    if (type && d.type !== type) continue;
    if (sourceId && d.sourceId !== sourceId) continue;
    if (area && !same(d.area, area)) continue;
    if (category && !same(d.category, category)) continue;
    if (exts && !exts.includes(d.ext)) continue;
    if (since && docDate(d).slice(0, 10) < since) continue;
    if (st) {
      const s = (d.meta.status || "").toLowerCase();
      if (st === "unpaid" || st === "outstanding" ? !(d.meta.balance > 0) : st === "open" || st === "pending" ? !/awaiting|draft/.test(s) : !s.includes(st)) continue;
    }
    let score = 0;
    if (terms.length) {
      // Every word must appear somewhere: in the name or folder, the extracted fields, or the text.
      const name = d.relPath.toLowerCase();
      const metaStr = Object.values(d.meta).join(" ").toLowerCase();
      const text = d.text.toLowerCase();
      let all = true;
      for (const t of terms) {
        const hit = (name.includes(t) ? 6 : 0) + (metaStr.includes(t) ? 4 : 0) + (text.includes(t) ? 1 : 0);
        if (!hit) { all = false; break; }
        score += hit;
      }
      if (!all) continue;
    }
    rows.push({ d, score });
  }
  const by = {
    relevance: (a, b) => b.score - a.score || newerFirst(docDate(a.d), docDate(b.d)),
    oldest: (a, b) => newerFirst(docDate(b.d), docDate(a.d)),
    name: (a, b) => (a.d.name.toLowerCase() < b.d.name.toLowerCase() ? -1 : 1),
    amount: (a, b) => (b.d.meta.total || 0) - (a.d.meta.total || 0),
    overdue: (a, b) => (b.d.meta.daysOverdue || 0) - (a.d.meta.daysOverdue || 0),
    size: (a, b) => (b.d.size || 0) - (a.d.size || 0),
  };
  rows.sort(by[sort] || ((a, b) => newerFirst(docDate(a.d), docDate(b.d))));
  const total = rows.length;
  rows = rows.slice(0, limit).map(({ d }) => ({ ...summarize(d), ...(terms.length ? { snippet: snippet(d.text, terms) } : {}) }));
  return { total, rows };
}

// The areas and categories files are filed under, with counts, for the documents page's filters:
// [{ area, files, categories: [{ category, files }] }], biggest first.
export function facets() {
  const areas = new Map();
  for (const d of index.docs) {
    if (!d.area) continue;
    let a = areas.get(d.area);
    if (!a) areas.set(d.area, (a = { area: d.area, files: 0, cats: new Map() }));
    a.files++;
    if (d.category) a.cats.set(d.category, (a.cats.get(d.category) || 0) + 1);
  }
  return [...areas.values()].sort((x, y) => y.files - x.files).map(({ area, files, cats }) => ({
    area, files, categories: [...cats].sort((x, y) => y[1] - x[1]).map(([category, n]) => ({ category, files: n })),
  }));
}

export function financials() {
  const quotes = index.docs.filter((d) => d.type === "quote");
  const invoices = index.docs.filter((d) => d.type === "invoice");
  const sum = (arr, f) => arr.reduce((t, d) => t + (f(d) || 0), 0);
  const open = quotes.filter((d) => /awaiting/i.test(d.meta.status || ""));
  const accepted = quotes.filter((d) => /accepted/i.test(d.meta.status || ""));
  const decided = quotes.filter((d) => /accepted|declined/i.test(d.meta.status || ""));
  const unpaid = invoices.filter((d) => d.meta.balance > 0);
  const overdue = invoices.filter((d) => d.meta.status === "Overdue");
  const byClient = {};
  for (const d of unpaid) {
    const c = d.meta.client || "Unknown";
    byClient[c] = (byClient[c] || 0) + d.meta.balance;
  }
  const since = new Date(Date.now() - 90 * 86400000);
  const billed90 = sum(invoices.filter((d) => d.meta.date && new Date(d.meta.date) >= since), (d) => d.meta.total);
  return {
    quotes: { count: quotes.length, open: open.length, openValue: sum(open, (d) => d.meta.total), accepted: accepted.length, winRate: decided.length ? accepted.length / decided.length : null },
    invoices: { count: invoices.length, unpaid: unpaid.length, outstanding: sum(unpaid, (d) => d.meta.balance), overdue: overdue.length, overdueValue: sum(overdue, (d) => d.meta.balance), billedLast90Days: billed90 },
    outstandingByClient: Object.entries(byClient).sort((a, b) => b[1] - a[1]).map(([client, amount]) => ({ client, amount })),
  };
}

export function readDoc(id) {
  const d = index.byId.get(id);
  if (!d) return null;
  return { ...summarize(d), text: d.text };
}
