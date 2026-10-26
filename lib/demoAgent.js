// Offline fallback used when no API key is set (or "Offline demo" is chosen).
// It routes the question with simple keyword rules, calls the SAME tools as the
// real agent, and writes up the results — so all numbers shown are real index data.
import { executeTool } from "./tools.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const zar = (n) => (n == null ? "—" : "R " + Number(n).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/ /g, " "));
const link = (d) => `[${d.number || d.name}](doc:${d.id})`;

async function call(emit, name, input) {
  const id = Math.random().toString(36).slice(2);
  emit({ type: "tool", id, name, input });
  await sleep(450);
  const out = await executeTool(name, input);
  emit({ type: "tool_result", id, name, count: Array.isArray(out) ? out.length : undefined });
  return out;
}

async function type(emit, text) {
  for (const chunk of text.match(/[\s\S]{1,18}/g) || []) {
    emit({ type: "text", text: chunk });
    await sleep(12);
  }
}

function table(rows, kind) {
  if (!rows.length) return "_None found._\n";
  const head = kind === "invoice" ? "| Invoice | Client | Date | Status | Balance |\n|---|---|---|---|---:|" : "| Quote | Client | Project | Date | Status | Total |\n|---|---|---|---|---|---:|";
  const body = rows.map((d) =>
    kind === "invoice"
      ? `| ${link(d)} | ${d.client || "—"} | ${d.date || d.modified} | ${d.status}${d.daysOverdue ? ` (${d.daysOverdue}d)` : ""} | ${zar(d.balance)} |`
      : `| ${link(d)} | ${d.client || "—"} | ${d.project || "—"} | ${d.date || d.modified} | ${d.status || "—"} | ${zar(d.total)} |`,
  );
  return `${head}\n${body.join("\n")}\n`;
}

export async function runDemoAgent({ message, emit }) {
  const q = message.toLowerCase();
  const clientMatch = q.match(/(silverbay|thukela|sandhaven|ridgeview|ilanga|harbourline|midlands|northgate|seaview|mzansi)/);

  if (/server|cpu|memory|ram|disk|backup|nas|load|health|it |system|monitor/.test(q)) {
    const s = await call(emit, "get_system_status", {});
    let out = "Here's the current state of the office IT environment:\n\n| Machine | CPU | Memory | Busiest disk |\n|---|---:|---:|---|\n";
    for (const m of s.machines) {
      const disk = (m.disks || []).slice().sort((a, b) => b.percent - a.percent)[0];
      out += `| ${m.name} | ${m.cpuPercent}% | ${m.memoryPercent}% | ${disk ? `${disk.mount} ${disk.percent}%` : "—"} |\n`;
    }
    out += s.alerts.length ? `\n**${s.alerts.length} item(s) need attention:**\n${s.alerts.map((a) => `- **${a.machine}** – ${a.message}`).join("\n")}\n` : "\nNo alerts — everything is healthy.\n";
    out += "\n**My advice:** sort out the NAS drive showing reallocated sectors first — it's the backup target, so a failure there puts every backup at risk. Then schedule the pending server restart for after hours.";
    return type(emit, out);
  }

  if (/advice|how.*(business|doing)|cash ?flow|summary|overview|debtor|owe/.test(q)) {
    const f = await call(emit, "financial_summary", {});
    const overdue = await call(emit, "list_documents", { doc_type: "invoice", status: "overdue", sort: "overdue", limit: 5 });
    let out = `**Business snapshot**\n\n- **Outstanding debtors:** ${zar(f.invoices.outstanding)} across ${f.invoices.unpaid} invoices\n- **Overdue:** ${zar(f.invoices.overdueValue)} (${f.invoices.overdue} invoices)\n- **Billed in the last 90 days:** ${zar(f.invoices.billedLast90Days)}\n- **Open quotes awaiting clients:** ${f.quotes.open} worth ${zar(f.quotes.openValue)}\n- **Quote win rate:** ${f.quotes.winRate != null ? Math.round(f.quotes.winRate * 100) + "%" : "—"}\n\n`;
    if (f.outstandingByClient.length) out += `**Biggest balances owed:**\n${f.outstandingByClient.slice(0, 3).map((c) => `- ${c.client}: ${zar(c.amount)}`).join("\n")}\n\n`;
    if (overdue.length) out += `**Most overdue:**\n${table(overdue, "invoice")}\n`;
    out += `**Recommendations**\n1. Phone the top overdue client this week — ${overdue[0] ? `${overdue[0].client} is ${overdue[0].daysOverdue} days late on ${link(overdue[0])}` : "start with the oldest balance"}.\n2. Follow up the ${f.quotes.open} open quotes; anything older than 30 days should get a call, not an email.\n3. Consider a 50% upfront stage on new work for clients with repeated late payments.`;
    return type(emit, out);
  }

  if (/invoice|unpaid|overdue|outstanding|paid/.test(q)) {
    const status = /overdue/.test(q) ? "overdue" : /unpaid|outstanding/.test(q) ? "unpaid" : /\bpaid\b/.test(q) ? "paid" : undefined;
    const rows = await call(emit, "list_documents", { doc_type: "invoice", ...(status && { status }), ...(clientMatch && { client: clientMatch[1] }), sort: status === "overdue" ? "overdue" : "date", limit: 15 });
    const total = rows.reduce((t, d) => t + (d.balance || 0), 0);
    return type(emit, `I found **${rows.length}** ${status || ""} invoice${rows.length === 1 ? "" : "s"}${clientMatch ? ` for ${clientMatch[1][0].toUpperCase() + clientMatch[1].slice(1)}` : ""}. Total balance due: **${zar(total)}**.\n\n${table(rows, "invoice")}\nClick any invoice number to open it.`);
  }

  if (/quote|quotation|tender|proposal/.test(q)) {
    const status = /open|pending|awaiting|outstanding/.test(q) ? "open" : /accepted|won/.test(q) ? "accepted" : /declined|lost/.test(q) ? "declined" : undefined;
    const rows = await call(emit, "list_documents", { doc_type: "quote", ...(status && { status }), ...(clientMatch && { client: clientMatch[1] }), limit: 20 });
    const total = rows.reduce((t, d) => t + (d.total || 0), 0);
    return type(emit, `Here ${rows.length === 1 ? "is" : "are"} **${rows.length}** ${status || ""} quote${rows.length === 1 ? "" : "s"} with a combined value of **${zar(total)}** (incl. VAT).\n\n${table(rows, "quote")}`);
  }

  if (/sharepoint/.test(q)) {
    const term = q.replace(/.*sharepoint\s*(for|about)?/, "").trim() || "tender";
    const res = await call(emit, "search_sharepoint", { query: term });
    if (!Array.isArray(res)) return type(emit, res.note);
    return type(emit, `SharePoint results for "${term}":\n\n${res.map((r) => `- **${r.name}** (${r.library || r.site})${r.preview ? ` — ${r.preview.split("\n")[1] || ""}` : ""}`).join("\n") || "_Nothing found._"}`);
  }

  if (clientMatch) {
    const docs = await call(emit, "search_documents", { query: clientMatch[1], limit: 20 });
    return type(emit, `Everything I found for **${clientMatch[1]}**:\n\n${docs.map((d) => `- ${link(d)} — ${d.type}, ${d.location}${d.status ? ` · ${d.status}` : ""}`).join("\n")}`);
  }

  const terms = message.replace(/\b(find|show|me|the|where|is|are|a|an|please|can|you|get|pull|up|all|my|for|of|about|what|do|we|have)\b/gi, " ").trim() || message;
  const docs = await call(emit, "search_documents", { query: terms, limit: 8 });
  if (!docs.length) return type(emit, `I couldn't find anything matching "${terms}" in the indexed folders. Try a client name, quote/invoice number or project keyword.`);
  return type(emit, `Top matches for "${terms}":\n\n${docs.map((d) => `- ${link(d)} — ${d.location}\n  > ${d.snippet || "(file name match)"}`).join("\n")}\n\n_Offline demo mode — add an API key in Settings for full AI answers._`);
}
