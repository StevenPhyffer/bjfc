// Generates a realistic (but entirely fictional) set of BJFC business files so the
// demo has something to search. Dates are relative to "today" so the demo never
// looks stale. Run with:  npm run seed   (add --force to regenerate)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "demo-data");

export function seedDemoData({ force = false } = {}) {
  if (fs.existsSync(ROOT) && !force) return false;
  fs.rmSync(ROOT, { recursive: true, force: true });

  // Deterministic PRNG so every seed produces the same business.
  let s = 20050601;
  const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const day = 86400000;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const iso = (d) => d.toISOString().slice(0, 10);
  const daysAgo = (n) => new Date(today.getTime() - n * day);
  const zar = (n) => "R " + n.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/ /g, " ");

  const clients = [
    "Silverbay Property Group (Pty) Ltd", "Thukela Agri Holdings", "Sandhaven Logistics Park (Pty) Ltd",
    "Ridgeview Estates HOA", "Ilanga Mining Services", "Harbourline Developments",
    "Midlands Poultry Co-operative", "Northgate Retail Fund", "Seaview Schools Trust", "Mzansi Bulk Storage (Pty) Ltd",
  ];
  const work = [
    ["Civil Engineering", "Access road upgrade & intersection redesign", ["Topographical survey", "Geometric design", "Pavement design", "Tender documentation"]],
    ["Civil Engineering", "Stormwater management plan", ["Catchment hydrology study", "Attenuation pond design", "Detailed drawings", "Municipal submission"]],
    ["Water Engineering", "Bulk water pipeline (450mm) design", ["Route alignment study", "Hydraulic modelling", "Pipe & valve design", "Construction monitoring"]],
    ["Water Engineering", "2.5 Ml reservoir & pump station", ["Feasibility & sizing", "Structural design", "Mechanical & electrical spec", "Site supervision"]],
    ["Structural Engineering", "Warehouse portal-frame structural design", ["Concept & loading", "Steel design", "Foundation design", "Shop-drawing review"]],
    ["Structural Engineering", "Condition assessment of existing buildings", ["Site inspection", "Non-destructive testing", "Assessment report", "Remedial recommendations"]],
    ["Project Management", "Construction management – residential estate services", ["Contract administration", "Site meetings & minutes", "Payment certification", "Health & safety oversight"]],
    ["Project Management", "Environmental authorisation support", ["Water use licence application", "Specialist coordination", "Public participation support", "Authority liaison"]],
  ];
  const engineers = ["T. Naidoo (Pr Eng)", "S. Mkhize (Pr Tech Eng)", "L. van Wyk (Pr Eng)", "P. Govender (Cand Eng)", "N. Dlamini (Pr CPM)"];

  const write = (rel, content) => {
    const p = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return p;
  };
  const touch = (rel, date) => {
    const p = path.join(ROOT, rel);
    fs.utimesSync(p, date, date);
  };
  const lineItems = (items) => {
    let subtotal = 0;
    const rows = items.map((desc, i) => {
      const amt = Math.round((25000 + rnd() * 240000) / 50) * 50;
      subtotal += amt;
      return `${String(i + 1).padStart(2)}. ${desc.padEnd(38)} ${zar(amt).padStart(16)}`;
    });
    const vat = Math.round(subtotal * 0.15 * 100) / 100;
    return { rows, subtotal, vat, total: subtotal + vat };
  };
  const header = (title) =>
`BJ-FC CONSULTING ENGINEERS
CBI Building, Ground Floor, 635 Peter Mokaba Ridge, Durban, 4001
Tel: +27 31 207 5030 | admin@bjfc.co.za | Level 2 B-BBEE Contributor
==================================================================
${title}
==================================================================`;

  // ---------- Quotes ----------
  const quoteStatuses = ["Awaiting Client Response", "Accepted", "Accepted", "Declined", "Awaiting Client Response", "Draft", "Expired"];
  const quotes = [];
  for (let i = 0; i < 18; i++) {
    const [disc, proj, items] = pick(work);
    const client = clients[i % clients.length];
    const issued = daysAgo(Math.floor(5 + rnd() * 170));
    const status = i < 3 ? "Awaiting Client Response" : pick(quoteStatuses);
    const no = `Q-${issued.getFullYear()}-${String(101 + i).padStart(3, "0")}`;
    const li = lineItems(items);
    const by = pick(engineers);
    quotes.push({ no, client, proj, disc, issued, status, total: li.total });
    const body = `${header("QUOTATION")}
Quote No: ${no}
Date: ${iso(issued)}
Valid Until: ${iso(new Date(issued.getTime() + 30 * day))}
Client: ${client}
Project: ${proj}
Discipline: ${disc}
Prepared By: ${by}
Status: ${status}

SCOPE OF PROFESSIONAL SERVICES
${li.rows.join("\n")}
------------------------------------------------------------------
Subtotal: ${zar(li.subtotal)}
VAT (15%): ${zar(li.vat)}
Total (incl. VAT): ${zar(li.total)}

Notes:
- Fees based on ECSA guideline tariffs, time-based where scope is undefined.
- Disbursements (travel, printing, lab testing) billed at cost + 10%.
- Payment terms: 30 days from date of invoice.
`;
    const folder = i % 3 === 0 ? "BJFC-SRV01/Finance/Quotes" : "Local-PC/Documents/Quotes";
    const rel = `${folder}/${no} ${client.split(" ")[0]} - ${proj.split(" ").slice(0, 3).join(" ")}.txt`;
    write(rel, body);
    touch(rel, issued);
  }

  // ---------- Invoices ----------
  const accepted = quotes.filter((q) => q.status === "Accepted");
  let invNo = 2201;
  for (let i = 0; i < 26; i++) {
    const q = accepted.length ? accepted[i % accepted.length] : quotes[i % quotes.length];
    const issued = daysAgo(Math.floor(2 + rnd() * 150));
    const due = new Date(issued.getTime() + 30 * day);
    const stage = pick(["Stage 1 – Inception", "Stage 2 – Concept & viability", "Stage 3 – Design development", "Stage 4 – Documentation", "Stage 5 – Construction monitoring", "Monthly fee claim"]);
    const amount = Math.round((40000 + rnd() * 380000) / 50) * 50;
    const vat = Math.round(amount * 0.15 * 100) / 100;
    const total = amount + vat;
    const age = (today - due) / day;
    let status;
    if (age > 0) status = rnd() < 0.62 ? "Paid" : "Unpaid";
    else status = rnd() < 0.3 ? "Paid" : "Unpaid";
    const paid = status === "Paid" ? total : 0;
    const no = `INV-${invNo++}`;
    const body = `${header("TAX INVOICE")}
VAT Reg No: 4XXXXXXXXX (demo)
Invoice No: ${no}
Date: ${iso(issued)}
Due Date: ${iso(due)}
Client: ${q.client}
Project: ${q.proj}
Quote Ref: ${q.no}
Description: ${stage}
Status: ${status}

Professional fees – ${stage}             ${zar(amount).padStart(16)}
------------------------------------------------------------------
Subtotal: ${zar(amount)}
VAT (15%): ${zar(vat)}
Total (incl. VAT): ${zar(total)}
Amount Paid: ${zar(paid)}
Balance Due: ${zar(total - paid)}

Banking details: BJ-FC Consulting Engineers | (demo account) | Ref: ${no}
`;
    const folder = i % 2 === 0 ? "BJFC-SRV01/Finance/Invoices" : "Local-PC/Documents/Invoices";
    const rel = `${folder}/${no} ${q.client.split(" ")[0]}.txt`;
    write(rel, body);
    touch(rel, issued);
  }

  // ---------- Project reports / minutes / registers ----------
  const reports = [
    ["BJFC-SRV01/Projects/Sandhaven Logistics Park/Stormwater Design Report.md", `# Stormwater Design Report – Sandhaven Logistics Park

**Client:** Sandhaven Logistics Park (Pty) Ltd
**Engineer:** L. van Wyk (Pr Eng)
**Revision:** C – issued for municipal approval

## Summary
The 38 ha site drains toward the north-east boundary. Post-development peak flow for the 1:50 year storm increases from 4.2 m³/s to 7.9 m³/s. Two attenuation ponds (combined 11,400 m³) reduce outflow to pre-development levels.

## Key design parameters
- Rational method for sub-catchments < 15 km²; SCS-SA for the overall catchment
- Runoff coefficient (paved yard areas): 0.90
- Pipe sizes: 450 mm – 1200 mm Class 100D concrete
- Freeboard on ponds: 500 mm

## Risks / open items
1. Geotechnical report recommends lining Pond B due to dispersive soils.
2. Municipality requested an additional emergency spillway check (1:100 year).
`],
    ["BJFC-SRV01/Projects/Thukela Agri/Bulk Water Pipeline - Hydraulic Model Notes.md", `# Bulk Water Pipeline – Hydraulic Model Notes

**Client:** Thukela Agri Holdings
**Engineer:** T. Naidoo (Pr Eng)

- Length: 7.4 km, 450 mm uPVC Class 12 / steel at river crossing
- Design demand: 68 l/s (peak), future 95 l/s
- Static head at low point: 112 m – pressure-reducing valve proposed at chainage 4+200
- Surge analysis: air valves at 9 high points; surge vessel not required at current demand
- Estimated construction cost: R 38.6 million (excl. VAT, 2026 rates)

**Action:** Confirm servitude registration with landowners before tender.
`],
    ["BJFC-SRV01/Projects/Ridgeview Estates/Site Meeting Minutes 07.md", `# Site Meeting No. 7 – Ridgeview Estates Services

Present: N. Dlamini (BJFC), Contractor's agent, Client representative
Programme status: **9 working days behind** (wet weather)

1. Sewer reticulation 82% complete. Manhole MH-34 to be re-cast (honeycombing).
2. Road layer works: G5 sub-base on Road 3 approved by lab results.
3. Health & safety: one incident (minor laceration) – toolbox talk held.
4. Payment certificate No. 6 recommended: R 2,418,300.00 (excl. VAT).
5. Next meeting: two weeks from today.
`],
    ["Local-PC/Documents/Admin/Fee Register 2026.csv", `Project,Client,Discipline,Fee Budget (excl VAT),Invoiced to Date,Percent Invoiced,Lead
Stormwater management plan,Sandhaven Logistics Park (Pty) Ltd,Civil Engineering,1240000,860000,69%,L. van Wyk
Bulk water pipeline design,Thukela Agri Holdings,Water Engineering,2150000,1120000,52%,T. Naidoo
Residential estate services,Ridgeview Estates HOA,Project Management,1780000,1495000,84%,N. Dlamini
Warehouse portal-frame design,Mzansi Bulk Storage (Pty) Ltd,Structural Engineering,640000,210000,33%,S. Mkhize
Condition assessment,Seaview Schools Trust,Structural Engineering,385000,385000,100%,P. Govender
Access road upgrade,Northgate Retail Fund,Civil Engineering,920000,140000,15%,L. van Wyk
`],
    ["Local-PC/Documents/Admin/Staff Professional Registrations.csv", `Name,Registration,Body,Number,Renewal Due
T. Naidoo,Professional Engineer,ECSA,20XXXXXX (demo),2027-02-28
S. Mkhize,Professional Engineering Technologist,ECSA,20XXXXXX (demo),2026-11-30
L. van Wyk,Professional Engineer,ECSA,20XXXXXX (demo),2026-10-31
P. Govender,Candidate Engineer,ECSA,20XXXXXX (demo),2027-06-30
N. Dlamini,Professional Construction Project Manager,SACPCMP,XXXX (demo),2026-12-15
`],
    ["Local-PC/Desktop/Notes - things to follow up.txt", `- Chase Harbourline about the outstanding quote (they said "end of month")
- PI insurance renewal – broker sending updated schedule
- Ask IT about the server backup warnings on the NAS
- B-BBEE certificate verification due early next year
- CESA conference registration
`],
    ["BJFC-SRV01/HR/Policies/Leave Policy.md", `# Leave Policy (summary)

- Annual leave: 18 working days per cycle
- Sick leave: 30 days per 3-year cycle (BCEA)
- Family responsibility leave: 3 days per year
- Leave requests via line manager at least 2 weeks in advance for > 3 days
`],
  ];
  for (const [rel, content] of reports) write(rel, content);

  // Placeholder engineering drawings (binary files are indexed by name only).
  for (const d of ["SDN-C-101 Stormwater Layout Rev C.pdf", "SDN-C-102 Pond Sections Rev B.pdf", "TAH-W-201 Pipeline Long Section.dwg"]) {
    write(`BJFC-SRV01/Projects/Drawings/${d}`, "%DEMO PLACEHOLDER – drawing file\n");
  }
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const made = seedDemoData({ force: process.argv.includes("--force") });
  console.log(made ? `Demo data written to ${ROOT}` : "Demo data already exists (use --force to regenerate).");
}
