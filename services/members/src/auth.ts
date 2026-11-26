import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins/email-otp";
import { essenStaff } from "./fulfillment.ts";
import type { Env } from "./types.ts";

export type DeliverOTP = (message: { email: string; otp: string; type: string }) => Promise<void>;

export function createAuth(env: Env, deliverOTP?: DeliverOTP, origin = new URL(env.AUTH_BASE_URL).origin, partner = false) {
  const storefront = origin !== new URL(env.AUTH_BASE_URL).origin;
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) throw new Error("AUTH_NOT_CONFIGURED");
  if (!origin.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1):/.test(origin)) throw new Error("HTTPS_REQUIRED");
  return betterAuth({
    appName: "HackSick Members",
    baseURL: origin,
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    trustedOrigins: [origin],
    emailAndPassword: { enabled: false },
    account: { encryptOAuthTokens: true, accountLinking: { enabled: true, trustedProviders: ["google"], allowDifferentEmails: false } },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24, cookieCache: { enabled: false } },
    advanced: {
      ...(storefront ? { cookiePrefix: partner ? "hacksick-fulfillment" : "hacksick-shop" } : {}),
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure: origin.startsWith("https://") },
    },
    socialProviders: !storefront && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        hd: env.GOOGLE_WORKSPACE_DOMAIN,
        prompt: "select_account",
      },
    } : {},
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 60,
      customRules: {
        "/email-otp/send-verification-otp": { window: 60, max: 3 },
        "/sign-in/email-otp": { window: 60, max: 5 },
      },
    },
    plugins: [emailOTP({
      disableSignUp: false,
      otpLength: 6,
      expiresIn: 300,
      allowedAttempts: 5,
      storeOTP: "hashed",
      async sendVerificationOTP(message) {
        if (partner && !await essenStaff(env.DB, message.email)) return;
        if (deliverOTP) return deliverOTP(message);
        if (!env.RESEND_API_KEY) throw new Error("MAIL_NOT_CONFIGURED");
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: env.MAIL_FROM,
            to: [message.email],
            subject: "HackSick ログイン確認コード",
            text: `確認コードは ${message.otp} です．\n5分以内に入力してください．\n心当たりがない場合は，このメールを破棄してください．`,
          }),
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error("MAIL_DELIVERY_FAILED");
      },
    })],
    telemetry: { enabled: false },
    logger: { disabled: true },
  });
}
