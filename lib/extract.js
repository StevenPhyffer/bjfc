// Text extraction for indexing: plain text, PDF (unpdf) and Office Open XML (Word, Excel,
// PowerPoint). Office files are zip archives of XML, read here with node:zlib — no extra dependency.
// Legacy binary formats (.doc, .xls, .ppt) and scanned PDFs (no text layer) yield "".
import zlib from "node:zlib";

export const MAX_TEXT = 256 * 1024; // characters kept per file
const MAX_ENTRY = 32 * 1024 * 1024; // uncompressed bytes per zip entry (zip-bomb guard)

const PLAIN = new Set([".txt", ".md", ".csv", ".json", ".log", ".xml", ".html", ".htm", ".tsv"]);
const OFFICE = new Set([".docx", ".xlsx", ".pptx"]);
export const EXTRACTABLE = new Set([...PLAIN, ...OFFICE, ".pdf"]);
export const canExtract = (ext) => EXTRACTABLE.has(String(ext).toLowerCase());

export async function extractText(buf, ext) {
  ext = String(ext).toLowerCase();
  let text = "";
  if (PLAIN.has(ext)) text = buf.toString("utf8");
  else if (ext === ".pdf") text = await pdfText(buf);
  else if (ext === ".docx") text = docxText(readZip(buf));
  else if (ext === ".xlsx") text = xlsxText(readZip(buf));
  else if (ext === ".pptx") text = pptxText(readZip(buf));
  return text.replace(/\u0000/g, "").slice(0, MAX_TEXT);
}

// ---------- PDF ----------
let unpdf;
async function pdfText(buf) {
  unpdf ||= await import("unpdf");
  const { text } = await unpdf.extractText(new Uint8Array(buf), { mergePages: false });
  return (Array.isArray(text) ? text : [text]).join("\n\n").trim();
}

// ---------- Zip (central directory; stored or deflated entries) ----------
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad zip directory");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.set(name, { method, compSize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: () => [...entries.keys()],
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
      const data = buf.subarray(start, start + e.compSize);
      if (e.method === 0) return data.toString("utf8");
      if (e.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY }).toString("utf8");
      throw new Error(`unsupported zip method ${e.method}`);
    },
  };
}

// ---------- XML helpers ----------
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) =>
    e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()]);
const strip = (xml) => decode(xml.replace(/<[^>]+>/g, ""));
const tidy = (s) => s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
const byNumber = (re) => (a, b) => Number(a.match(re)[1]) - Number(b.match(re)[1]);

// Word: paragraphs → lines, tabs and breaks kept, so "Client: X" lines still parse as fields.
function wordXml(xml) {
  return strip(xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:(br|cr)\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/w:tc>/g, "\t"));
}
function docxText(zip) {
  const parts = ["word/document.xml", ...zip.names().filter((n) => /^word\/(header|footer)\d*\.xml$/.test(n)).sort()];
  return tidy(parts.map((n) => zip.read(n)).filter(Boolean).map(wordXml).join("\n"));
}

// Excel: one line per row, cells tab-separated, a "## <sheet>" line before each sheet.
function xlsxText(zip) {
  const shared = [];
  const ss = zip.read("xl/sharedStrings.xml");
  if (ss) for (const si of ss.match(/<si>[\s\S]*?<\/si>/g) || []) shared.push(strip(si.replace(/<rPh[\s\S]*?<\/rPh>/g, "")));
  const wb = zip.read("xl/workbook.xml") || "";
  const sheetNames = [...wb.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => decode(m[1]));
  const sheets = zip.names().filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort(byNumber(/sheet(\d+)\.xml$/));
  const out = [];
  sheets.forEach((name, i) => {
    out.push(`## ${sheetNames[i] || `Sheet ${i + 1}`}`);
    for (const row of zip.read(name).match(/<row\b[\s\S]*?<\/row>/g) || []) {
      const cells = [];
      for (const c of row.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []) {
        const t = (c.match(/\bt="(\w+)"/) || [])[1];
        const v = (c.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        if (t === "s" && v != null) cells.push(shared[Number(v)] ?? "");
        else if (t === "inlineStr") cells.push(strip((c.match(/<is>([\s\S]*?)<\/is>/) || [, ""])[1]));
        else if (v != null) cells.push(decode(v));
      }
      if (cells.some((x) => x !== "")) out.push(cells.join("\t"));
    }
  });
  return tidy(out.join("\n"));
}

// Excel as data: [{ name, rows: [{ r: 12, A: "IN002373", B: "46314", … }] }] in workbook order,
// keyed by column letter so empty cells don't shift the columns (used by lib/register.js).
export function xlsxSheets(buf) {
  const zip = readZip(buf);
  const shared = [];
  const ss = zip.read("xl/sharedStrings.xml");
  if (ss) for (const si of ss.match(/<si>[\s\S]*?<\/si>/g) || []) shared.push(strip(si.replace(/<rPh[\s\S]*?<\/rPh>/g, "")));
  const attr = (tag, name) => (tag.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1];
  const rels = {};
  for (const rel of (zip.read("xl/_rels/workbook.xml.rels") || "").match(/<Relationship\b[^>]*>/g) || []) rels[attr(rel, "Id")] = attr(rel, "Target");
  const out = [];
  for (const sheet of (zip.read("xl/workbook.xml") || "").match(/<sheet\b[^>]*>/g) || []) {
    const target = rels[attr(sheet, "r:id")];
    const xml = target && zip.read(target.startsWith("/") ? target.slice(1) : `xl/${target}`);
    if (!xml) continue; // chart sheets etc.
    const rows = [];
    for (const row of xml.match(/<row\b[\s\S]*?<\/row>/g) || []) {
      const cells = { r: Number(attr(row.slice(0, row.indexOf(">") + 1), "r")) };
      let any = false;
      for (const c of row.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []) {
        const head = c.slice(0, c.indexOf(">") + 1);
        const col = (attr(head, "r") || "").replace(/\d+$/, "");
        const t = attr(head, "t");
        const v = (c.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        let val = "";
        if (t === "s" && v != null) val = shared[Number(v)] ?? "";
        else if (t === "inlineStr") val = strip((c.match(/<is>([\s\S]*?)<\/is>/) || [, ""])[1]);
        else if (v != null) val = decode(v);
        if (col && val !== "") { cells[col] = val; any = true; }
      }
      if (any) rows.push(cells);
    }
    out.push({ name: decode(attr(sheet, "name") || ""), rows });
  }
  return out;
}

// PowerPoint: slide text in slide order.
function pptxText(zip) {
  const slides = zip.names().filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(byNumber(/slide(\d+)\.xml$/));
  return tidy(slides.map((n, i) => `## Slide ${i + 1}\n` + strip(zip.read(n).replace(/<\/a:p>/g, "\n"))).join("\n"));
}
