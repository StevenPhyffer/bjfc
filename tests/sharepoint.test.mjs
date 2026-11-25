// SharePoint connector + text extraction. Graph is faked by replacing global fetch.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bjfc-sp-"));
process.env.SHAREPOINT_RETRY_MS = "1";
const FIX = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures");
const { extractText, readZip } = await import("../lib/extract.js");
const sp = await import("../lib/sharepoint.js");

// Minimal zip writer for test files (stored or deflated entries).
function zip(files, deflate = true) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content);
    const data = deflate ? zlib.deflateRawSync(raw) : raw;
    const n = Buffer.from(name);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(deflate ? 8 : 0, 8); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(deflate ? 8 : 0, 10); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    locals.push(h, n, data); centrals.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Object.keys(files).length, 8); e.writeUInt16LE(Object.keys(files).length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, e]);
}

const XLSX = zip({
  "xl/workbook.xml": `<workbook><sheets><sheet name="Invoices" sheetId="1"/><sheet name="Notes &amp; Terms" sheetId="2"/></sheets></workbook>`,
  "xl/sharedStrings.xml": `<sst><si><t>Invoice No</t></si><si><t>Client</t></si><si><r><t>Harbour</t></r><r><t>line</t></r></si></sst>`,
  "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1"><v>12500.5</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>INV-2026-101</t></is></c><c r="B2" t="s"><v>2</v></c></row></sheetData></worksheet>`,
  "xl/worksheets/sheet2.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>30 days</t></is></c></row></sheetData></worksheet>`,
});
const PPTX = zip({
  "ppt/slides/slide2.xml": `<p:sld><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:sld>`,
  "ppt/slides/slide1.xml": `<p:sld><a:p><a:r><a:t>Project &lt;Kickoff&gt;</a:t></a:r></a:p></p:sld>`,
}, false);

test("extracts Word text (real .docx from macOS textutil)", async () => {
  const t = await extractText(fs.readFileSync(path.join(FIX, "inv.docx")), ".docx");
  assert.match(t, /^TAX INVOICE\nInvoice No: INV-2026-101\nClient: Harbourline Developments\n/);
});

test("extracts PDF text (real .pdf from macOS cupsfilter)", async () => {
  const t = await extractText(fs.readFileSync(path.join(FIX, "inv.pdf")), ".pdf");
  assert.match(t, /Invoice No: INV-2026-101/);
  assert.match(t, /Client: Harbourline Developments/);
});

test("extracts Excel rows per sheet, shared + inline strings, numbers", async () => {
  const t = await extractText(XLSX, ".xlsx");
  assert.equal(t, "## Invoices\nInvoice No\tClient\t12500.5\nINV-2026-101\tHarbourline\n## Notes & Terms\n30 days");
});

test("extracts PowerPoint slides in order, stored (uncompressed) entries, entities decoded", async () => {
  assert.equal(await extractText(PPTX, ".pptx"), "## Slide 1\nProject <Kickoff>\n\n## Slide 2\nSecond");
});

test("not-a-zip and unknown types fail safely", async () => {
  await assert.rejects(extractText(Buffer.from("hello"), ".docx"), /not a zip/);
  assert.equal(await extractText(Buffer.from("x"), ".dwg"), "");
  assert.throws(() => readZip(Buffer.alloc(10)), /not a zip/);
});

// ---------------- Graph fake ----------------
const DOCX = fs.readFileSync(path.join(FIX, "inv.docx"));
const PDF = fs.readFileSync(path.join(FIX, "inv.pdf"));
let calls, files, fail;
const item = (id, name, folder, extra = {}) => ({ id, name, size: 1000, lastModifiedDateTime: "2026-11-01T00:00:00Z", webUrl: `https://bjfc1.sharepoint.com/${name}`, file: {}, parentReference: { path: `/drives/d1/root:${folder}` }, ...extra });

beforeEach(() => {
  calls = [];
  fail = {};
  files = {
    a: { meta: item("a", "Invoice 101.docx", "/Finance/Invoices"), body: DOCX },
    b: { meta: item("b", "Report.pdf", ""), body: PDF },
    c: { meta: item("c", "Site plan.dwg", "/Drawings"), body: Buffer.from("binary") },
    big: { meta: item("big", "Huge.pdf", "", { size: 100 * 1024 * 1024 }), body: PDF },
  };
  process.env.ENTRA_TENANT_ID = "tenant-1";
  process.env.ENTRA_CLIENT_ID = "client-1";
  Object.assign(process.env, { ENTRA_CLIENT_SECRET: "test" });
  globalThis.fetch = async (url, opts = {}) => {
    url = String(url);
    calls.push({ url, opts });
    const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers });
    if (url.includes("login.microsoftonline.com")) {
      const body = new URLSearchParams(opts.body);
      return json({ access_token: `tok-${body.get("client_id")}-${body.get("client_secret")}`, expires_in: 3600 });
    }
    if (url.endsWith("/sites/bjfc1.sharepoint.com:/sites/Projects")) return json({ id: "site-1", displayName: "BJFC Projects" });
    if (url.endsWith("/sites/site-1/drives")) return json({ value: [{ id: "d1", name: "Documents" }] });
    if (url.includes("/drives/d1/root/delta") && !url.includes("page=2")) {
      return json({ value: [files.a.meta, { id: "f", name: "Finance", folder: {} }, files.b.meta], "@odata.nextLink": "https://graph.microsoft.com/v1.0/drives/d1/root/delta?page=2" });
    }
    if (url.includes("page=2")) {
      if (fail.throttleOnce) { fail.throttleOnce = false; return json({}, 429, { "retry-after": "0" }); }
      return json({ value: [files.c.meta, files.big.meta, { id: "gone", name: "Old.docx", file: {}, deleted: {} }], "@odata.deltaLink": "…" });
    }
    const m = url.match(/\/drives\/d1\/items\/(\w+)\/content$/);
    if (m) {
      if (fail[m[1]]) return json({ error: { message: "locked" } }, 423);
      return new Response(files[m[1]].body);
    }
    return json({ error: { message: `unexpected ${url}` } }, 404);
  };
});

const SITE = { id: "s1", siteUrl: "https://bjfc1.sharepoint.com/sites/Projects", displayName: "BJFC Projects", agentAccess: true };
const downloads = () => calls.filter((c) => c.url.endsWith("/content")).map((c) => c.url.match(/items\/(\w+)\//)[1]).sort();

test("sync walks every delta page and extracts text from Office and PDF files", async () => {
  fail.throttleOnce = true; // a 429 with Retry-After is retried, not fatal
  const { docs, errors } = await sp.syncLibrary(SITE);
  assert.deepEqual(errors, []);
  assert.deepEqual(docs.map((d) => d.relPath).sort(), ["Documents/Drawings/Site plan.dwg", "Documents/Finance/Invoices/Invoice 101.docx", "Documents/Huge.pdf", "Documents/Report.pdf"]);
  const inv = docs.find((d) => d.name === "Invoice 101.docx");
  assert.equal(inv.type, "invoice");
  assert.equal(inv.meta.number, "INV-2026-101");
  assert.equal(inv.meta.client, "Harbourline Developments");
  assert.equal(inv.meta.total, 12500);
  assert.equal(inv.folder, "Documents/Finance/Invoices");
  assert.equal(inv.sourceType, "sharepoint");
  assert.match(docs.find((d) => d.name === "Report.pdf").text, /INV-2026-101/);
  assert.equal(docs.find((d) => d.name === "Site plan.dwg").textIndexed, false);
  assert.equal(docs.find((d) => d.name === "Huge.pdf").textIndexed, false);
  assert.deepEqual(downloads(), ["a", "b"], "only extractable files under the size cap are downloaded");
});

test("uses the app's ENTRA_* credentials unless the site has its own", async () => {
  await sp.syncLibrary(SITE);
  const auth = calls.find((c) => c.url.includes("/sites/")).opts.headers.Authorization;
  assert.equal(auth, "Bearer tok-client-1-test");

  calls = [];
  await sp.syncLibrary({ ...SITE, id: "s2", tenantId: "t-own", clientId: "c-own", clientSecret: "test2" });
  assert.match(calls.find((c) => c.url.includes("login.microsoftonline.com")).url, /\/t-own\//);
  assert.equal(calls.find((c) => c.url.includes("/sites/")).opts.headers.Authorization, "Bearer tok-c-own-test2");
});

test("no credentials anywhere → clear error", () => {
  delete process.env.ENTRA_CLIENT_SECRET;
  assert.equal(sp.appCredentialsAvailable(), false);
  assert.throws(() => sp.credsFor(SITE), /No Microsoft app credentials/);
});

test("re-sync only downloads files that changed", async () => {
  const site = { ...SITE, id: "s3" };
  await sp.syncLibrary(site);
  calls = [];
  files.b.meta = { ...files.b.meta, lastModifiedDateTime: "2026-11-19T00:00:00Z" };
  const { docs } = await sp.syncLibrary(site);
  assert.deepEqual(downloads(), ["b"]);
  assert.match(docs.find((d) => d.name === "Invoice 101.docx").text, /INV-2026-101/, "unchanged file keeps its cached text");
});

test("one unreadable file is reported, the rest still sync", async () => {
  fail.a = true;
  const { docs, errors } = await sp.syncLibrary({ ...SITE, id: "s4" });
  assert.equal(docs.length, 4);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^Documents\/Finance\/Invoices\/Invoice 101\.docx: locked/);
});

test("site not granted (403) explains Sites.Selected", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => (String(url).includes("/sites/bjfc1") ? new Response(JSON.stringify({ error: { message: "Access denied" } }), { status: 403 }) : real(url, opts));
  await assert.rejects(sp.testConnection(SITE), /Access denied — .*Sites\.Selected/);
});

test("demo sites still work without credentials", async () => {
  delete process.env.ENTRA_CLIENT_SECRET;
  const { docs } = await sp.syncLibrary({ ...SITE, id: "demo", demo: true });
  assert.equal(docs.length, 5);
  assert.ok(docs.some((d) => d.type === "quote"));
});

// ---------------- Invoice register + folder scope ----------------
const { parseInvoiceRegister, cellDate } = await import("../lib/register.js");
const cell = (ref, v) => (v == null ? "" : typeof v === "number" ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`);
const sheetXml = (rows) => `<worksheet><sheetData>${rows.map((r, i) => `<row r="${i + 1}">${r.map((v, c) => cell("ABCDEFGHI"[c] + (i + 1), v)).join("")}</row>`).join("")}</sheetData></worksheet>`;
const HEAD = ["INV No.", "Date", "Proj No.", "Description", "Amount", "Vat Amount ", "Total incl VAT", "Date of Pmt"];
const REGISTER = zip({
  "xl/workbook.xml": `<workbook><sheets><sheet name="2024" sheetId="2" r:id="rId2"/><sheet name="2023" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="3" r:id="rId3"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Target="worksheets/sheet3.xml"/></Relationships>`,
  "xl/worksheets/sheet1.xml": sheetXml([HEAD, ["IN001561", 42808, "DOT59", null, 100, 15, 115, null]]), // old sheet: ignored
  "xl/worksheets/sheet2.xml": sheetXml([
    HEAD,
    ["IN002372", 46280, "ETH12", "BJ-FC 118", 1000, 150, 1150, 46297], // paid
    ["IN002373", "19.10.2026", "DOT86", "Claim 25", 2000, 300, 2300, null], // unpaid, typed date, past terms
    ["IN002378", "16.11.2026", "DOT86", "Claim 26", 500, 75, null, null], // unpaid, total worked out, within terms
    ["IN002379", null, null, null, null, 0, 0, null, "Jul"], // number reserved, nothing raised
    [null, null, null, null, 3500, 525, 4025, null], // totals row
  ]),
  "xl/worksheets/sheet3.xml": sheetXml([["30 days"]]),
});
const TODAY = Date.parse("2026-11-25");

test("dates: Excel serials and typed dd.mm.yyyy", () => {
  assert.equal(cellDate("46280"), "2026-09-15");
  assert.equal(cellDate("19.10.2026"), "2026-10-19");
  assert.equal(cellDate("3/4/25"), "2025-04-03");
  assert.equal(cellDate("31.02.2026"), null);
  assert.equal(cellDate("updated date"), null);
  assert.equal(cellDate("7"), null);
});

test("invoice register: current sheet, paid / unpaid / overdue, skips totals and reserved numbers", () => {
  const reg = parseInvoiceRegister(REGISTER, { today: TODAY, termsDays: 30 });
  assert.equal(reg.sheet, "2024", "the sheet with the newest invoice, found through the workbook's relationships");
  assert.deepEqual(reg.invoices.map((i) => [i.number, i.status, i.balance]), [["IN002372", "Paid", 0], ["IN002373", "Overdue", 2300], ["IN002378", "Unpaid", 575]]);
  const overdue = reg.invoices[1];
  assert.deepEqual([overdue.date, overdue.dueDate, overdue.daysOverdue, overdue.project], ["2026-10-19", "2026-11-18", 7, "DOT86"]);
  assert.equal(reg.invoices[0].paidDate, "2026-10-02");
  assert.equal(parseInvoiceRegister(REGISTER, { sheet: "2023", today: TODAY }).invoices[0].number, "IN001561");
  assert.equal(parseInvoiceRegister(XLSX), null, "an ordinary workbook is not a register");
});

test("limited to folders: walks only those, and register rows become invoices", async () => {
  const real = globalThis.fetch;
  const reg = item("reg", "Schedule of Invoices.xlsx", "/Accounts/Admin");
  const quote = item("q1", "Quote A.pdf", "/Admin/Quotations/Client A");
  const tree = { "admin/quotations": { id: "fq", folder: {} }, "accounts/admin/schedule of invoices.xlsx": reg }; // SharePoint paths ignore case
  const children = { fq: [{ id: "fa", name: "Client A", folder: {} }], fa: [quote] };
  globalThis.fetch = async (url, opts) => {
    const u = decodeURIComponent(String(url));
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
    let m;
    if ((m = u.match(/\/drives\/d1\/root:\/(.+?)\?/))) { calls.push({ url: u, opts }); return tree[m[1].toLowerCase()] ? json(tree[m[1].toLowerCase()]) : json({ error: { message: "The resource could not be found." } }, 404); }
    if ((m = u.match(/\/drives\/d1\/items\/(\w+)\/children/))) { calls.push({ url: u, opts }); return json({ value: children[m[1]] }); }
    if (u.endsWith("/items/reg/content")) return new Response(REGISTER);
    if (u.endsWith("/items/q1/content")) return new Response(PDF);
    return real(url, opts);
  };
  const site = { ...SITE, id: "s9", folders: ["/Admin/Quotations/", "Missing"], invoiceRegister: "accounts/admin/Schedule of Invoices.xlsx" };
  const { docs, errors } = await sp.syncLibrary(site);
  assert.ok(!calls.some((c) => c.url.includes("/delta")), "no whole-library walk");
  assert.deepEqual(errors, ["Missing: no such folder or file in this site's libraries"]);
  assert.deepEqual(docs.filter((d) => !d.fromRegister).map((d) => d.relPath).sort(), ["Documents/Accounts/Admin/Schedule of Invoices.xlsx", "Documents/Admin/Quotations/Client A/Quote A.pdf"]);
  const inv = docs.filter((d) => d.fromRegister);
  assert.equal(inv.length, 3);
  assert.ok(inv.every((d) => d.type === "invoice" && d.sourceType === "sharepoint" && d.webUrl === reg.webUrl));
  assert.equal(new Set(docs.map((d) => d.id)).size, docs.length, "every doc has its own id");
  const unpaid = inv.find((d) => d.meta.number === "IN002378");
  assert.deepEqual([unpaid.meta.client, unpaid.meta.total, unpaid.meta.balance, unpaid.meta.date], ["DOT86", 575, 575, "2026-11-16"]);
  assert.match(unpaid.text, /Invoice No: IN002378\nDate: 2026-11-16\nProject No: DOT86/);
});

test("folder lists are tidied", () => {
  assert.deepEqual(sp.cleanPaths(" /A/B/ \r\n\nA/B\nC\\D "), ["A/B", "C/D"]);
  assert.deepEqual(sp.cleanPaths(undefined), []);
});

// ---------------- Large libraries ----------------
test("text only for the newest files when SHAREPOINT_TEXT_FILES is set; the rest are listed by name", async () => {
  process.env.SHAREPOINT_TEXT_FILES = "1";
  files.a.meta = { ...files.a.meta, lastModifiedDateTime: "2026-11-20T00:00:00Z" }; // newer than Report.pdf
  try {
    const { docs } = await sp.syncLibrary({ ...SITE, id: "s10" });
    assert.deepEqual(downloads(), ["a"]);
    assert.equal(docs.length, 4);
    assert.equal(docs.find((d) => d.name === "Report.pdf").textIndexed, false);
  } finally {
    delete process.env.SHAREPOINT_TEXT_FILES;
  }
});

test("SHAREPOINT_MAX_FILES caps the listing and says so", async () => {
  process.env.SHAREPOINT_MAX_FILES = "2";
  try {
    const { docs, errors } = await sp.syncLibrary({ ...SITE, id: "s11" });
    assert.equal(docs.length, 2);
    assert.match(errors.join("\n"), /Stopped at 2 files/);
  } finally {
    delete process.env.SHAREPOINT_MAX_FILES;
  }
});

test("extracted text survives a restart (kept on disk), and is removed with the site", async () => {
  const site = { ...SITE, id: "s12" };
  await sp.syncLibrary(site);
  const file = path.join(process.env.DATA_DIR, "sp-cache", "s12.jsonl");
  assert.equal(fs.readFileSync(file, "utf8").trim().split("\n").length, 2, "one line per file with text");
  const fresh = await import("../lib/sharepoint.js?restart"); // a new process: nothing in memory
  calls = [];
  const { docs } = await fresh.syncLibrary(site);
  assert.deepEqual(downloads(), [], "nothing downloaded again");
  assert.match(docs.find((d) => d.name === "Report.pdf").text, /INV-2026-101/);
  fresh.forgetSite(site);
  assert.equal(fs.existsSync(file), false);
});

test("shows results as they come in, and a name with a stray % doesn't stop the sync", async () => {
  files.c.meta = item("c", "100% complete.dwg", "/Drawings/50%25 done/100% final");
  const stages = [];
  const { docs } = await sp.syncLibrary({ ...SITE, id: "s13" }, { onDocs: (d) => stages.push(d.filter((x) => x.textIndexed).length) });
  assert.deepEqual(stages, [0], "first every file by name, before any text is read");
  assert.equal(docs.find((d) => d.name === "100% complete.dwg").folder, "Documents/Drawings/50% done/100% final");
  assert.equal(docs.filter((d) => d.textIndexed).length, 2);
});

test("with a register, only its rows are invoices", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = decodeURIComponent(String(url));
    if (/\/drives\/d1\/root:\/Finance\/Schedule\.xlsx\?/.test(u)) return new Response(JSON.stringify(item("reg", "Schedule.xlsx", "/Finance")));
    if (u.endsWith("/items/reg/content")) return new Response(REGISTER);
    return real(url, opts);
  };
  const stages = [];
  const { docs, errors } = await sp.syncLibrary({ ...SITE, id: "s14", invoiceRegister: "Finance/Schedule.xlsx" }, { onDocs: (d) => stages.push(d.length) });
  assert.deepEqual(errors, []);
  assert.equal(stages[0], 3, "the invoices are shown before the library has been listed");
  assert.deepEqual(docs.filter((d) => d.type === "invoice").map((d) => d.meta.number).sort(), ["IN002372", "IN002373", "IN002378"]);
  assert.equal(docs.find((d) => d.name === "Invoice 101.docx").type, "other");
  assert.equal(docs.filter((d) => d.name === "Schedule.xlsx").length, 1);
});

test("a dropped connection or a 5xx during the listing is retried, not fatal", async () => {
  const real = globalThis.fetch;
  let drops = 2;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("/root/delta") && drops) {
      if (drops-- === 2) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT" } });
      return new Response("{}", { status: 502 });
    }
    return real(url, opts);
  };
  const { docs, errors } = await sp.syncLibrary({ ...SITE, id: "s15" });
  assert.equal(docs.length, 4);
  assert.deepEqual(errors, []);
});
