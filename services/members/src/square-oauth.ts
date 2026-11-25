import type { Env } from "./types.ts";

export const SQUARE_SCOPES = ["MERCHANT_PROFILE_READ", "ORDERS_READ", "ORDERS_WRITE", "PAYMENTS_READ", "PAYMENTS_WRITE", "CUSTOMERS_READ", "CUSTOMERS_WRITE", "SUBSCRIPTIONS_READ", "INVOICES_READ", "ITEMS_READ", "INVENTORY_READ"] as const;
const encoder = new TextEncoder();
const base = (env: Env) => env.SQUARE_ENVIRONMENT === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";
const callback = (env: Env) => `${new URL(env.AUTH_BASE_URL).origin}/api/square/oauth/callback`;
const bytes64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const from64 = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));
interface Tokens { access_token: string; refresh_token: string; merchant_id: string; expires_at: string }
interface Connection { environment: string; merchant_id: string; client_id: string; encrypted_tokens: string; access_expires_at: string; refreshed_at: string; connected_by: string }
async function tokenScopes(env: Env, accessToken: string, merchantId: string) {
  const response = await fetch(`${base(env)}/oauth2/token/status`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", "Square-Version": "2026-09-16" }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error("SQUARE_TOKEN_STATUS_UNAVAILABLE");
  const value = await response.json() as { client_id: string; merchant_id: string; scopes: string[] };
  if (value.client_id !== env.SQUARE_CLIENT_ID || value.merchant_id !== merchantId || !Array.isArray(value.scopes) || value.scopes.some(scope => typeof scope !== "string")) throw new Error("SQUARE_TOKEN_APPLICATION_MISMATCH");
  return value.scopes;
}
export async function encryptTokens(env: Env, tokens: Tokens) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(env);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(`square:${env.SQUARE_ENVIRONMENT}:${env.SQUARE_CLIENT_ID}`) }, key, encoder.encode(JSON.stringify(tokens)));
  return `${bytes64(iv)}.${bytes64(new Uint8Array(encrypted))}`;
}
async function encryptionKey(env: Env) {
  const material = await crypto.subtle.digest("SHA-256", encoder.encode(`${env.BETTER_AUTH_SECRET}:square-oauth-v1`));
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function decryptTokens(env: Env, cipher: string): Promise<Tokens> {
  const [iv, encrypted] = cipher.split(".");
  const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: from64(iv), additionalData: encoder.encode(`square:${env.SQUARE_ENVIRONMENT}:${env.SQUARE_CLIENT_ID}`) }, await encryptionKey(env), from64(encrypted));
  return JSON.parse(new TextDecoder().decode(bytes));
}
async function digest(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))), b => b.toString(16).padStart(2, "0")).join("");
}
async function obtainToken(env: Env, input: Record<string, unknown>): Promise<Tokens> {
  const result = await fetch(`${base(env)}/oauth2/token`, { method: "POST", headers: { "Content-Type": "application/json", "Square-Version": "2026-09-16" },
    body: JSON.stringify({ client_id: env.SQUARE_CLIENT_ID, client_secret: env.SQUARE_CLIENT_SECRET, redirect_uri: callback(env), ...input }), signal: AbortSignal.timeout(15000) });
  if (!result.ok) throw new Error("SQUARE_OAUTH_FAILED");
  const tokens = await result.json() as Tokens;
  if (!tokens.access_token || !tokens.refresh_token || !tokens.merchant_id || !Number.isFinite(Date.parse(tokens.expires_at))) throw new Error("INVALID_SQUARE_TOKENS");
  return tokens;
}
export async function beginSquareAuthorization(env: Env, actor: string) {
  if (!env.SQUARE_CLIENT_ID || !env.SQUARE_CLIENT_SECRET || !env.SQUARE_ENVIRONMENT) throw new Error("SQUARE_OAUTH_NOT_CONFIGURED");
  const state = bytes64(crypto.getRandomValues(new Uint8Array(32))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  await env.DB.prepare("INSERT INTO square_oauth_states (state_hash,actor_user_id,expires_at) VALUES (?,?,?)").bind(await digest(state), actor, new Date(Date.now() + 10 * 60000).toISOString()).run();
  const url = new URL(`${base(env)}/oauth2/authorize`);
  url.search = new URLSearchParams({ client_id: env.SQUARE_CLIENT_ID, scope: SQUARE_SCOPES.join(" "), state, session: "false", redirect_uri: callback(env), locale: "ja-JP" }).toString();
  return { url: url.href, scopes: SQUARE_SCOPES };
}
export async function finishSquareAuthorization(env: Env, url: URL) {
  const state = url.searchParams.get("state"); const code = url.searchParams.get("code");
  if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || !code || code.length > 2048) throw new Error("INVALID_OAUTH_CALLBACK");
  const hash = await digest(state); const now = new Date().toISOString();
  const pending = await env.DB.prepare("SELECT s.actor_user_id FROM square_oauth_states s JOIN operators o ON o.auth_user_id = s.actor_user_id WHERE s.state_hash = ? AND s.used_at IS NULL AND s.expires_at > ? AND o.role = 'manager'").bind(hash, now).first<{ actor_user_id: string }>();
  if (!pending) throw new Error("OAUTH_STATE_EXPIRED");
  const used = await env.DB.prepare("UPDATE square_oauth_states SET used_at = ? WHERE state_hash = ? AND used_at IS NULL AND expires_at > ?").bind(now, hash, now).run();
  if (!used.meta.changes) throw new Error("OAUTH_STATE_USED");
  const tokens = await obtainToken(env, { grant_type: "authorization_code", code });
  const locationResult = await fetch(`${base(env)}/v2/locations/${encodeURIComponent(env.SQUARE_LOCATION_ID!)}`, { headers: { Authorization: `Bearer ${tokens.access_token}`, "Square-Version": "2026-09-16" }, signal: AbortSignal.timeout(15000) });
  if (!locationResult.ok) throw new Error("SQUARE_LOCATION_MISMATCH");
  const data = await locationResult.json() as { location?: { id: string; currency: string; merchant_id: string } };
  if (!data.location || data.location.id !== env.SQUARE_LOCATION_ID || data.location.currency !== "JPY" || data.location.merchant_id !== tokens.merchant_id) throw new Error("SQUARE_LOCATION_MISMATCH");
  const scopes = await tokenScopes(env, tokens.access_token, tokens.merchant_id);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO square_connections (environment,merchant_id,client_id,encrypted_tokens,access_expires_at,refreshed_at,connected_by) VALUES (?,?,?,?,?,?,?) ON CONFLICT(environment) DO UPDATE SET merchant_id=excluded.merchant_id,client_id=excluded.client_id,encrypted_tokens=excluded.encrypted_tokens,access_expires_at=excluded.access_expires_at,refreshed_at=excluded.refreshed_at,connected_by=excluded.connected_by")
      .bind(env.SQUARE_ENVIRONMENT!, tokens.merchant_id, env.SQUARE_CLIENT_ID!, await encryptTokens(env, tokens), tokens.expires_at, now, pending.actor_user_id),
    env.DB.prepare("UPDATE square_connections SET granted_scopes_json=?,scopes_checked_at=? WHERE environment=? AND client_id=?").bind(JSON.stringify(scopes),now,env.SQUARE_ENVIRONMENT!,env.SQUARE_CLIENT_ID!),
    env.DB.prepare("INSERT INTO shop_audit VALUES (?,?, 'square.connect', ?, ?)").bind(crypto.randomUUID(), pending.actor_user_id, JSON.stringify({ merchantId: tokens.merchant_id, scopes }), now),
  ]);
}
export async function squareConnectionStatus(env: Env): Promise<{ connected: boolean; scopes: string[]; requestedScopes: readonly string[]; merchantId?: string; expiresAt?: string; refreshedAt?: string }> {
  if (!env.SQUARE_CLIENT_ID) return { connected: false, scopes: [], requestedScopes: SQUARE_SCOPES };
  const row = await env.DB.prepare("SELECT * FROM square_connections WHERE environment = ? AND client_id = ?").bind(env.SQUARE_ENVIRONMENT!, env.SQUARE_CLIENT_ID).first<Connection & { granted_scopes_json: string | null; scopes_checked_at: string | null }>();
  let scopes: string[] = row?.granted_scopes_json ? JSON.parse(row.granted_scopes_json) : [];
  const connected = Boolean(row && Date.parse(row.access_expires_at) > Date.now());
  if (row && connected && (!row.scopes_checked_at || Date.parse(row.scopes_checked_at) < Date.now() - 300000)) {
    try {
      const tokens = await decryptTokens(env, row.encrypted_tokens); scopes = await tokenScopes(env, tokens.access_token, row.merchant_id);
      await env.DB.prepare("UPDATE square_connections SET granted_scopes_json=?,scopes_checked_at=? WHERE environment=? AND client_id=?").bind(JSON.stringify(scopes),new Date().toISOString(),env.SQUARE_ENVIRONMENT!,env.SQUARE_CLIENT_ID).run();
    } catch { scopes = []; }
  }
  return { connected, scopes, requestedScopes: SQUARE_SCOPES, ...(row ? { merchantId: row.merchant_id, expiresAt: row.access_expires_at, refreshedAt: row.refreshed_at } : {}) };
}
export async function squareAccessToken(env: Env, forceRefresh = false) {
  if (env.SQUARE_ACCESS_TOKEN) {
    if (env.SQUARE_ENVIRONMENT !== "sandbox") throw new Error("PRODUCTION_OAUTH_REQUIRED");
    return env.SQUARE_ACCESS_TOKEN;
  }
  const row = await env.DB.prepare("SELECT * FROM square_connections WHERE environment = ? AND client_id = ?").bind(env.SQUARE_ENVIRONMENT!, env.SQUARE_CLIENT_ID!).first<Connection>();
  if (!row) throw new Error("SQUARE_NOT_CONNECTED");
  const tokens = await decryptTokens(env, row.encrypted_tokens);
  const age = Date.now() - Date.parse(row.refreshed_at);
  if (!forceRefresh && age < 6 * 86400000 && Date.parse(tokens.expires_at) > Date.now() + 86400000) return tokens.access_token;
  // scopesを省略すると，Squareは既存の許可を維持する．再承認前の権限追加を更新要求に混ぜない．
  const refreshed = await obtainToken(env, { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
  if (refreshed.merchant_id !== row.merchant_id) throw new Error("SQUARE_MERCHANT_MISMATCH");
  await env.DB.prepare("UPDATE square_connections SET encrypted_tokens = ?, access_expires_at = ?, refreshed_at = ? WHERE environment = ? AND refreshed_at = ?")
    .bind(await encryptTokens(env, refreshed), refreshed.expires_at, new Date().toISOString(), row.environment, row.refreshed_at).run();
  // Codeフローのrefresh tokenは複数回利用可．同時更新の後はDBに確定した値を使う．
  const updated = await env.DB.prepare("SELECT encrypted_tokens FROM square_connections WHERE environment = ?").bind(row.environment).first<{ encrypted_tokens: string }>();
  return (await decryptTokens(env, updated!.encrypted_tokens)).access_token;
}
