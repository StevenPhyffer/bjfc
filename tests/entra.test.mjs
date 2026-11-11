// Microsoft sign-in: ID token verification, user binding and redirect safety.
// Run with `npm test`. Microsoft is replaced by a locally generated key, so no network is used.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const T = "11111111-2222-3333-4444-555555555555";
const C = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
Object.assign(process.env, {
  ENTRA_TENANT_ID: T,
  ENTRA_CLIENT_ID: C,
  ENTRA_CLIENT_SECRET: "test",
  SESSION_SECRET: "s".repeat(64),
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "bjfc-test-")),
});

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1" };
globalThis.fetch = async () => ({ ok: true, json: async () => ({ keys: [jwk] }) });

const entra = await import("../lib/entra.js");
const auth = await import("../lib/auth.js");

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const sign = (claims, header = { alg: "RS256", kid: "k1" }) => {
  const h = b64(header), p = b64(claims);
  return `${h}.${p}.${crypto.sign("RSA-SHA256", Buffer.from(`${h}.${p}`), privateKey).toString("base64url")}`;
};
const good = {
  iss: `https://login.microsoftonline.com/${T}/v2.0`, aud: C, tid: T, nonce: "n1",
  exp: now + 600, nbf: now - 10, oid: "oid-1", preferred_username: "steven@jarrahlabs.dev",
};

test("accepts a valid ID token", async () => {
  assert.equal((await entra.verifyIdToken(sign(good), "n1")).oid, "oid-1");
});

for (const [name, claims, nonce] of [
  ["wrong nonce", good, "n2"],
  ["wrong audience", { ...good, aud: "other" }, "n1"],
  ["other tenant", { ...good, tid: "x", iss: "https://login.microsoftonline.com/x/v2.0" }, "n1"],
  ["wrong issuer", { ...good, iss: "https://evil.example/v2.0" }, "n1"],
  ["expired", { ...good, exp: now - 3600 }, "n1"],
  ["not yet valid", { ...good, nbf: now + 3600 }, "n1"],
]) {
  test(`rejects: ${name}`, async () => {
    await assert.rejects(entra.verifyIdToken(sign(claims), nonce), entra.SignInError);
  });
}

test("rejects a tampered payload", async () => {
  const parts = sign(good).split(".");
  parts[1] = b64({ ...good, oid: "attacker" });
  await assert.rejects(entra.verifyIdToken(parts.join("."), "n1"), entra.SignInError);
});

test("rejects alg other than RS256", async () => {
  await assert.rejects(entra.verifyIdToken(sign(good, { alg: "none", kid: "k1" }), "n1"), entra.SignInError);
});

test("binds the Entra object id on first sign-in and enforces it after", () => {
  auth.addUser({ email: "amjoubert@bjfc.co.za", name: "Adrian", microsoftOnly: true, role: "admin" });
  assert.ok(auth.userForMicrosoft({ email: "AMJoubert@bjfc.co.za", oid: "o-a" }));
  assert.ok(auth.userForMicrosoft({ email: "amjoubert@bjfc.co.za", oid: "o-a" }));
  assert.equal(auth.userForMicrosoft({ email: "amjoubert@bjfc.co.za", oid: "o-other" }), null);
  assert.equal(auth.userForMicrosoft({ email: "nobody@bjfc.co.za", oid: "o-x" }), null);
});

test("a Microsoft-only user can't sign in with a password", () => {
  assert.equal(auth.login("amjoubert@bjfc.co.za", "anything-long-enough", "203.0.113.1"), null);
});

test("signed values can't be forged", () => {
  const v = auth.signValue({ a: 1 });
  assert.deepEqual(auth.readSigned(v), { a: 1 });
  assert.equal(auth.readSigned(v.replace(/^./, "x")), null);
  assert.equal(auth.readSigned("garbage"), null);
});

test("post-login redirect stays on this site", () => {
  for (const bad of ["//evil.com", "/\\evil.com", "https://evil.com", "evil.com", "", null]) assert.equal(entra.safeNext(bad), "/");
  assert.equal(entra.safeNext("/settings?x=1#a"), "/settings?x=1#a");
});

test("authorize URL uses PKCE and the request host", () => {
  const s = entra.start("bjfc-commandcentre.azurewebsites.net", "/x");
  const u = new URL(s.location);
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("redirect_uri"), "https://bjfc-commandcentre.azurewebsites.net/auth/microsoft/callback");
  assert.match(s.cookie, /HttpOnly; Secure; SameSite=Lax/);
});
