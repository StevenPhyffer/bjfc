// The documents page query: filters combine and the newest come first.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bjfc-idx-"));
process.env.DEMO_DATA = "off";
const idx = await import("../lib/indexer.js");

const doc = (id, name, modified, extra = {}) => ({
  id, name, relPath: `Docs/${extra.folder || "Projects"}/${name}`, folder: `Docs/${extra.folder || "Projects"}`, ext: name.slice(name.lastIndexOf(".")).toLowerCase(), size: extra.size || 10,
  modified, sourceId: extra.sourceId || "sp1", sourceName: "SharePoint – BJFC", sourceType: "sharepoint", agentAccess: true, type: extra.type || "other", text: extra.text || "", textIndexed: Boolean(extra.text), meta: extra.meta || {},
});
idx.setExtraDocs("t", [
  doc("a", "Stormwater report.pdf", "2026-03-01T10:00:00Z", { text: "Pond sizing for Sandhaven" }),
  doc("b", "Stormwater layout.dwg", "2026-11-20T10:00:00Z"),
  doc("c", "Pond sections.pdf", "2025-06-01T10:00:00Z", { text: "stormwater pond sections", size: 900 }),
  doc("d", "Minutes 07.docx", "2026-11-24T10:00:00Z", { sourceId: "sp2" }),
  doc("i1", "IN002373", "2026-11-24T10:00:00Z", { type: "invoice", meta: { number: "IN002373", date: "2026-10-19", status: "Overdue", total: 2300, balance: 2300, daysOverdue: 7 } }),
  doc("i2", "IN002378", "2026-11-24T10:00:00Z", { type: "invoice", meta: { number: "IN002378", date: "2026-11-16", status: "Unpaid", total: 575, balance: 575 } }),
  doc("i3", "IN002372", "2026-11-24T10:00:00Z", { type: "invoice", meta: { number: "IN002372", date: "2026-09-15", status: "Paid", total: 1150, balance: 0 } }),
]);
const ids = (o) => idx.queryDocs(o).rows.map((d) => d.id);

test("newest first by default — invoices by invoice date, files by date changed", () => {
  assert.deepEqual(ids({ type: "other" }), ["d", "b", "a", "c"]);
  assert.deepEqual(ids({ type: "invoice" }), ["i2", "i1", "i3"]);
  assert.deepEqual(ids({ type: "invoice", sort: "oldest" }), ["i3", "i1", "i2"]);
  assert.deepEqual(ids({ type: "invoice", sort: "amount" }), ["i1", "i3", "i2"]);
});

test("a search needs every word, in the name, the fields or the text, and still lists newest first", () => {
  assert.deepEqual(ids({ q: "stormwater" }), ["b", "a", "c"]);
  assert.deepEqual(ids({ q: "stormwater pond" }), ["a", "c"]);
  assert.deepEqual(ids({ q: "stormwater pond", sort: "relevance" }), ["c", "a"], "best match: both words in the name or folder beats one");
  assert.equal(idx.queryDocs({ q: "pond" }).rows[0].snippet, "Pond sizing for Sandhaven");
  assert.deepEqual(ids({ q: "IN002378" }), ["i2"]);
});

test("filters apply together: status, location, file kind, period", () => {
  assert.deepEqual(ids({ type: "invoice", status: "unpaid" }), ["i2", "i1"]);
  assert.deepEqual(ids({ type: "invoice", status: "overdue", sort: "overdue" }), ["i1"]);
  assert.deepEqual(ids({ type: "invoice", status: "unpaid", q: "IN002373" }), ["i1"]);
  assert.deepEqual(ids({ sourceId: "sp2" }), ["d"]);
  assert.deepEqual(ids({ kind: "pdf" }), ["a", "c"]);
  assert.deepEqual(ids({ kind: "pdf", since: "2026-01-01" }), ["a"]);
  assert.deepEqual(ids({ since: "2026-11-01", type: "invoice" }), ["i2"], "period uses the invoice date");
  assert.deepEqual(ids({ kind: "pdf", sort: "size" }), ["c", "a"]);
});

test("reports how many match when the list is cut off", () => {
  const r = idx.queryDocs({ limit: 2 });
  assert.equal(r.total, 7);
  assert.equal(r.rows.length, 2);
});

test("typed dates in any format sort correctly, and an undated register row goes last", () => {
  idx.setExtraDocs("u", [
    doc("q1", "Quote A.pdf", "2026-10-29T08:00:00Z", { type: "quote", meta: { date: "22 June 2026" } }),
    doc("q2", "Quote B.pdf", "2026-10-02T08:00:00Z", { type: "quote" }),
    Object.assign(doc("q3", "IN002400", "2026-11-24T10:00:00Z", { type: "quote", meta: { number: "IN002400" } }), { fromRegister: true }),
  ]);
  assert.deepEqual(ids({ type: "quote" }), ["q2", "q1", "q3"]);
  assert.deepEqual(ids({ type: "quote", since: "2026-07-01" }), ["q2"]);
  idx.setExtraDocs("u", []);
});

test("area and category filter the list, and the facets count them", () => {
  idx.setExtraDocs("cat", [
    { ...doc("h1", "Payslip Jan.pdf", "2026-01-31T10:00:00Z"), area: "Human Resources", category: "Payroll" },
    { ...doc("h2", "Leave form.docx", "2026-02-01T10:00:00Z"), area: "Human Resources", category: "Leave" },
    { ...doc("p1", "GA.dwg", "2026-02-02T10:00:00Z"), area: "Projects", category: "ETH11 - Illovo Fire Station" },
  ]);
  assert.deepEqual(ids({ area: "Human Resources" }), ["h2", "h1"]);
  assert.deepEqual(ids({ area: "human resources", category: "Payroll" }), ["h1"]);
  assert.deepEqual(idx.facets().map((a) => [a.area, a.files, a.categories.map((c) => c.category)]), [["Human Resources", 2, ["Payroll", "Leave"]], ["Projects", 1, ["ETH11 - Illovo Fire Station"]]]);
  assert.deepEqual(idx.search("form", { area: "Human Resources", folder: "docs/projects" }).map((d) => d.id), ["h2"]);
  idx.setExtraDocs("cat", []);
});
