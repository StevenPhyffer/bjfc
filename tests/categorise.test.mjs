// Area and category from content, with the name and folder as weaker evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { categorise, AREAS } from "../lib/categorise.js";

const cat = (relPath, text = "", projects) => { const c = categorise({ relPath, text, projects }); return `${c.area} › ${c.category} (${c.by})`; };

test("content decides, wherever the file was left", () => {
  assert.equal(cat("Documents/BJFC Admin/Sharon_Temporary Folder/scan0042.pdf", "PAYSLIP\nEmployee: T Naidoo\nBasic salary 25 000\nPAYE 4 100  UIF 177"), "Human Resources › Payroll (content)");
  assert.equal(cat("Documents/BJFC Projects/Misc/doc1.pdf", "LEASE AGREEMENT between the Landlord and the Tenant for the premises at 12 Main Rd"), "Legal & Contracts › Leases (content)");
  assert.equal(cat("Documents/BJFC Admin/New folder/letter.docx", "SARS Tax Compliance Status — income tax return ITR14 assessed"), "Finance › Tax (content)");
});

test("without text, the name and folder decide — and it says so", () => {
  assert.equal(cat("Documents/BJFC Admin/BJ-FC Human Resources/Leave/Annual leave form.docx"), "Human Resources › Leave (name)");
  assert.equal(cat("Documents/BJFC Admin/BJ-FC Legal Matters/Summons 2024.pdf"), "Legal & Contracts › Disputes & litigation (name)");
  assert.equal(cat("Documents/BJFC Admin/BJ-FC Business Development/Tenders Submitted/2026/Amajuba/SBD4.pdf"), "Tenders & Business Development › Tenders (name)");
  assert.equal(cat("Documents/BJFC_Accounts/Monthly Accounts/Oct.xlsx"), "Finance › Accounts & budgets (name)");
  assert.equal(cat("Documents/x/y.bin"), "Other › Uncategorised (name)");
});

test("a known project code, in the folder or in the text, files it under that project", () => {
  const projects = new Map([["ETH11", "ETH11 - Illovo Fire Station"], ["DOT86", "DOT86"]]);
  const proj = (relPath, text = "") => { const c = categorise({ relPath, text, projects }); return `${c.area} › ${c.category} › ${c.project}`; };
  assert.equal(proj("Documents/BJFC Projects/ETH11 - Illovo Fire Station/04 Drawings/GA.dwg"), "Projects › Drawings › ETH11");
  assert.equal(proj("Documents/BJFC Admin/Sharon_Temporary Folder/minutes.docx", "Site meeting no 4 — ETH 11 Illovo Fire Station. Contractor reported progress."), "Projects › Site meetings & instructions › ETH11");
  assert.equal(proj("Documents/BJFC Projects/DoT KZN/DoT Maintenance Projects/DOT86_Newcastle/Payment certificate 3.pdf"), "Projects › Payment certificates & claims › DOT86");
  assert.equal(categorise({ relPath: "Documents/BJFC Admin/BJ-FC Human Resources/Leave/form.docx", projects }).project, undefined);
  assert.equal(cat("Documents/BJFC Projects/BJ-FC Library/SANS 1200.pdf", "", projects).split(" › ")[0], "Projects");
});

test("every area a rule can give is a listed area", () => {
  for (const p of ["a/payslip.pdf", "a/invoice.pdf", "a/lease.pdf", "a/tender.pdf", "a/qms.pdf", "a/site meeting.pdf", "a/brochure.pdf", "a/vodacom.pdf", "a/cipc.pdf", "a/personal/x.pdf", "a/zzz.bin"]) {
    assert.ok(AREAS.includes(categorise({ relPath: p }).area), p);
  }
});
