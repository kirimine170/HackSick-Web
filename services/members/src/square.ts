import type { Env } from "./types.ts";
import { squareAccessToken, squareConnectionStatus } from "./square-oauth.ts";

export interface SquareOrder {
  id: string;
  location_id: string;
  reference_id?: string;
  state: string;
  total_money?: { amount: number; currency: string };
  total_tax_money?: { amount: number; currency: string };
  tenders?: { payment_id?: string }[];
  fulfillments?: { type: string; state?: string; shipment_details?: { shipped_at?: string; recipient?: { address?: { country?: string } } } }[];
}
export interface SquarePayment {
  id: string; order_id?: string; location_id?: string; status: string;
  total_money?: { amount: number; currency: string };
  refunded_money?: { amount: number; currency: string };
}
export class SquareRequestError extends Error {
  status: number;
  codes: string[];
  constructor(status: number, codes: string[]) { super("SQUARE_REQUEST_FAILED"); this.status=status; this.codes=codes; }
}
export interface SquareGateway {
  request?<T>(path: string, method?: string, body?: unknown): Promise<T>;
  getOrder(id: string): Promise<SquareOrder>;
  getPayment(id: string): Promise<SquarePayment>;
}

export function checkoutConfigured(env: Env) {
  return env.CHECKOUT_ENABLED === "true" && Boolean((env.SQUARE_ACCESS_TOKEN || (env.SQUARE_CLIENT_ID && env.SQUARE_CLIENT_SECRET)) && env.SQUARE_LOCATION_ID &&
    env.SQUARE_WEBHOOK_SIGNATURE_KEY && env.SQUARE_WEBHOOK_URL === `${new URL(env.AUTH_BASE_URL).origin}/api/square/webhook` &&
    ["sandbox", "production"].includes(env.SQUARE_ENVIRONMENT ?? ""));
}
export async function checkoutAvailable(env: Env) {
  return checkoutConfigured(env) && Boolean(env.SQUARE_ACCESS_TOKEN || (await squareConnectionStatus(env)).connected);
}

/** 許可済みSquareホストのみ．アクセストークンやAPIの生エラーを出力しない． */
export function squareGateway(env: Env): SquareGateway {
  const base = env.SQUARE_ENVIRONMENT === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";
  async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const send = (token: string) => fetch(`${base}/v2${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Square-Version": "2026-09-16", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000),
    });
    let response = await send(await squareAccessToken(env));
    if (response.status === 401 && !env.SQUARE_ACCESS_TOKEN) response = await send(await squareAccessToken(env, true));
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as {errors?:{code?:string}[]};
      throw new SquareRequestError(response.status,(data.errors ?? []).flatMap(e => typeof e.code === "string" ? [e.code] : []));
    }
    return await response.json() as T;
  }
  return {
    request: call,
    async getOrder(id) { return (await call<{ order: SquareOrder }>(`/orders/${encodeURIComponent(id)}`)).order; },
    async getPayment(id) { return (await call<{ payment: SquarePayment }>(`/payments/${encodeURIComponent(id)}`)).payment; },
  };
}

export async function validSquareSignature(body: string, signature: string, key: string, notificationUrl: string) {
  try {
    const bytes = Uint8Array.from(atob(signature), c => c.charCodeAt(0));
    if (bytes.length !== 32) return false;
    const hmac = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    return await crypto.subtle.verify("HMAC", hmac, bytes, new TextEncoder().encode(notificationUrl + body));
  } catch { return false; }
}
