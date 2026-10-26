// The tools the AI agent can use. The same executors back both the real Claude
// agent and the offline demo agent, so demo answers come from the real index.
import * as idx from "./indexer.js";
import { statusForAgent } from "./monitor.js";
import { getConfig } from "./config.js";
import { searchSharePoint } from "./sharepoint.js";

const DOC_TYPES = ["quote", "invoice", "report", "minutes", "drawing", "spreadsheet", "policy", "other"];

export const toolDefs = [
  {
    name: "search_documents",
    description: "Full-text search across every indexed business file (office PC, file server and synced SharePoint libraries). Use for any 'find', 'where is', or topic question. Returns matching files with an id, metadata and a text snippet.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords, names, quote/invoice numbers, project or client names" },
        doc_type: { type: "string", enum: DOC_TYPES, description: "Optional filter by document type" },
        limit: { type: "integer", description: "Max results (default 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_documents",
    description: "List documents of one type with structured fields (number, client, project, date, status, total, balance). Use for 'show all quotes', 'unpaid invoices', 'overdue invoices', 'everything for client X'.",
    input_schema: {
      type: "object",
      properties: {
        doc_type: { type: "string", enum: DOC_TYPES },
        status: { type: "string", description: "Optional status filter, e.g. 'overdue', 'unpaid', 'paid', 'open', 'accepted', 'declined'" },
        client: { type: "string", description: "Optional client name (partial match)" },
        sort: { type: "string", enum: ["date", "amount", "overdue"] },
        limit: { type: "integer" },
      },
      required: ["doc_type"],
    },
  },
  {
    name: "read_document",
    description: "Read the full text of one document by its id (from search_documents or list_documents). Use before quoting specific details.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "financial_summary",
    description: "Business snapshot computed from all quotes and invoices: open quote pipeline, win rate, outstanding and overdue debtors, billing over the last 90 days, and outstanding amounts per client.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_system_status",
    description: "Live health of the office computer, file server and backup NAS: CPU, memory, disk space, services, backups and active alerts.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "search_sharepoint",
    description: "Live search of connected SharePoint sites (only those the owner has granted the agent access to).",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
];

// Minimal schema validation (inputs may arrive via eager streaming, so check them).
export function validateInput(name, input) {
  const def = toolDefs.find((t) => t.name === name);
  if (!def) return `Unknown tool ${name}`;
  if (!input || typeof input !== "object") return "Input must be an object";
  for (const r of def.input_schema.required || []) if (input[r] == null || input[r] === "") return `Missing required field '${r}'`;
  for (const [k, v] of Object.entries(input)) {
    const p = def.input_schema.properties[k];
    if (!p) continue;
    if (p.type === "string" && typeof v !== "string") return `'${k}' must be a string`;
    if (p.type === "integer" && !Number.isInteger(v)) return `'${k}' must be an integer`;
    if (p.enum && !p.enum.includes(v)) return `'${k}' must be one of ${p.enum.join(", ")}`;
  }
  return null;
}

const trimDoc = (d) => ({ id: d.id, name: d.name, location: `${d.sourceName} › ${d.folder}`, type: d.type, modified: d.modified.slice(0, 10), ...stripNull(d.meta), ...(d.snippet ? { snippet: d.snippet } : {}) });
const stripNull = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v != null));

export async function executeTool(name, input = {}) {
  switch (name) {
    case "search_documents":
      return idx.search(input.query, { type: input.doc_type, limit: Math.min(input.limit || 10, 25), agentOnly: true }).map(trimDoc);
    case "list_documents":
      return idx.listDocs({ type: input.doc_type, status: input.status, client: input.client, sort: input.sort, limit: Math.min(input.limit || 30, 60), agentOnly: true }).map(trimDoc);
    case "read_document": {
      const d = idx.readDoc(input.id);
      if (!d) return { error: "No document with that id" };
      if (!d.textIndexed) return { ...trimDoc(d), note: "Binary file (e.g. PDF/DWG) – only the file name and location are indexed in this demo." };
      return { ...trimDoc(d), text: d.text.slice(0, 20000) };
    }
    case "financial_summary":
      return idx.financials();
    case "get_system_status":
      return statusForAgent();
    case "search_sharepoint": {
      const sites = getConfig().sharepoint.filter((s) => s.agentAccess && s.status === "connected");
      if (!sites.length) return { note: "No SharePoint sites are connected with agent access yet. The owner can add one under Data Sources › SharePoint." };
      const out = [];
      for (const sp of sites) {
        try {
          out.push(...(await searchSharePoint(sp, input.query)));
        } catch (e) {
          out.push({ site: sp.displayName, error: e.message });
        }
      }
      return out;
    }
    default:
      return { error: `Unknown tool ${name}` };
  }
}
