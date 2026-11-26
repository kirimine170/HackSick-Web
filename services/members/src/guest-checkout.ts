import type { Env } from "./types.ts";

const lifetime = 30 * 86400;
const encoder = new TextEncoder();

export async function shopGuest(request: Request, env: Env, create: boolean) {
  const origin = new URL(request.url).origin;
  const secure = origin.startsWith("https:");
  const name = secure ? "__Host-hacksick-guest" : "hacksick-guest";
  const value = request.headers.get("Cookie")?.split(/;\s*/).find(cookie => cookie.startsWith(name + "="))?.slice(name.length + 1);
  const token = /^([0-9a-f-]{36})\.(\d{10})\.([0-9a-f]{64})$/.exec(value ?? "");
  const now = Math.floor(Date.now() / 1000);
  if (!token && !create) return null;
  const key = await crypto.subtle.importKey("raw", encoder.encode(env.BETTER_AUTH_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const payload = (id: string, expires: string) => encoder.encode(`shop-guest\n${origin}\n${id}\n${expires}`);
  if (token) {
    const [, id, expires, signature] = token;
    const bytes = Uint8Array.from(signature.match(/../g)!, b => parseInt(b, 16));
    if (Number(expires) > now && await crypto.subtle.verify("HMAC", key, bytes, payload(id, expires))) {
      return { id: `guest-${id}`, email: `${id}@guest.invalid` };
    }
  }
  if (!create) return null;
  const id = crypto.randomUUID();
  const expires = String(now + lifetime);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, payload(id, expires)));
  const signature = Array.from(mac, b => b.toString(16).padStart(2, "0")).join("");
  const cookie = `${name}=${id}.${expires}.${signature}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${lifetime}${secure ? "; Secure" : ""}`;
  return { id: `guest-${id}`, email: `${id}@guest.invalid`, cookie };
}

export async function ensureGuestActor(db: D1Database, guest: { id: string; email: string }) {
  const now = new Date().toISOString();
  // 配送先メールをログインや会員照合に使わない．注文の宛先とは別の参照IDを作る．
  await db.prepare('INSERT OR IGNORE INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,0,?,?)')
    .bind(guest.id, "ゲスト購入", guest.email, now, now).run();
}
