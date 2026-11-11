// Microsoft (Entra ID) sign-in: OpenID Connect authorization-code flow with PKCE, no extra dependencies.
// Enabled when ENTRA_TENANT_ID, ENTRA_CLIENT_ID and ENTRA_CLIENT_SECRET are set (secret via Key Vault).
// Single-tenant: only accounts in that tenant (members or guests) get a token at all; the app then
// still requires the email to be a Command Centre user (auth.userForMicrosoft).
import crypto from "node:crypto";
import { signValue, readSigned } from "./auth.js";

const COOKIE = "bjfc_oidc";
const FLOW_MINUTES = 10;
const env = () => ({ tenant: process.env.ENTRA_TENANT_ID, clientId: process.env.ENTRA_CLIENT_ID, secret: process.env.ENTRA_CLIENT_SECRET });
const authority = () => `https://login.microsoftonline.com/${env().tenant}`;

export const enabled = () => {
  const e = env();
  return Boolean(e.tenant && e.clientId && e.secret);
};

const b64url = (buf) => buf.toString("base64url");
const redirectUri = (host) => `https://${host}/auth/microsoft/callback`;

// Step 1: send the browser to Microsoft. State, nonce and the PKCE verifier ride in a signed,
// short-lived, HttpOnly cookie so the callback can check them (no server-side session store).
export function start(host, next) {
  const state = b64url(crypto.randomBytes(16));
  const nonce = b64url(crypto.randomBytes(16));
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const safeNext = typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  const cookie = signValue({ state, nonce, verifier, next: safeNext, exp: Date.now() + FLOW_MINUTES * 60000 });
  const q = new URLSearchParams({
    client_id: env().clientId,
    response_type: "code",
    redirect_uri: redirectUri(host),
    response_mode: "query",
    scope: "openid profile email",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return {
    location: `${authority()}/oauth2/v2.0/authorize?${q}`,
    cookie: `${COOKIE}=${cookie}; Path=/auth/microsoft; HttpOnly; Secure; SameSite=Lax; Max-Age=${FLOW_MINUTES * 60}`,
  };
}

export const clearFlowCookie = `${COOKIE}=; Path=/auth/microsoft; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

// Step 2: Microsoft redirects back with ?code&state. Check state, swap the code for tokens,
// verify the ID token, and return who signed in: { email, name, oid }.
export async function finish(host, url, cookieHeader) {
  if (url.searchParams.get("error")) throw new SignInError(url.searchParams.get("error_description") || url.searchParams.get("error"));
  const m = String(cookieHeader || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  const flow = m && readSigned(m[1]);
  if (!flow || flow.exp < Date.now()) throw new SignInError("The sign-in took too long or was started in another browser. Please try again.");
  const state = url.searchParams.get("state") || "";
  if (state.length !== flow.state.length || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(flow.state))) throw new SignInError("Sign-in state mismatch. Please try again.");
  const code = url.searchParams.get("code");
  if (!code) throw new SignInError("Microsoft didn't return a sign-in code.");

  const res = await fetch(`${authority()}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env().clientId,
      client_secret: env().secret,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(host),
      code_verifier: flow.verifier,
      scope: "openid profile email",
    }),
  });
  const tok = await res.json().catch(() => ({}));
  if (!res.ok || !tok.id_token) {
    console.error("Entra token exchange failed:", tok.error, tok.error_description);
    throw new SignInError("Microsoft sign-in failed. Please try again.");
  }
  const claims = await verifyIdToken(tok.id_token, flow.nonce);
  const email = String(claims.email || claims.preferred_username || "").toLowerCase();
  if (!email || !claims.oid) throw new SignInError("Your Microsoft account didn't share an email address.");
  return { email, name: claims.name, oid: claims.oid, next: flow.next };
}

export class SignInError extends Error {}

// ---- ID token verification (RS256 against the tenant's published keys) ----
let jwks = { keys: [], fetched: 0 };
async function signingKey(kid) {
  const find = () => jwks.keys.find((k) => k.kid === kid);
  // Refresh at most every 5 minutes, or when a new key id shows up (Microsoft rotates keys).
  if (!find() && Date.now() - jwks.fetched > 5 * 60000) {
    const r = await fetch(`${authority()}/discovery/v2.0/keys`);
    if (!r.ok) throw new SignInError("Couldn't reach Microsoft to check the sign-in.");
    jwks = { keys: (await r.json()).keys || [], fetched: Date.now() };
  }
  const jwk = find();
  if (!jwk) throw new SignInError("Microsoft sign-in key not recognised.");
  return crypto.createPublicKey({ key: jwk, format: "jwk" });
}

export async function verifyIdToken(idToken, nonce) {
  const [h, p, s] = String(idToken).split(".");
  if (!h || !p || !s) throw new SignInError("Malformed sign-in token.");
  const header = JSON.parse(Buffer.from(h, "base64url").toString());
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  if (header.alg !== "RS256") throw new SignInError("Unexpected sign-in token algorithm.");
  const ok = crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), await signingKey(header.kid), Buffer.from(s, "base64url"));
  const now = Math.floor(Date.now() / 1000);
  const e = env();
  if (
    !ok ||
    claims.iss !== `https://login.microsoftonline.com/${e.tenant}/v2.0` ||
    claims.aud !== e.clientId ||
    claims.tid !== e.tenant ||
    claims.nonce !== nonce ||
    !(claims.exp > now - 300) ||
    (claims.nbf && claims.nbf > now + 300)
  ) {
    throw new SignInError("The Microsoft sign-in token couldn't be verified.");
  }
  return claims;
}
