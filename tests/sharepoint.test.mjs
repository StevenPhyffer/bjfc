// SharePoint connector + text extraction. Graph is faked by replacing global fetch.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bjfc-sp-"));
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
