// SharePoint / OneDrive connector via Microsoft Graph (app-only, client credentials).
// Requires an Entra ID (Azure AD) app registration with the Graph application
// permission "Sites.Read.All" (or "Sites.Selected" for tighter scoping) + admin consent.
//
// In demo mode (no tenant details, or "Demo" ticked) it returns sample libraries
// so the flow can be shown without touching a real tenant.
import crypto from "node:crypto";
import { extractMeta } from "./indexer.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
const tokens = new Map();

async function getToken(sp) {
  const cached = tokens.get(sp.id);
  if (cached && cached.exp > Date.now() + 60000) return cached.token;
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(sp.tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: sp.clientId,
      client_secret: sp.clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error_description?.split("\r\n")[0] || j.error || `Token request failed (${res.status})`);
  tokens.set(sp.id, { token: j.access_token, exp: Date.now() + j.expires_in * 1000 });
  return j.access_token;
}

async function graph(sp, url) {
  const res = await fetch(url.startsWith("http") ? url : GRAPH + url, { headers: { Authorization: `Bearer ${await getToken(sp)}` } });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error?.message || `Graph request failed (${res.status})`);
  }
  return res;
}

async function resolveSite(sp) {
  const u = new URL(sp.siteUrl);
  const sitePath = u.pathname.replace(/\/$/, "");
  const res = await graph(sp, `/sites/${u.hostname}:${sitePath || "/"}`);
  return res.json();
}

// ---------------- Demo data ----------------
const demoLibraries = [
  { name: "Documents", items: 1284 },
  { name: "Tenders & Proposals", items: 312 },
  { name: "Project Close-out", items: 86 },
];
const demoFiles = [
  ["Tenders & Proposals", "Tender – Coastal Road Rehabilitation (Bid Doc).txt", `TENDER SUBMISSION – Coastal Road Rehabilitation\nClient: Harbourline Developments\nClosing Date: 2026-10-21\nStatus: In preparation\nTender sum (estimate, incl. VAT): R 4 870 000,00\nTeam: L. van Wyk (Pr Eng), P. Govender\nCompulsory briefing attended. Outstanding: CIDB grading letter, B-BBEE affidavit.`],
  ["Tenders & Proposals", "Proposal – Midlands Poultry Effluent Treatment.txt", `PROPOSAL – Effluent treatment upgrade\nClient: Midlands Poultry Co-operative\nStatus: Submitted\nFee proposal (incl. VAT): R 1 265 000,00\nDecision expected within 6 weeks.`],
  ["Documents", "Company Profile 2026.txt", `BJ-FC Consulting Engineers – Company Profile\nFounded 2005 · Durban & Gauteng offices · Level 2 B-BBEE\nServices: civil, structural, water engineering, project management, environmental licensing support.`],
  ["Documents", "Professional Indemnity Insurance Schedule.txt", `PI INSURANCE SCHEDULE (demo)\nPolicy period ends: 2026-11-30\nLimit of indemnity: R 20 000 000\nAction: broker to confirm renewal terms.`],
  ["Project Close-out", "Seaview Schools – Close-out Report.txt", `CLOSE-OUT REPORT\nClient: Seaview Schools Trust\nProject: Condition assessment of existing buildings\nAll deliverables issued. Final account agreed. Lessons learned: earlier access to as-built drawings needed.`],
];

function toDoc(sp, library, name, text, extra = {}) {
  const type = /tender|proposal/i.test(name) ? "quote" : /report/i.test(name) ? "report" : "other";
  return {
    id: crypto.createHash("sha1").update(sp.id + library + name).digest("hex").slice(0, 12),
    name, path: `${sp.siteUrl}/${library}/${name}`, relPath: `${library}/${name}`, folder: library,
    ext: "." + name.split(".").pop(), size: text.length, modified: extra.modified || new Date(Date.now() - Math.random() * 30 * 86400000).toISOString(),
    sourceId: sp.id, sourceName: `SharePoint – ${sp.displayName || new URL(sp.siteUrl).pathname}`, sourceType: "sharepoint",
    agentAccess: sp.agentAccess !== false, type, text, textIndexed: Boolean(text), meta: text ? extractMeta(type, text) : {},
    webUrl: extra.webUrl,
  };
}

// ---------------- Public API ----------------
export async function testConnection(sp) {
  if (sp.demo) {
    await new Promise((r) => setTimeout(r, 900));
    return { ok: true, demo: true, siteName: sp.displayName || "BJFC Intranet (demo)", libraries: demoLibraries };
  }
  const site = await resolveSite(sp);
  const drives = await (await graph(sp, `/sites/${site.id}/drives`)).json();
  return { ok: true, siteId: site.id, siteName: site.displayName, libraries: drives.value.map((d) => ({ id: d.id, name: d.name })) };
}

// Pull a shallow index of text-like files so the agent can search them alongside local files.
export async function syncLibrary(sp) {
  if (sp.demo) return demoFiles.map(([lib, name, text]) => toDoc(sp, lib, name, text));
  const site = await resolveSite(sp);
  const drives = (await (await graph(sp, `/sites/${site.id}/drives`)).json()).value;
  const docs = [];
  for (const drive of drives) {
    if (sp.libraries?.length && !sp.libraries.includes(drive.name)) continue;
    let url = `/drives/${drive.id}/root/search(q='')?$top=200&$select=id,name,size,lastModifiedDateTime,webUrl,file,parentReference`;
    let pages = 0;
    while (url && pages++ < 5) {
      const j = await (await graph(sp, url)).json();
      for (const item of j.value.filter((i) => i.file)) {
        let text = "";
        if (/\.(txt|md|csv|json)$/i.test(item.name) && item.size < 512 * 1024) {
          text = await (await graph(sp, `/drives/${drive.id}/items/${item.id}/content`)).text();
        }
        docs.push(toDoc(sp, drive.name, item.name, text, { modified: item.lastModifiedDateTime, webUrl: item.webUrl }));
      }
      url = j["@odata.nextLink"];
    }
  }
  return docs;
}

// Live search straight against SharePoint (used by the AI agent's search_sharepoint tool).
export async function searchSharePoint(sp, query) {
  if (sp.demo) {
    const q = query.toLowerCase().split(/\s+/);
    return demoFiles
      .filter(([lib, name, text]) => q.some((t) => (name + text).toLowerCase().includes(t)))
      .map(([lib, name, text]) => ({ site: sp.displayName, library: lib, name, preview: text.slice(0, 300) }));
  }
  const site = await resolveSite(sp);
  const j = await (await graph(sp, `/sites/${site.id}/drive/root/search(q='${encodeURIComponent(query.replace(/'/g, "''"))}')?$top=15`)).json();
  return j.value.map((i) => ({ site: sp.displayName, name: i.name, webUrl: i.webUrl, modified: i.lastModifiedDateTime }));
}
