import { InputError } from "./eligibility.ts";
import type { Env } from "./types.ts";

const encoder = new TextEncoder();
const prefix = "HS1.";
const lifetimeMs = 120_000;
const context = "hacksick-member-pass-v1";
type PassEnvironment = Pick<Env, "AUTH_BASE_URL" | "BETTER_AUTH_SECRET">;
type MemberPass = { memberId: string; userId: string; expiresAt: number };

async function passKey(env: PassEnvironment) {
  const material = encoder.encode(`${context}:${env.BETTER_AUTH_SECRET}`);
  const digest = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function associatedData(env: PassEnvironment) {
  return encoder.encode(`${context}:${new URL(env.AUTH_BASE_URL).origin}`);
}

export async function issueMemberPass(env: PassEnvironment, memberId: string, userId: string, now = Date.now()) {
  const expiresAt = now + lifetimeMs;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify({ memberId, userId, expiresAt }));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: associatedData(env) }, await passKey(env), plaintext,
  ));
  const bytes = new Uint8Array(iv.length + ciphertext.length);
  bytes.set(iv);
  bytes.set(ciphertext, iv.length);
  const code = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return { token: prefix + code, expiresAt };
}

export async function readMemberPass(env: PassEnvironment, token: unknown, now = Date.now()): Promise<MemberPass> {
  const invalid = () => new InputError("有効な会員QRを読み取ってください．");
  if (typeof token !== "string" || !/^HS1\.[A-Za-z0-9_-]{40,512}$/.test(token)) throw invalid();
  let pass: Partial<MemberPass> | null;
  try {
    const bytes = Uint8Array.from(atob(token.slice(prefix.length).replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: associatedData(env) }, await passKey(env), bytes.slice(12),
    );
    pass = JSON.parse(new TextDecoder().decode(plaintext)) as Partial<MemberPass> | null;
  } catch {
    throw invalid();
  }
  if (!pass || typeof pass.memberId !== "string" || !pass.memberId || typeof pass.userId !== "string" || !pass.userId ||
      typeof pass.expiresAt !== "number" || !Number.isSafeInteger(pass.expiresAt) || pass.expiresAt > now + lifetimeMs) throw invalid();
  if (pass.expiresAt <= now) throw new InputError("会員QRの有効期限が切れました．会員画面で更新してください．");
  return { memberId: pass.memberId, userId: pass.userId, expiresAt: pass.expiresAt };
}
