// BJFC Command Centre — local web server.
// Runs on the owner's machine only (bound to 127.0.0.1). Start with:  npm start
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { APP_ROOT, getConfig, saveConfig, loadEnv, setEnvVar, hasApiKey, mask, newId } from "./lib/config.js";
import * as idx from "./lib/indexer.js";
import { startMonitor, snapshot } from "./lib/monitor.js";
import { runAgent, resetConversation, describeError } from "./lib/agent.js";
import { runDemoAgent } from "./lib/demoAgent.js";
import { testConnection, syncLibrary } from "./lib/sharepoint.js";
import { seedDemoData } from "./scripts/seed-demo-data.js";
import * as auth from "./lib/auth.js";

loadEnv();
seedDemoData();
const PORT = Number(process.env.PORT || 4310);
const HOST = process.env.HOST || "127.0.0.1";
// PUBLIC_MODE=1 when deployed behind a reverse proxy on a shared server (staging / hosted).
const PUBLIC_MODE = process.env.PUBLIC_MODE === "1";
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", ...(process.env.ALLOWED_HOSTS || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)]);
// When set, folders can only be added inside this directory (stops the scanner reading system files).
const SOURCES_ROOT = process.env.SOURCES_ROOT ? path.resolve(process.env.SOURCES_ROOT) : null;
const PUBLIC_FILES = new Set(["/login.html", "/styles.css", "/logo.png", "/logo-small.png"]);
const PUBLIC = path.join(APP_ROOT, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".csv": "text/plain; charset=utf-8", ".pdf": "application/pdf" };

const created = auth.ensureAdmin();
if (created?.password) console.log(`\n  First run: created login ${created.email} / ${created.password}\n  (change it under Settings › Account)\n`);

idx.rescan();
startMonitor();
// Re-sync connected SharePoint sites on start-up
for (const sp of getConfig().sharepoint.filter((s) => s.status === "connected")) {
  syncLibrary(sp).then((docs) => idx.setExtraDocs(`sp-${sp.id}`, docs)).catch(() => {});
}

const json = (res, code, body) => {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });

const publicSp = (sp) => ({ ...sp, clientSecret: sp.clientSecret ? "••••••••" : "" });
const aiMode = () => (hasApiKey() && getConfig().settings.aiMode !== "offline" ? "claude" : "offline");

const routes = {
  "GET /api/status": () => {
    const i = idx.getIndex();
    const cfg = getConfig();
    return {
      company: cfg.company,
      aiMode: aiMode(),
      model: cfg.settings.model,
      effort: cfg.settings.effort,
      apiKey: mask(process.env.ANTHROPIC_API_KEY),
      index: { files: i.docs.length, textIndexed: i.docs.filter((d) => d.textIndexed).length, scannedAt: i.scannedAt, ms: i.ms, errors: i.errors },
      host: os.hostname(),
    };
  },
  "GET /api/financials": () => idx.financials(),
  "GET /api/monitor": () => snapshot(),
  "GET /api/me": (req) => ({ ...req.user, publicMode: PUBLIC_MODE }),
  "POST /api/logout": (req, url, res) => {
    res.setHeader("Set-Cookie", auth.clearCookie(isHttps(req)));
    return { ok: true };
  },
  "POST /api/password": async (req) => {
    const b = await readBody(req);
    if (!auth.login(req.user.email, b.current, clientIp(req))) return [400, { error: "Current password is incorrect" }];
    auth.setPassword(req.user.email, b.password);
    return { ok: true };
  },
  "GET /api/users": () => auth.listUsers(),
  "POST /api/users": async (req) => {
    if (req.user.role !== "admin") return [403, { error: "Only admins can add users" }];
    const b = await readBody(req);
    auth.addUser({ email: b.email, name: b.name, password: b.password, role: b.role === "admin" ? "admin" : "user" });
    return auth.listUsers();
  },
  "GET /api/documents": (req, url) => {
    const p = Object.fromEntries(url.searchParams);
    if (p.q) return idx.search(p.q, { type: p.type || undefined, sourceId: p.source || undefined, limit: 200 });
    return idx.listDocs({ type: p.type || undefined, status: p.status || undefined, client: p.client || undefined, sort: p.sort, limit: 500 })
      .filter((d) => !p.source || d.sourceId === p.source);
  },
  "POST /api/rescan": () => {
    const i = idx.rescan();
    return { files: i.docs.length, ms: i.ms, errors: i.errors };
  },

  // ---- Data sources (local folders / server shares) ----
  "GET /api/sources": () => {
    const docs = idx.getIndex().docs;
    return getConfig().sources.map((s) => ({ ...s, exists: fs.existsSync(s.path), files: docs.filter((d) => d.sourceId === s.id).length }));
  },
  "POST /api/sources": async (req) => {
    const b = await readBody(req);
    const p = path.resolve(String(b.path || "").replace(/^~(?=$|\/)/, os.homedir()));
    if (SOURCES_ROOT && !(p === SOURCES_ROOT || p.startsWith(SOURCES_ROOT + path.sep))) return [400, { error: `On this server, folders must be inside ${SOURCES_ROOT}` }];
    if (!b.path || !fs.existsSync(p) || !fs.statSync(p).isDirectory()) return [400, { error: "That folder doesn't exist on this computer. For a server share, mount it first (Finder › Go › Connect to Server) and use its /Volumes/... path." }];
    const cfg = getConfig();
    cfg.sources.push({ id: "src-" + newId(), type: b.type === "server" ? "server" : "local", name: b.name || path.basename(p), path: p, enabled: true, agentAccess: true });
    saveConfig();
    idx.rescan();
    return routes["GET /api/sources"]();
  },
  "GET /api/volumes": () => {
    if (SOURCES_ROOT) return fs.readdirSync(SOURCES_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(SOURCES_ROOT, d.name));
    const out = [os.homedir() + "/Documents", os.homedir() + "/Desktop"];
    try {
      for (const v of fs.readdirSync("/Volumes")) out.push("/Volumes/" + v);
    } catch {}
    return out.filter((p) => fs.existsSync(p));
  },

  // ---- SharePoint ----
  "GET /api/sharepoint": () => getConfig().sharepoint.map(publicSp),
  "POST /api/sharepoint": async (req) => {
    const b = await readBody(req);
    const demo = Boolean(b.demo);
    if (!b.siteUrl || !/^https:\/\/[^/]+\.sharepoint\.com/i.test(b.siteUrl)) return [400, { error: "Enter a SharePoint site URL like https://bjfc.sharepoint.com/sites/Projects" }];
    if (!demo && (!b.tenantId || !b.clientId || !b.clientSecret)) return [400, { error: "Tenant ID, Client ID and Client secret are required (or tick Demo mode)." }];
    const sp = {
      id: newId(), siteUrl: b.siteUrl.replace(/\/$/, ""), displayName: b.displayName || decodeURIComponent(new URL(b.siteUrl).pathname.split("/").filter(Boolean).pop() || "SharePoint"),
      tenantId: b.tenantId || "", clientId: b.clientId || "", clientSecret: b.clientSecret || "", demo,
      agentAccess: b.agentAccess !== false, status: "connecting", libraries: [],
    };
    try {
      const t = await testConnection(sp);
      sp.status = "connected";
      sp.siteName = t.siteName;
      sp.availableLibraries = t.libraries;
      const docs = await syncLibrary(sp);
      sp.lastSync = new Date().toISOString();
      sp.syncedFiles = docs.length;
      idx.setExtraDocs(`sp-${sp.id}`, docs);
    } catch (e) {
      return [400, { error: `Couldn't connect: ${e.message}` }];
    }
    getConfig().sharepoint.push(sp);
    saveConfig();
    return publicSp(sp);
  },
  "GET /api/settings": () => ({ ...getConfig().settings, apiKey: mask(process.env.ANTHROPIC_API_KEY), hasKey: hasApiKey() }),
  "POST /api/settings": async (req) => {
    const b = await readBody(req);
    const cfg = getConfig();
    if (typeof b.apiKey === "string" && b.apiKey.trim()) setEnvVar("ANTHROPIC_API_KEY", b.apiKey.trim());
    if (b.removeKey) setEnvVar("ANTHROPIC_API_KEY", "");
    for (const k of ["model", "effort", "aiMode"]) if (b[k]) cfg.settings[k] = b[k];
    if (b.companyName) cfg.company.name = b.companyName;
    saveConfig();
    return routes["GET /api/settings"]();
  },
  "POST /api/chat/reset": async (req) => {
    const b = await readBody(req);
    resetConversation(b.conversationId);
    return { ok: true };
  },
};

// Routes with an :id segment
async function paramRoute(req, res, url) {
  let m;
  if ((m = url.pathname.match(/^\/api\/documents\/(\w+)$/)) && req.method === "GET") {
    const d = idx.readDoc(m[1]);
    return d ? json(res, 200, d) : json(res, 404, { error: "Not found" });
  }
  if ((m = url.pathname.match(/^\/api\/documents\/(\w+)\/raw$/)) && req.method === "GET") {
    const d = idx.getIndex().byId.get(m[1]);
    if (!d || d.sourceType === "sharepoint") return json(res, 404, { error: "Not found" });
    // Only serve files that live inside a configured source folder.
    const ok = getConfig().sources.some((s) => path.resolve(d.path).startsWith(path.resolve(s.path) + path.sep));
    if (!ok || !fs.existsSync(d.path)) return json(res, 404, { error: "Not found" });
    // Never let a scanned file run as a web page on our origin: HTML/SVG/XML are served as plain text, and everything is sandboxed.
    const type = /^\.(html?|svg|xml|js)$/.test(d.ext) ? "text/plain; charset=utf-8" : MIME[d.ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Content-Security-Policy": "sandbox", "Content-Disposition": `inline; filename="${encodeURIComponent(d.name)}"` });
    return fs.createReadStream(d.path).pipe(res);
  }
  if ((m = url.pathname.match(/^\/api\/sources\/([\w-]+)$/))) {
    const cfg = getConfig();
    const s = cfg.sources.find((x) => x.id === m[1]);
    if (!s) return json(res, 404, { error: "Not found" });
    if (req.method === "DELETE") cfg.sources = cfg.sources.filter((x) => x !== s);
    else if (req.method === "PATCH") {
      const b = await readBody(req);
      for (const k of ["enabled", "agentAccess", "name"]) if (k in b) s[k] = b[k];
    }
    saveConfig();
    idx.rescan();
    return json(res, 200, routes["GET /api/sources"]());
  }
  if ((m = url.pathname.match(/^\/api\/sharepoint\/(\w+)(\/sync)?$/))) {
    const cfg = getConfig();
    const sp = cfg.sharepoint.find((x) => x.id === m[1]);
    if (!sp) return json(res, 404, { error: "Not found" });
    if (req.method === "DELETE") {
      cfg.sharepoint = cfg.sharepoint.filter((x) => x !== sp);
      idx.setExtraDocs(`sp-${sp.id}`, []);
    } else if (req.method === "PATCH") {
      const b = await readBody(req);
      if ("agentAccess" in b) sp.agentAccess = !!b.agentAccess;
      idx.setExtraDocs(`sp-${sp.id}`, (await syncLibrary(sp)));
    } else if (m[2] && req.method === "POST") {
      try {
        const docs = await syncLibrary(sp);
        sp.lastSync = new Date().toISOString();
        sp.syncedFiles = docs.length;
        idx.setExtraDocs(`sp-${sp.id}`, docs);
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }
    saveConfig();
    return json(res, 200, cfg.sharepoint.map(publicSp));
  }
  return false;
}

async function chat(req, res) {
  const b = await readBody(req);
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const emit = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  const ctrl = new AbortController();
  res.on("close", () => ctrl.abort());
  const mode = aiMode();
  emit({ type: "start", mode });
  try {
    if (mode === "claude") await runAgent({ conversationId: b.conversationId || "default", message: String(b.message || ""), emit, signal: ctrl.signal });
    else await runDemoAgent({ message: String(b.message || ""), emit });
  } catch (e) {
    if (!ctrl.signal.aborted) emit({ type: "error", error: describeError(e) });
  }
  emit({ type: "done" });
  res.end();
}

const isHttps = (req) => req.headers["x-forwarded-proto"] === "https";
const clientIp = (req) => (PUBLIC_MODE && req.headers["x-forwarded-for"]?.split(",")[0].trim()) || req.socket.remoteAddress;

const server = http.createServer(async (req, res) => {
  // Block DNS-rebinding / unknown hosts: only answer requests addressed to a known name.
  const host = (req.headers.host || "").replace(/:\d+$/, "").toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  try {
    // ---- Login ----
    if (url.pathname === "/api/login" && req.method === "POST") {
      const ip = clientIp(req);
      if (auth.tooManyAttempts(ip)) return json(res, 429, { error: "Too many attempts. Try again in 15 minutes." });
      const b = await readBody(req);
      const s = auth.login(b.email, b.password, ip);
      if (!s) return json(res, 401, { error: "Incorrect email or password" });
      res.setHeader("Set-Cookie", auth.sessionCookie(s.token, s.maxAge, isHttps(req)));
      return json(res, 200, { user: s.user });
    }
    req.user = auth.userFromRequest(req);
    if (!req.user && !PUBLIC_FILES.has(url.pathname)) {
      if (url.pathname.startsWith("/api/")) return json(res, 401, { error: "Please sign in" });
      res.writeHead(302, { Location: `/login.html${url.pathname === "/" ? "" : "?next=" + encodeURIComponent(url.pathname)}` });
      return res.end();
    }
    if (req.user && url.pathname === "/login.html") {
      res.writeHead(302, { Location: "/" });
      return res.end();
    }
    // CSRF: state-changing API calls must be JSON (cross-site forms can't send that without a CORS preflight).
    if (req.method !== "GET" && url.pathname.startsWith("/api/") && !String(req.headers["content-type"] || "").startsWith("application/json")) {
      return json(res, 415, { error: "Expected JSON" });
    }

    if (url.pathname === "/api/chat" && req.method === "POST") return await chat(req, res);
    const handler = routes[`${req.method} ${url.pathname}`];
    if (handler) {
      const out = await handler(req, url, res);
      return Array.isArray(out) && typeof out[0] === "number" ? json(res, out[0], out[1]) : json(res, 200, out);
    }
    if (url.pathname.startsWith("/api/")) {
      if ((await paramRoute(req, res, url)) !== false) return;
      return json(res, 404, { error: "Not found" });
    }
    // Static files
    const file = path.join(PUBLIC, url.pathname === "/" ? "index.html" : path.normalize(url.pathname));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  BJFC Command Centre running →  http://localhost:${PORT}`);
  if (PUBLIC_MODE) console.log(`  Public mode: hosts ${[...ALLOWED_HOSTS].join(", ")}${SOURCES_ROOT ? ` · sources limited to ${SOURCES_ROOT}` : ""}`);
  console.log(`  AI mode: ${aiMode() === "claude" ? "Claude (" + getConfig().settings.model + ")" : "offline demo (no API key)"}`);
  console.log(`  Indexed ${idx.getIndex().docs.length} files from ${getConfig().sources.length} sources\n`);
});
