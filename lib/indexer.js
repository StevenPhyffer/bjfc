// Walks the configured folders (local PC + server shares), reads text-based files,
// classifies them (quote / invoice / report ...) and pulls out business fields so
// the dashboard and the AI agent can answer "show me all unpaid invoices" instantly.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getConfig } from "./config.js";

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

function classify(rel, text) {
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
  return {
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

// ---------- Search ----------
const tokenize = (s) => (s || "").toLowerCase().split(/[^a-z0-9\-]+/).filter((t) => t.length > 1);

export function search(query, { type, sourceId, limit = 15, agentOnly = false } = {}) {
  const terms = tokenize(query);
  const results = [];
  for (const d of index.docs) {
    if (agentOnly && !d.agentAccess) continue;
    if (type && d.type !== type) continue;
    if (sourceId && d.sourceId !== sourceId) continue;
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
  results.sort((a, b) => b.score - a.score || b.doc.modified.localeCompare(a.doc.modified));
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
  else docs.sort((a, b) => String(key(b)).localeCompare(String(key(a))));
  return docs.slice(0, limit).map(summarize);
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
