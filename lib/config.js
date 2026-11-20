// Persistent settings for the Command Centre, stored in data/config.json.
// The Anthropic API key lives in .env (never in config.json, never sent to the browser).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// DATA_DIR / ENV_FILE: on Azure App Service only /home survives redeploys, so they point there.
export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(APP_ROOT, "data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const ENV_PATH = process.env.ENV_FILE ? path.resolve(process.env.ENV_FILE) : path.join(APP_ROOT, ".env");

export const newId = () => crypto.randomBytes(6).toString("hex");

// DEMO_DATA=off: no sample folders, simulated servers or demo SharePoint sites (production once
// real sources are connected). They're filtered out when the config is read, not deleted, so
// switching back on brings them back.
export const DEMO_DIR = path.join(APP_ROOT, "demo-data");
export const demoEnabled = () => !/^(off|0|false|no)$/i.test(process.env.DEMO_DATA || "");
const isDemoPath = (p) => p === DEMO_DIR || String(p).startsWith(DEMO_DIR + path.sep);

function defaults() {
  return {
    company: { name: "BJ-FC Consulting Engineers", owner: "Director" },
    sources: [
      { id: "src-pc", type: "local", name: "Office PC – Documents & Desktop", path: path.join(DEMO_DIR, "Local-PC"), enabled: true, agentAccess: true },
      { id: "src-srv", type: "server", name: "BJFC-SRV01 – File Server", path: path.join(DEMO_DIR, "BJFC-SRV01"), enabled: true, agentAccess: true },
    ],
    servers: [
      { id: "mon-local", name: process.env.PUBLIC_MODE === "1" ? "Hosting server" : "This computer", kind: "local" },
      { id: "mon-srv01", name: "BJFC-SRV01", kind: "simulated", role: "File server · Windows Server 2022", host: "192.168.1.10" },
      { id: "mon-nas", name: "BJFC-NAS", kind: "simulated", role: "Backup NAS · Synology DS920+", host: "192.168.1.20" },
    ],
    sharepoint: [],
    settings: { model: "claude-opus-5-5", effort: "medium" },
  };
}

// What's kept aside while demo data is off; saveConfig() writes it back so nothing is lost.
let hidden = { sources: [], servers: [], sharepoint: [] };

let cache;
export function getConfig() {
  if (cache) return cache;
  let stored;
  try {
    stored = { ...defaults(), ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
  } catch {
    stored = defaults();
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(stored, null, 2));
  }
  cache = stored;
  if (!demoEnabled()) {
    const demo = { sources: (s) => isDemoPath(s.path), servers: (s) => s.kind === "simulated", sharepoint: (s) => s.demo };
    for (const [k, isDemo] of Object.entries(demo)) {
      hidden[k] = stored[k].filter(isDemo);
      cache[k] = stored[k].filter((x) => !isDemo(x));
    }
  }
  return cache;
}

export function saveConfig(cfg = cache) {
  cache = cfg;
  const out = { ...cfg };
  for (const k of Object.keys(hidden)) out[k] = [...(cfg[k] || []), ...hidden[k]];
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(out, null, 2));
}

// Tests only: forget the cached config so the next getConfig() reads the file again.
export function _resetConfigCache() {
  cache = undefined;
  hidden = { sources: [], servers: [], sharepoint: [] };
}

// ---- .env handling (API key) ----
export function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) return;
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

export function setEnvVar(key, value) {
  const lines = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/).filter(Boolean) : [];
  const kept = lines.filter((l) => !l.startsWith(`${key}=`));
  if (value) kept.push(`${key}=${value}`);
  fs.writeFileSync(ENV_PATH, kept.join("\n") + "\n", { mode: 0o600 });
  if (value) process.env[key] = value;
  else delete process.env[key];
}

export const hasApiKey = () => Boolean(process.env.ANTHROPIC_API_KEY);
export const mask = (v) => (v ? `${v.slice(0, 7)}…${v.slice(-4)}` : "");
