// Login & sessions. Users live in data/users.json with scrypt-hashed passwords.
// Sessions are HMAC-signed cookies (stateless, survive restarts).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { APP_ROOT, setEnvVar } from "./config.js";

const USERS_PATH = path.join(APP_ROOT, "data", "users.json");
const COOKIE = "bjfc_session";
const SESSION_DAYS = 7;

const readUsers = () => {
  try {
    return JSON.parse(fs.readFileSync(USERS_PATH, "utf8"));
  } catch {
    return [];
  }
};
const writeUsers = (u) => {
  fs.mkdirSync(path.dirname(USERS_PATH), { recursive: true });
  fs.writeFileSync(USERS_PATH, JSON.stringify(u, null, 2), { mode: 0o600 });
};

function hash(password, salt = crypto.randomBytes(16).toString("hex")) {
  const h = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${h}`;
}
function verify(password, stored) {
  const [, salt, h] = String(stored).split("$");
  if (!salt || !h) return false;
  const test = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(h, "hex"));
}

function secret() {
  if (!process.env.SESSION_SECRET) setEnvVar("SESSION_SECRET", crypto.randomBytes(32).toString("hex"));
  return process.env.SESSION_SECRET;
}
const sign = (data) => crypto.createHmac("sha256", secret()).update(data).digest("base64url");

export function addUser({ email, name, password, role = "admin" }) {
  email = String(email).trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("Enter a valid email address");
  if (String(password).length < 10) throw new Error("Password must be at least 10 characters");
  const users = readUsers();
  if (users.some((u) => u.email === email)) throw new Error("A user with that email already exists");
  users.push({ id: crypto.randomBytes(6).toString("hex"), email, name: name || email.split("@")[0], role, hash: hash(password), created: new Date().toISOString() });
  writeUsers(users);
}

export function setPassword(email, password) {
  if (String(password).length < 10) throw new Error("Password must be at least 10 characters");
  const users = readUsers();
  const u = users.find((x) => x.email === String(email).toLowerCase());
  if (!u) throw new Error("No such user");
  u.hash = hash(password);
  u.sessionVersion = (u.sessionVersion || 0) + 1; // signs out other sessions
  writeUsers(users);
}

export const listUsers = () => readUsers().map(({ hash, ...u }) => u);
export const hasUsers = () => readUsers().length > 0;

// First start with no users: create the admin from env vars, or generate a password and print it once.
export function ensureAdmin() {
  if (hasUsers()) return null;
  const email = process.env.ADMIN_EMAIL || "admin@bjfc.co.za";
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString("base64url");
  addUser({ email, name: process.env.ADMIN_NAME || "Director", password });
  return process.env.ADMIN_PASSWORD ? { email } : { email, password };
}

// ---- Brute-force protection: 5 failures per IP / 15 min ----
const attempts = new Map();
export function tooManyAttempts(ip) {
  const a = attempts.get(ip);
  return a && a.count >= 5 && Date.now() - a.first < 15 * 60000;
}
function noteFailure(ip) {
  const a = attempts.get(ip);
  if (!a || Date.now() - a.first > 15 * 60000) attempts.set(ip, { count: 1, first: Date.now() });
  else a.count++;
}

export function login(email, password, ip) {
  const u = readUsers().find((x) => x.email === String(email || "").trim().toLowerCase());
  // Always run a hash so response time doesn't reveal whether the email exists.
  const ok = u ? verify(String(password || ""), u.hash) : (verify("x", hash("y")), false);
  if (!ok) {
    noteFailure(ip);
    return null;
  }
  attempts.delete(ip);
  const exp = Date.now() + SESSION_DAYS * 86400000;
  const payload = Buffer.from(JSON.stringify({ id: u.id, v: u.sessionVersion || 0, exp })).toString("base64url");
  return { token: `${payload}.${sign(payload)}`, user: { name: u.name, email: u.email, role: u.role }, maxAge: SESSION_DAYS * 86400 };
}

export function userFromRequest(req) {
  const m = (req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const [payload, sig] = m[1].split(".");
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (p.exp < Date.now()) return null;
    const u = readUsers().find((x) => x.id === p.id);
    if (!u || (u.sessionVersion || 0) !== p.v) return null;
    return { id: u.id, name: u.name, email: u.email, role: u.role };
  } catch {
    return null;
  }
}

export function sessionCookie(token, maxAge, secure) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
export const clearCookie = (secure) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
