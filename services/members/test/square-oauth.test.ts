import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { beginSquareAuthorization, finishSquareAuthorization, encryptTokens, decryptTokens, squareAccessToken, squareConnectionStatus, SQUARE_SCOPES } from "../src/square-oauth.ts";
import type { Env } from "../src/types.ts";

test("Square OAuthトークンの暗号化をアプリ・環境へ束縛する", async () => {
  const env = { BETTER_AUTH_SECRET: "test-only-32-character-secret-for-encryption", SQUARE_ENVIRONMENT: "production", SQUARE_CLIENT_ID: "test-app" } as Env;
  const tokens = { access_token: "private-access", refresh_token: "private-refresh", merchant_id: "merchant", expires_at: new Date(Date.now()+86400000).toISOString() };
  const cipher = await encryptTokens(env, tokens); assert.equal(cipher.includes(tokens.access_token), false); assert.equal(cipher.includes(tokens.refresh_token), false);
  assert.deepEqual(await decryptTokens(env, cipher), tokens);
  await assert.rejects(() => decryptTokens({ ...env, SQUARE_ENVIRONMENT: "sandbox" }, cipher));
  await assert.rejects(() => decryptTokens({ ...env, SQUARE_CLIENT_ID: "another-app" }, cipher));
});

test("Square OAuthのstate再利用・異なる店舗を拒否し，権限を増やさず更新する", async t => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {fetch(){return new Response('test')}}", d1Databases: ["DB"], compatibilityDate: "2026-11-03" }));
  t.after(() => mf.dispose()); const db = await mf.getD1Database("DB");
  for (const file of (await readdir("migrations")).filter(f => f.endsWith(".sql")).sort()) {
    const sql = (await readFile(`migrations/${file}`, "utf8")).replace(/^--.*$/gm, "");
    await db.batch(sql.split(";").map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
  }
  await db.prepare('INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,?,?)').bind("operator", "試験運営", "operator@example.invalid", Date.now(), Date.now()).run();
  await db.prepare("INSERT INTO operators VALUES ('operator','manager',?)").bind(new Date().toISOString()).run();
  const env = { DB: db, AUTH_BASE_URL: "https://members.example.invalid", BETTER_AUTH_SECRET: "test-only-32-character-secret-for-encryption", SQUARE_ENVIRONMENT: "production", SQUARE_CLIENT_ID: "test-app", SQUARE_CLIENT_SECRET: "test-secret", SQUARE_LOCATION_ID: "location" } as unknown as Env;
  let refreshes = 0; let wrongLocation = false;
  const actuallyGranted = SQUARE_SCOPES.filter(scope => scope !== "CUSTOMERS_WRITE");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://connect.squareup.com/oauth2/token") {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.client_id, "test-app");
      if (body.grant_type === "refresh_token") { refreshes++; assert.equal(body.scopes, undefined); }
      return Response.json({ access_token: `private-access-${refreshes}`, refresh_token: "private-refresh", merchant_id: "merchant", expires_at: new Date(Date.now()+30*86400000).toISOString() });
    }
    if (url === "https://connect.squareup.com/oauth2/token/status") return Response.json({ client_id: "test-app", merchant_id: "merchant", scopes: actuallyGranted });
    assert.equal(url, "https://connect.squareup.com/v2/locations/location");
    return Response.json({ location: { id: wrongLocation ? "other" : "location", currency: "JPY", merchant_id: "merchant" } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const begin = await beginSquareAuthorization(env, "operator"); const target = new URL(begin.url);
  assert.equal(target.origin, "https://connect.squareup.com"); assert.equal(target.searchParams.get("scope"), SQUARE_SCOPES.join(" "));
  assert.ok(!SQUARE_SCOPES.some(scope => /BANK|CARDS|SUBSCRIPTIONS_WRITE|INVENTORY_WRITE|ITEMS_WRITE/.test(scope)));
  assert.ok(SQUARE_SCOPES.includes("CUSTOMERS_WRITE"));
  await assert.rejects(() => finishSquareAuthorization(env, new URL(`${env.AUTH_BASE_URL}/api/square/oauth/callback?code=fake&state=${"x".repeat(43)}`)));
  const cb = new URL(`${env.AUTH_BASE_URL}/api/square/oauth/callback`); cb.searchParams.set("state", target.searchParams.get("state")!); cb.searchParams.set("code", "test-code");
  await finishSquareAuthorization(env, cb); await assert.rejects(() => finishSquareAuthorization(env, cb));
  const connection = await squareConnectionStatus(env);
  assert.equal(connection.scopes.includes("CUSTOMERS_WRITE"), false);
  assert.equal(connection.requestedScopes.includes("CUSTOMERS_WRITE"), true);
  const stored = await db.prepare("SELECT encrypted_tokens FROM square_connections").first<{ encrypted_tokens: string }>(); assert.equal(stored!.encrypted_tokens.includes("private-access"), false);
  assert.equal(await squareAccessToken(env), "private-access-0");
  await db.prepare("UPDATE square_connections SET refreshed_at = ?").bind(new Date(Date.now()-7*86400000).toISOString()).run();
  assert.equal(await squareAccessToken(env), "private-access-1"); assert.equal(refreshes, 1);
  wrongLocation = true; const retry = new URL((await beginSquareAuthorization(env, "operator")).url); cb.searchParams.set("state", retry.searchParams.get("state")!);
  await assert.rejects(() => finishSquareAuthorization(env, cb));
});
