// The Claude-powered business assistant: a manual streaming tool-use loop.
// Conversations are kept server-side (append-only) so thinking blocks and
// fallback blocks are echoed back exactly as returned.
import Anthropic from "@anthropic-ai/sdk";
import { toolDefs, executeTool, validateInput } from "./tools.js";
import { getConfig } from "./config.js";

const conversations = new Map(); // id -> MessageParam[]
const MAX_STEPS = 12;

function systemPrompt() {
  const cfg = getConfig();
  const today = new Date().toISOString().slice(0, 10);
  return `You are the private AI business assistant for ${cfg.company.name}, a Durban-based consulting engineering firm (civil, structural, water engineering, project management and environmental licensing support; offices in Durban and Gauteng). You work for the company's owner/director.

You have tools that read the company's own files (office PC, the BJFC-SRV01 file server, and any SharePoint sites the owner has connected) and live health data for the office IT environment.

How to work:
- Always use the tools to answer questions about documents, quotes, invoices, clients, money or systems. Never invent document names, numbers or amounts. If something isn't in the files, say so plainly.
- Prefer list_documents for "show me all X" questions and financial_summary for "how is the business doing". Use read_document before quoting details from a specific file.
- When you mention a specific document, link it as [label](doc:<id>) using the id from the tool result so the owner can click to open it.
- Amounts are South African Rand. Format like R 1 234 567.89. Mention whether amounts include VAT when known.
- Present lists of quotes or invoices as compact markdown tables (number, client, date, status, amount).
- Be direct and practical — the owner is busy. Lead with the answer, then detail. When asked for advice (cash flow, debtors, follow-ups, IT risks), give specific, prioritised recommendations grounded in the data.
- Machines marked "simulated" in system status are demo stand-ins; you may note that if asked about the server's real state.

Today's date is ${today}.`;
}

export function resetConversation(id) {
  conversations.delete(id);
}

export async function runAgent({ conversationId, message, emit, signal }) {
  const cfg = getConfig();
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY
  const history = conversations.get(conversationId) || [];
  // Work on a copy; only commit when the turn completes, so a failed request never leaves a broken history.
  const messages = [...history, { role: "user", content: message }];

  for (let step = 0; step < MAX_STEPS; step++) {
    const stream = client.beta.messages.stream(
      {
        model: cfg.settings.model || "claude-opus-5-5",
        max_tokens: 64000,
        system: systemPrompt(),
        tools: toolDefs,
        messages,
        thinking: { type: "adaptive" },
        output_config: { effort: cfg.settings.effort || "medium" },
        cache_control: { type: "ephemeral" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      },
      { signal },
    );
    stream.on("text", (t) => emit({ type: "text", text: t }));
    const response = await stream.finalMessage();

    if (response.stop_reason === "refusal") {
      emit({ type: "text", text: "\n\n_I can't help with that request._" });
      break; // don't commit a refused turn
    }

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "pause_turn") continue;
    if (response.stop_reason === "max_tokens") {
      emit({ type: "text", text: "\n\n_(Response was cut short — ask me to continue.)_" });
      conversations.set(conversationId, messages);
      break;
    }
    if (response.stop_reason !== "tool_use") {
      conversations.set(conversationId, messages);
      break;
    }

    const toolUses = response.content.filter((b) => b.type === "tool_use");
    const results = await Promise.all(
      toolUses.map(async (tu) => {
        emit({ type: "tool", id: tu.id, name: tu.name, input: tu.input });
        const invalid = validateInput(tu.name, tu.input);
        if (invalid) {
          emit({ type: "tool_result", id: tu.id, name: tu.name, error: invalid });
          return { type: "tool_result", tool_use_id: tu.id, content: invalid, is_error: true };
        }
        try {
          const out = await executeTool(tu.name, tu.input);
          emit({ type: "tool_result", id: tu.id, name: tu.name, count: Array.isArray(out) ? out.length : undefined });
          return { type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out) };
        } catch (e) {
          emit({ type: "tool_result", id: tu.id, name: tu.name, error: e.message });
          return { type: "tool_result", tool_use_id: tu.id, content: `Error: ${e.message}`, is_error: true };
        }
      }),
    );
    messages.push({ role: "user", content: results });
    emit({ type: "text", text: "\n\n" });
    if (step === MAX_STEPS - 1) conversations.set(conversationId, messages);
  }
}

// Map SDK errors to something the owner can act on.
export function describeError(e) {
  if (e instanceof Anthropic.AuthenticationError) return "The Anthropic API key was rejected. Check it under Settings.";
  if (e instanceof Anthropic.PermissionDeniedError) return "This API key doesn't have access to the selected model.";
  if (e instanceof Anthropic.RateLimitError) return "Rate limit reached — wait a moment and try again.";
  if (e instanceof Anthropic.BadRequestError) return `The request was rejected: ${e.message}`;
  if (e instanceof Anthropic.APIConnectionError) return "Couldn't reach the Anthropic API — check the internet connection.";
  if (e instanceof Anthropic.APIError) return `Anthropic API error (${e.status}): ${e.message}`;
  return e.message || String(e);
}
