// Invoice register: the accounts team's "schedule of invoices" workbook, one row per invoice
// (number, date, project, description, amount, VAT, total, date of payment). It is the source of
// the dashboard's debtor figures — a row with a total and no payment date is an unpaid invoice.
import { xlsxSheets } from "./extract.js";

const DAY = 86400000;
const HEADERS = {
  number: /^inv(oice)?\.?\s*(no|num|#)/i,
  paid: /date\s*(of)?\s*(pmt|payment|paid)|^paid/i,
  date: /^(invoice\s*)?date$|^date\s*(submitted|issued)/i,
  project: /^proj/i,
  description: /^(desc|details)/i,
  amount: /^amount/i,
  vat: /^vat/i,
  total: /total/i,
};

const num = (v) => {
  const s = String(v ?? "").replace(/[R\s,]/g, "");
  const n = Number(s);
  return s && Number.isFinite(n) ? n : null;
};

// Excel serial (days since 1899-12-30) or typed text like 19.10.2026 / 19/10/2026 → "2026-10-19".
export function cellDate(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  let d;
  if (/^\d+(\.\d+)?$/.test(s)) {
    if (Number(s) < 20000 || Number(s) > 80000) return null; // 1954 … 2119: anything else isn't a date
    d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * DAY);
  } else {
    const m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
    if (!m) return null;
    d = new Date(Date.UTC(m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]), Number(m[2]) - 1, Number(m[1])));
    if (d.getUTCDate() !== Number(m[1])) return null; // 31.02.2026
  }
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// The header row is the first one (near the top) with an invoice-number and a payment-date column.
function findColumns(rows) {
  for (const row of rows.slice(0, 15)) {
    const cols = {};
    for (const [col, val] of Object.entries(row)) {
      if (col === "r") continue;
      const key = Object.keys(HEADERS).find((k) => !(k in cols) && HEADERS[k].test(String(val).trim()));
      if (key) cols[key] = col;
    }
    if (cols.number && cols.paid) return { cols, headerRow: row.r };
  }
  return null;
}

function readSheet(sheet, { termsDays, today }) {
  const found = findColumns(sheet.rows);
  if (!found) return null;
  const { cols, headerRow } = found;
  const invoices = [];
  for (const row of sheet.rows) {
    if (row.r <= headerRow) continue;
    const number = String(row[cols.number] ?? "").trim();
    if (!/^[A-Za-z]{1,5}[- ]?\d{3,}$/.test(number)) continue; // totals, notes, blank lines
    const amount = num(row[cols.amount]);
    const total = num(row[cols.total]) ?? (amount != null ? amount + (num(row[cols.vat]) || 0) : null);
    if (!total) continue; // numbers reserved for invoices not raised yet
    const date = cellDate(row[cols.date]);
    const paidDate = cellDate(row[cols.paid]);
    const dueDate = date ? new Date(Date.parse(date) + termsDays * DAY).toISOString().slice(0, 10) : null;
    const inv = {
      row: row.r, number, date, dueDate, paidDate,
      project: String(row[cols.project] ?? "").trim(), description: String(row[cols.description] ?? "").trim(),
      amount, total: Math.round(total * 100) / 100, balance: paidDate ? 0 : Math.round(total * 100) / 100,
      status: paidDate ? "Paid" : "Unpaid",
    };
    if (!paidDate && dueDate && Date.parse(dueDate) < today) {
      inv.status = "Overdue";
      inv.daysOverdue = Math.floor((today - Date.parse(dueDate)) / DAY);
    }
    invoices.push(inv);
  }
  return { sheet: sheet.name, invoices };
}

// Returns { sheet, invoices } for the current register sheet: the named one, or — a workbook
// keeps a sheet per period — the one holding the most recent invoice. null if none looks like one.
export function parseInvoiceRegister(buf, { sheet, termsDays = Number(process.env.INVOICE_TERMS_DAYS) || 30, today = Date.now() } = {}) {
  const read = xlsxSheets(buf)
    .filter((s) => !sheet || s.name.trim().toLowerCase() === String(sheet).trim().toLowerCase())
    .map((s) => readSheet(s, { termsDays, today }))
    .filter((s) => s?.invoices.length);
  if (!read.length) return null;
  const latest = (s) => s.invoices.reduce((m, i) => (i.date && i.date > m ? i.date : m), "");
  return read.reduce((best, s) => (latest(s) > latest(best) ? s : best));
}
