// BJFC Command Centre — local web server.
// Runs on the owner's machine only (bound to 127.0.0.1). Start with:  npm start
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { APP_ROOT, getConfig, saveConfig, loadEnv, setEnvVar, hasApiKey, mask, newId, demoEnabled } from "./lib/config.js";
import * as idx from "./lib/indexer.js";
import { startMonitor, snapshot } from "./lib/monitor.js";
import { runAgent, resetConversation, describeError } from "./lib/agent.js";
import { runDemoAgent } from "./lib/demoAgent.js";
import { testConnection, syncLibrary, appCredentialsAvailable, cleanPaths, forgetSite, canReadLive, liveText } from "./lib/sharepoint.js";
import { seedDemoData } from "./scripts/seed-demo-data.js";
import * as auth from "./lib/auth.js";
import * as entra from "./lib/entra.js";

loadEnv();
if (demoEnabled()) seedDemoData();
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
// ---- SharePoint sync: in the background (big libraries take minutes), on start-up and every
// SHAREPOINT_SYNC_HOURS (default 6). Unchanged files aren't downloaded again.
const syncing = new Set();
async function syncSite(sp) {
  if (syncing.has(sp.id)) return;
  syncing.add(sp.id);
  try {
    // A big library takes a long time: show what's known as it comes in (invoices first).
    const connected = () => getConfig().sharepoint.includes(sp);
    const { docs, errors } = await syncLibrary(sp, { onDocs: (d) => connected() && idx.setExtraDocs(`sp-${sp.id}`, d) });
    if (!connected()) return void forgetSite(sp); // disconnected while syncing
    Object.assign(sp, {
      lastSync: new Date().toISOString(), syncedFiles: docs.length, textFiles: docs.filter((d) => d.textIndexed).length,
      syncErrors: errors.slice(0, 20), syncErrorCount: errors.length, lastError: null,
    });
    idx.setExtraDocs(`sp-${sp.id}`, docs);
    if (errors.length) console.warn(`SharePoint ${sp.displayName}: ${errors.length} file(s) not read, e.g. ${errors[0]}`);
  } catch (e) {
    sp.lastError = e.message;
    console.warn(`SharePoint ${sp.displayName}: sync failed — ${e.message}`);
  } finally {
    syncing.delete(sp.id);
    saveConfig();
  }
}
const syncAllSites = () => { for (const sp of getConfig().sharepoint.filter((s) => s.status === "connected")) syncSite(sp); };
syncAllSites();
setInterval(syncAllSites, (Number(process.env.SHAREPOINT_SYNC_HOURS) || 6) * 3600 * 1000).unref();

// Anything sizeable goes out gzipped: a page of the documents list is ~10× smaller on the wire.
const json = (res, code, body) => {
  const text = JSON.stringify(body);
  const zip = res.gzipOk && text.length > 1024;
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", ...(zip ? { "Content-Encoding": "gzip", Vary: "Accept-Encoding" } : {}) });
  res.end(zip ? zlib.gzipSync(text) : text);
};
// The app's own pages, scripts and styles, gzipped once per file version.
const zipped = new Map(); // path → { mtimeMs, body }
function gzipStatic(file) {
  const { mtimeMs } = fs.statSync(file);
  const hit = zipped.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.body;
  const body = zlib.gzipSync(fs.readFileSync(file));
  zipped.set(file, { mtimeMs, body });
  return body;
}
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

const publicSp = (sp) => ({ ...sp, clientSecret: sp.clientSecret ? "••••••••" : "", syncing: syncing.has(sp.id) });
const aiMode = () => (hasApiKey() && getConfig().settings.aiMode !== "offline" ? "claude" : "offline");

// What the app itself depends on, for the monitor page — real state, nothing simulated.
const ago = (iso) => {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return min < 1 ? "just now" : min < 60 ? `${min} min ago` : min < 2880 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} days ago`;
};
function appServices() {
  const cfg = getConfig();
  const i = idx.getIndex();
  const out = cfg.sharepoint.map((sp) => ({
    name: `SharePoint – ${sp.displayName}`,
    status: sp.lastError ? "critical" : sp.syncErrorCount ? "warning" : "good",
    detail: sp.lastError ? `Last sync failed: ${sp.lastError}`
      : `${syncing.has(sp.id) ? "Syncing now · " : ""}${sp.lastSync ? `${(sp.syncedFiles || 0).toLocaleString("en-ZA")} files, synced ${ago(sp.lastSync)}` : "First sync in progress"}${sp.syncErrorCount ? ` · ${sp.syncErrorCount} file(s) not read` : ""}`,
  }));
  out.push({ name: "Document index", status: i.errors.length ? "warning" : "good", detail: `${i.docs.length.toLocaleString("en-ZA")} files, ${i.docs.filter((d) => d.textIndexed).length.toLocaleString("en-ZA")} searchable by content${i.errors.length ? ` · ${i.errors.length} folder problem(s)` : ""}` });
  out.push({ name: "AI assistant", status: aiMode() === "claude" ? "good" : "warning", detail: aiMode() === "claude" ? `Live · ${cfg.settings.model}` : "Offline demo answers — no API key set" });
  out.push({ name: "Microsoft sign-in", status: "good", detail: entra.enabled() ? "On — staff sign in with their Microsoft 365 account" : "Not set up on this server — password sign-in only" });
  return out;
}

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
  "GET /api/monitor": () => ({ ...snapshot(), app: appServices() }),
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
    const microsoftOnly = b.signIn === "microsoft";
    if (microsoftOnly && !entra.enabled()) return [400, { error: "Microsoft sign-in isn't set up on this server" }];
    auth.addUser({ email: b.email, name: b.name, password: b.password, role: b.role === "admin" ? "admin" : "user", microsoftOnly });
    return auth.listUsers();
  },
  "GET /api/documents": (req, url) => {
    const p = Object.fromEntries(url.searchParams);
    // The documents page (page=1): filters combine, newest first, and it reports how many match in all.
    if (p.page) return idx.queryDocs({ q: p.q, type: p.type || undefined, status: p.status || undefined, sourceId: p.source || undefined, area: p.area || undefined, category: p.category || undefined, kind: p.kind || undefined, since: /^\d{4}-\d{2}-\d{2}$/.test(p.since || "") ? p.since : undefined, sort: p.sort, limit: 200 });
    if (p.q) return idx.search(p.q, { type: p.type || undefined, sourceId: p.source || undefined, limit: 200 });
    return idx.listDocs({ type: p.type || undefined, status: p.status || undefined, client: p.client || undefined, sort: p.sort, limit: 500 })
      .filter((d) => !p.source || d.sourceId === p.source);
  },
  "GET /api/documents/facets": () => idx.facets(),
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
  // What the add-site form should ask for: no credentials when the Command Centre's own app is set up.
  "GET /api/sharepoint/options": () => ({ appCredentials: appCredentialsAvailable(), demo: demoEnabled() }),
  "POST /api/sharepoint": async (req) => {
    if (req.user.role !== "admin") return [403, { error: "Only admins can connect SharePoint sites" }];
    const b = await readBody(req);
    const demo = Boolean(b.demo);
    if (demo && !demoEnabled()) return [400, { error: "Demo mode is switched off on this server." }];
    if (!b.siteUrl || !/^https:\/\/[^/]+\.sharepoint\.com/i.test(b.siteUrl)) return [400, { error: "Enter a SharePoint site URL like https://bjfc.sharepoint.com/sites/Projects" }];
    const ownCreds = Boolean(b.tenantId && b.clientId && b.clientSecret);
    if (!demo && !ownCreds && !appCredentialsAvailable()) return [400, { error: "Tenant ID, Client ID and Client secret are required (or tick Demo mode)." }];
    const sp = {
      id: newId(), siteUrl: b.siteUrl.replace(/\/$/, ""), displayName: b.displayName || decodeURIComponent(new URL(b.siteUrl).pathname.split("/").filter(Boolean).pop() || "SharePoint"),
      // Per-site credentials only when given; otherwise the app's ENTRA_* (kept in Key Vault, not config.json).
      tenantId: ownCreds ? b.tenantId : "", clientId: ownCreds ? b.clientId : "", clientSecret: ownCreds ? b.clientSecret : "", demo,
      agentAccess: b.agentAccess !== false, status: "connecting", libraries: [],
      // Optional limits: only these folders are indexed (blank = whole site), and which workbook is the invoice register.
      folders: cleanPaths(b.folders), invoiceRegister: cleanPaths(b.invoiceRegister)[0] || "",
      // listOnly: folders listed by name, their files read from SharePoint only when asked for. exclude: left out.
      listOnly: cleanPaths(b.listOnly), exclude: cleanPaths(b.exclude),
    };
    try {
      const t = await testConnection(sp);
      sp.status = "connected";
      sp.siteName = t.siteName;
      sp.availableLibraries = t.libraries;
    } catch (e) {
      return [400, { error: `Couldn't connect: ${e.message}` }];
    }
    getConfig().sharepoint.push(sp);
    saveConfig();
    syncSite(sp);
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
    if (!d) return json(res, 404, { error: "Not found" });
    // Listed by name only: fetch the text from SharePoint now, for this view (it isn't kept).
    const full = idx.getIndex().byId.get(m[1]);
    if (canReadLive(full)) {
      try {
        const text = await liveText(full);
        return json(res, 200, { ...d, text, live: true, textIndexed: Boolean(text) });
      } catch (e) {
        return json(res, 200, { ...d, live: true, liveError: e.message });
      }
    }
    return json(res, 200, d);
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
    if (req.method !== "POST" && req.user.role !== "admin") return json(res, 403, { error: "Only admins can change SharePoint sites" });
    if (req.method === "DELETE") {
      cfg.sharepoint = cfg.sharepoint.filter((x) => x !== sp);
      idx.setExtraDocs(`sp-${sp.id}`, []);
      forgetSite(sp);
    } else if (req.method === "PATCH") {
      const b = await readBody(req);
      if ("agentAccess" in b) {
        sp.agentAccess = !!b.agentAccess;
        idx.updateExtraDocs(`sp-${sp.id}`, (d) => (d.agentAccess = sp.agentAccess));
      }
      if (["folders", "invoiceRegister", "listOnly", "exclude"].some((k) => k in b)) {
        if ("folders" in b) sp.folders = cleanPaths(b.folders);
        if ("listOnly" in b) sp.listOnly = cleanPaths(b.listOnly);
        if ("exclude" in b) sp.exclude = cleanPaths(b.exclude);
        if ("invoiceRegister" in b) sp.invoiceRegister = cleanPaths(b.invoiceRegister)[0] || "";
        syncSite(sp);
      }
    } else if (m[2] && req.method === "POST") {
      syncSite(sp); // runs in the background; the list shows "Syncing…" until it's done
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

const redirect = (res, location) => {
  res.writeHead(302, { Location: location });
  res.end();
};
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
  res.gzipOk = /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""));
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
    // ---- Microsoft (Entra ID) sign-in ----
    if (url.pathname === "/api/auth-options" && req.method === "GET") return json(res, 200, { microsoft: entra.enabled() });
    if (url.pathname === "/auth/microsoft" && req.method === "GET") {
      if (!entra.enabled()) return redirect(res, "/login.html");
      const host = (req.headers.host || "").toLowerCase();
      const s = entra.start(host, url.searchParams.get("next"));
      res.setHeader("Set-Cookie", s.cookie);
      return redirect(res, s.location);
    }
    if (url.pathname === "/auth/microsoft/callback" && req.method === "GET") {
      const fail = (msg) => {
        res.setHeader("Set-Cookie", entra.clearFlowCookie);
        return redirect(res, `/login.html?error=${encodeURIComponent(msg)}`);
      };
      if (!entra.enabled()) return fail("Microsoft sign-in isn't set up.");
      const ip = clientIp(req);
      if (auth.tooManyAttempts(ip)) return fail("Too many attempts. Try again in 15 minutes.");
      try {
        const who = await entra.finish((req.headers.host || "").toLowerCase(), url, req.headers.cookie);
        const u = auth.userForMicrosoft(who);
        if (!u) {
          console.warn(`Microsoft sign-in refused for ${who.email} (not a Command Centre user, or a different Microsoft account)`);
          return fail(`${who.email} doesn't have access to the Command Centre. Ask the administrator to add you.`);
        }
        const sess = auth.createSession(u);
        res.setHeader("Set-Cookie", [entra.clearFlowCookie, auth.sessionCookie(sess.token, sess.maxAge, isHttps(req))]);
        return redirect(res, who.next || "/");
      } catch (e) {
        if (!(e instanceof entra.SignInError)) console.error("Microsoft sign-in error:", e);
        return fail(e instanceof entra.SignInError ? e.message : "Microsoft sign-in failed. Please try again.");
      }
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
    const type = MIME[path.extname(file)] || "application/octet-stream";
    if (res.gzipOk && /^\.(html|css|js|svg|json|txt)$/.test(path.extname(file))) {
      res.writeHead(200, { "Content-Type": type, "Content-Encoding": "gzip", Vary: "Accept-Encoding" });
      return res.end(gzipStatic(file));
    }
    res.writeHead(200, { "Content-Type": type });
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
