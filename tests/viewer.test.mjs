// The viewer: which files can be shown in the Command Centre, and as what.
import { test } from "node:test";
import assert from "node:assert/strict";
import { viewKind, viewMime } from "../lib/viewer.js";

const sp = (ext, extra = {}) => ({ sourceType: "sharepoint", remote: { driveId: "d", itemId: "i" }, ext, size: 1000, ...extra });
const pc = (ext, extra = {}) => ({ sourceType: "folder", path: `/data/file${ext}`, ext, size: 1000, ...extra });

test("PDFs and pictures are shown as they are, from SharePoint or the office PC", () => {
  assert.deepEqual([".pdf", ".PDF", ".jpg", ".png"].map((e) => viewKind(sp(e))), ["pdf", "pdf", "image", "image"]);
  assert.deepEqual([".pdf", ".jpeg"].map((e) => viewKind(pc(e))), ["pdf", "image"]);
  assert.equal(viewMime(sp(".JPG")), "image/jpeg");
  assert.equal(viewMime(sp(".pdf")), "application/pdf");
});

test("Office files are shown as a PDF copy, only where SharePoint can make one", () => {
  assert.deepEqual([".docx", ".xlsx", ".pptx", ".doc"].map((e) => viewKind(sp(e))), ["office", "office", "office", "office"]);
  assert.equal(viewMime(sp(".docx")), "application/pdf");
  assert.equal(viewKind(pc(".docx")), null);
});

test("nothing else is shown: drawings, web pages, register rows, huge files, files with no location", () => {
  for (const d of [sp(".dwg"), sp(".html"), sp(".svg"), pc(".svg"), sp(".xlsx", { fromRegister: true }), sp(".pdf", { size: 500 * 1024 * 1024 }), sp(".pdf", { remote: undefined }), pc(".pdf", { path: "" }), null]) assert.equal(viewKind(d), null);
});
