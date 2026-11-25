// Text extraction off the main thread. Reading a PDF is seconds of solid CPU work; done on the
// server's own thread it froze every page while a library was being scanned (and Azure restarted
// the app when its health check went unanswered). The worker also has its own memory ceiling, so
// one monstrous file ends the worker — which is simply started again — not the Command Centre.
import { Worker } from "node:worker_threads";

const HEAP_MB = Number(process.env.EXTRACT_WORKER_MB) || 320;
const TIMEOUT_MS = Number(process.env.EXTRACT_TIMEOUT_MS) || 180000;

let worker = null;
let seq = 0;
const pending = new Map(); // id → { resolve, reject, timer }

function failAll(message) {
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); }
  pending.clear();
}

function start() {
  const w = new Worker(new URL("./extractWorker.js", import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: HEAP_MB } });
  w.on("message", ({ id, text, error }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    if (error != null) p.reject(new Error(error)); else p.resolve(text);
  });
  const gone = (why) => { if (worker === w) { worker = null; failAll(why); } };
  w.on("error", (e) => gone(e.code === "ERR_WORKER_OUT_OF_MEMORY" ? "the file needs more memory to read than this server allows" : `text extraction failed: ${e.message}`));
  w.on("exit", () => gone("text extraction stopped unexpectedly"));
  w.unref(); // never keeps the process alive on its own (after the listeners: adding one refs it again)
  return w;
}

// Same result as extractText(buf, ext), computed in the worker.
export function extractOffThread(buf, ext) {
  return new Promise((resolve, reject) => {
    worker ||= start();
    const id = ++seq;
    const w = worker;
    const timer = setTimeout(() => {
      // Stuck on one file: stop the worker (the others waiting on it fail too and are retried later).
      if (worker === w) { worker = null; failAll("reading this file took too long"); }
      w.terminate();
    }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    const bytes = new Uint8Array(buf); // a copy the worker can own
    w.postMessage({ id, bytes, ext }, [bytes.buffer]);
  });
}
