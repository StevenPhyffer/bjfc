// Runs in a worker thread (see extractOffThread in lib/extractPool.js): reads the text out of one
// file at a time, away from the thread that answers web requests.
import { parentPort } from "node:worker_threads";
import { extractText } from "./extract.js";

parentPort.on("message", async ({ id, bytes, ext }) => {
  try {
    parentPort.postMessage({ id, text: await extractText(Buffer.from(bytes), ext) });
  } catch (e) {
    parentPort.postMessage({ id, error: e.message || String(e) });
  }
});
