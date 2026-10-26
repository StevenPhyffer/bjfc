// Persistent settings for the Command Centre, stored in data/config.json.
// The Anthropic API key lives in .env (never in config.json, never sent to the browser).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(APP_ROOT, "data", "config.json");
const ENV_PATH = path.join(APP_ROOT, ".env");

export const newId = () => crypto.randomBytes(6).toString("hex");

function defaults() {
  const demo = path.join(APP_ROOT, "demo-data");
  return {
    company: { name: "BJ-FC Consulting Engineers", owner: "Director" },
    sources: [
      { id: "src-pc", type: "local", name: "Office PC – Documents & Desktop", path: path.join(demo, "Local-PC"), enabled: true, agentAccess: true },
      { id: "src-srv", type: "server", name: "BJFC-SRV01 – File Server", path: path.join(demo, "BJFC-SRV01"), enabled: true, agentAccess: true },
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

let cache;
export function getConfig() {
  if (cache) return cache;
  try {
    cache = { ...defaults(), ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
  } catch {
    cache = defaults();
    saveConfig(cache);
  }
  return cache;
}

export function saveConfig(cfg = cache) {
  cache = cfg;
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
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
