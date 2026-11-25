// What a file is about: an area (Projects, Finance, Human Resources …) and a category inside it
// (a project, or a kind of document). Decided from the file's content when it has been read, with
// the name and folder as weaker evidence — a payslip left in somebody's temporary folder is still
// Human Resources › Payroll. Rule-based, so it is fast, free and nothing leaves the server.
export const AREAS = ["Projects", "Finance", "Human Resources", "Legal & Contracts", "Tenders & Business Development", "Quality & Compliance", "Marketing", "IT & Equipment", "Company Admin", "Personal", "Other"];

// [area, category, weight, pattern] — tested against the path (file and folder names) and the
// start of the text. Weight says how telling the phrase is; text hits count double.
const RULES = [
  ["Human Resources", "Payroll", 5, /\bpay ?slips?\b|\bsalar(y|ies)\b|\bpayroll\b|\bremuneration\b|\birp ?5\b|\bemp ?[25]01\b|\buif\b|\bp\.?a\.?y\.?e\b|\bwage/],
  ["Human Resources", "Leave", 5, /\b(annual|sick|maternity|family|study|unpaid) leave\b|\bleave (form|application|request|record|balance|schedule)/],
  ["Human Resources", "Employment contracts", 6, /\b(contract|letter|agreement|offer) of (employment|appointment)\b|\bemployment (contract|agreement)\b|\bprobation/],
  ["Human Resources", "CVs & recruitment", 4, /\bcurriculum vitae\b|\bcvs?\b|\brésumé\b|\bresume\b|\binterview\b|\brecruit|\bjob (description|advert|application)\b|\bvacanc/],
  ["Human Resources", "Discipline & performance", 5, /\bdisciplinar|\bgrievance\b|\bwritten warning\b|\bperformance (review|appraisal|agreement)\b|\bdismissal\b|\bccma\b/],
  ["Human Resources", "Training & skills", 3, /\bskills development\b|\btraining\b|\bworkplace skills plan\b|\bwsp\b|\bbursar|\bcpd\b|\bmentorship\b/],
  ["Human Resources", "Timesheets", 4, /\btime ?sheets?\b|\battendance register\b|\bclock(ing)? (in|card)/],
  ["Human Resources", "General", 2, /\bhuman resources\b|\bhr\b|\bemployee\b|\bstaff\b|\bpersonnel\b/],

  ["Finance", "Invoices", 4, /\btax invoice\b|\binvoices?\b|\binv[ -]?(no|num|#)|\bcredit note\b/],
  ["Finance", "Quotations", 4, /\bquotations?\b|\bquotes?\b|\bfee (proposal|estimate)\b/],
  ["Finance", "Statements & banking", 4, /\bbank(ing)? (statement|confirmation|letter)\b|\bstatement of account\b|\bstatements?\b|\bremittance\b|\bproof of payment\b|\bpop\b|\beft\b/],
  ["Finance", "Tax", 5, /\bsars\b|\bvat ?201\b|\bincome tax\b|\btax (return|certificate|clearance|compliance|directive)\b|\bprovisional tax\b|\bitr ?1[24]\b/],
  ["Finance", "Accounts & budgets", 4, /\bmanagement accounts\b|\bfinancial statements\b|\bbudget\b|\bcash ?flow\b|\btrial balance\b|\bgeneral ledger\b|\bdebtors?\b|\bcreditors?\b|\bage analysis\b|\bmonthly accounts\b/],
  ["Finance", "Purchases & disbursements", 3, /\bpurchase order\b|\bdisbursements?\b|\bexpense claim\b|\bpetty cash\b|\breceipts?\b|\bslip\b/],
  ["Finance", "General", 2, /\baccounts\b|\bfinance\b|\baccounting\b/],

  ["Legal & Contracts", "Agreements", 4, /\b(service level|professional services|consultancy|joint venture|shareholders?|members?|sale|loan|settlement|non-?disclosure) agreement\b|\bmemorandum of (agreement|understanding)\b|\bnda\b|\bmou\b|\bpower of attorney\b/],
  ["Legal & Contracts", "Leases", 5, /\blease (agreement|renewal)?\b|\blandlord\b|\btenant\b|\brental agreement\b/],
  ["Legal & Contracts", "Disputes & litigation", 6, /\bsummons\b|\blitigation\b|\bletter of demand\b|\bplaintiff\b|\bdefendant\b|\bhigh court\b|\bmagistrate|\barbitration\b|\battorneys?\b|\badvocate\b|\bnotice of motion\b/],
  ["Legal & Contracts", "Affidavits & declarations", 3, /\baffidavit\b|\bsworn (statement|declaration)\b|\bcommissioner of oaths\b/],
  ["Legal & Contracts", "General", 2, /\blegal\b|\bcontracts?\b|\bagreement\b/],

  ["Tenders & Business Development", "Tenders", 5, /\btenders?\b|\bbids?\b|\brf[qp]\b|\brequest for (quotation|proposal)\b|\bsbd ?\d|\bmbd ?\d|\breturnable (documents|schedules)\b|\bbriefing (session|meeting)\b|\bclosing date\b/],
  ["Tenders & Business Development", "Proposals & profiles", 4, /\bexpression of interest\b|\beoi\b|\bcompany profile\b|\bcapability statement\b|\btechnical proposal\b|\bproposal\b|\btrack record\b|\bproject experience\b/],
  ["Tenders & Business Development", "Supplier registration", 4, /\bcentral supplier database\b|\bcsd\b|\bsupplier (registration|database|application)\b|\bvendor (form|application|registration)\b/],
  ["Tenders & Business Development", "General", 2, /\bbusiness development\b|\bmarketing plan\b|\bprospect/],

  ["Quality & Compliance", "Quality system", 4, /\bqms\b|\biso ?9001\b|\bquality (manual|policy|plan|management|procedure|objectives)\b|\bnon-?conformance\b|\binternal audit\b|\bcorrective action\b|\bprocedures?\b/],
  ["Quality & Compliance", "B-BBEE & employment equity", 5, /\bb-?bbee\b|\bbee (certificate|affidavit|scorecard)\b|\bblack economic empowerment\b|\bemployment equity\b|\beea ?\d/],
  ["Quality & Compliance", "Registrations & good standing", 5, /\becsa\b|\bcesa\b|\bsacpcmp\b|\bprofessional registration\b|\bletter of good standing\b|\bcoida?\b|\bcidb\b|\bcompensation fund\b/],
  ["Quality & Compliance", "Insurance", 4, /\bprofessional indemnity\b|\binsurance\b|\bpolicy schedule\b|\bpublic liability\b|\bbroker\b/],
  ["Quality & Compliance", "Health & safety", 4, /\bhealth (and|&) safety\b|\bohs\b|\bsafety (file|plan)\b|\brisk assessment\b|\bcovid/],
  ["Quality & Compliance", "Policies", 3, /\bpolic(y|ies)\b|\bcode of conduct\b/],

  ["Projects", "Drawings", 5, /\.(dwg|dxf|dwl2?|bak|kc[sd]|pad)$|\bdrawings?\b|\bgeneral arrangement\b|\blayout\b|\bas-?built\b|\bsections?\b.*\bdetails?\b/],
  ["Projects", "Reports & designs", 4, /\b(design|geotechnical|inception|feasibility|preliminary|progress|close-?out|condition|structural|stormwater|traffic|assessment) report\b|\bdesign (calculations?|criteria|basis)\b|\bgeotech/],
  ["Projects", "Site meetings & instructions", 4, /\bsite (meeting|instruction|visit|inspection|handover|diary)\b|\bprogress meeting\b|\bsnag(ging)? list\b|\bpractical completion\b/],
  ["Projects", "Payment certificates & claims", 5, /\bpayment certificate\b|\binterim certificate\b|\bcontractor'?s? claim\b|\bvariation order\b|\bfinal account\b|\bretention\b/],
  ["Projects", "Quantities & specifications", 4, /\bbill of quantities\b|\bboq\b|\bspecifications?\b|\bschedule of quantities\b|\bcontract data\b|\bgcc\b|\bjbcc\b|\bnec ?3\b|\bfidic\b/],
  ["Projects", "Photos", 2, /\.(jpe?g|png|heic|tiff?|mov|mp4)$/],
  ["Projects", "General", 2, /\bprojects?\b|\bcontractor\b|\bengineer'?s? (instruction|representative)\b|\bcivil works\b|\bconstruction\b|\broad\b|\bbridge\b|\bculvert\b|\bearthworks\b|\bwater (supply|reticulation)\b|\bsewer/],

  ["Marketing", "Marketing material", 4, /\bbrochure\b|\bnewsletter\b|\bsocial media\b|\bbrand(ing)?\b|\blogo\b|\badvert|\bflyer\b|\bmarketing\b/],
  ["Marketing", "Website", 4, /\bwebsite\b|\bweb ?page\b|\bdomain\b|\bhosting\b/],

  ["IT & Equipment", "IT & software", 4, /\bsoftware\b|\blicen[cs]e key\b|\bmicrosoft 365\b|\boffice 365\b|\bautocad\b|\bcivil designer\b|\bbackup\b|\bpassword\b|\bantivirus\b|\bit services\b|\bserver\b|\blaptop\b|\bcomputer\b|\bprinter\b/],
  ["IT & Equipment", "Cellphones & telecoms", 5, /\bcell ?phones?\b|\bvodacom\b|\bmtn\b|\btelkom\b|\bcell ?c\b|\bsim card\b|\bairtime\b/],
  ["IT & Equipment", "Equipment & vehicles", 4, /\bequipment\b|\basset register\b|\bvehicles?\b|\blog ?book\b|\bcalibration\b|\bsurvey instrument/],

  ["Company Admin", "Governance", 5, /\bcipc\b|\bcompany registration\b|\bresolution\b|\bdirectors'? meeting\b|\bmembers'? meeting\b|\bcor ?\d\d|\bck ?\d\b|\bshare certificate\b|\bannual return\b/],
  ["Company Admin", "Minutes & memos", 4, /\bmemos?\b|\bmemorandum\b|\b(management|staff|office) meeting\b|\bminutes\b|\bagenda\b/],
  ["Company Admin", "Office & premises", 4, /\boffice premises\b|\bpremises\b|\bmunicipal account\b|\belectricity\b|\bstationery\b|\bcleaning\b|\bsecurity\b/],
  ["Company Admin", "Templates & stationery", 3, /\btemplates?\b|\bletterhead\b|\bform\b/],
  ["Company Admin", "General", 2, /\badministration\b|\badmin\b/],

  ["Personal", "Members' personal files", 6, /\/personal\/|\bmedical aid\b|\bnetcare\b|\bdiscovery (health|life|invest)\b|\bold mutual\b|\bschool fees\b|\bid (copy|document)\b|\bpassport\b|\bdrivers? licen[cs]e\b|\bmarriage certificate\b|\bwill\b.*\btestament\b/],
];

// Top-level library folder → a head start for one area. Deliberately small: content outweighs it.
const FOLDER_HINT = [[/^[^/]*projects?\b/, "Projects", 4], [/^[^/]*accounts?\b/, "Finance", 4], [/^[^/]*admin\b/, "Company Admin", 2]];
const HEAD = 4000; // characters of text looked at

// projects: Map of known project code (upper case) → display name, e.g. "ETH11" → "ETH11 - Illovo Fire Station".
// Returns { area, category, by, project? } — by is "content" when the text decided or confirmed it,
// else "name"; project is the code of the project a Projects file belongs to, when one is recognised.
export function categorise({ relPath = "", text = "", projects } = {}) {
  const where = "/" + String(relPath).toLowerCase().replace(/_/g, " ");
  const head = String(text).slice(0, HEAD).toLowerCase();
  const score = new Map(); // area → { total, fromText, cats: Map(category → points) }
  const add = (area, category, pts, fromText) => {
    let a = score.get(area);
    if (!a) score.set(area, (a = { total: 0, fromText: 0, cats: new Map() }));
    a.total += pts;
    if (fromText) a.fromText += pts;
    if (category) a.cats.set(category, (a.cats.get(category) || 0) + pts);
  };
  for (const [area, category, w, re] of RULES) {
    if (re.test(where)) add(area, category, w, false);
    if (head && re.test(head)) add(area, category, w * 2, true);
  }
  const inLibrary = where.slice(1).split("/").slice(1).join("/"); // without the library's own name
  for (const [re, area, w] of FOLDER_HINT) if (re.test(inLibrary)) add(area, null, w, false);
  // A known project code in the name, folder or text makes it that project's file.
  let project = null;
  if (projects?.size) {
    const find = (s) => { for (const m of s.toUpperCase().replace(/_/g, " ").matchAll(/\b[A-Z]{1,5} ?-?\d{1,3}[A-Z]?\b/g)) { const code = m[0].replace(/[ -]/g, ""); if (projects.has(code)) return code; } return null; };
    const inPath = find(relPath);
    const inText = inPath ? null : find(String(text).slice(0, HEAD));
    if (inPath || inText) {
      project = inPath || inText;
      add("Projects", null, inPath ? 8 : 10, Boolean(inText));
    }
  }
  let best = null;
  for (const [area, a] of score) if (!best || a.total > best[1].total) best = [area, a];
  if (!best) return { area: "Other", category: "Uncategorised", by: "name" };
  const [area, a] = best;
  const general = (c) => c === "General";
  const top = [...a.cats].sort((x, y) => general(x[0]) - general(y[0]) || y[1] - x[1])[0];
  // In Projects the category is the kind of document; which project it belongs to is `project`.
  return { area, category: top ? top[0] : "General", by: a.fromText > 0 ? "content" : "name", ...(area === "Projects" && project ? { project } : {}) };
}
