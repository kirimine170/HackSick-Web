import { eligibility, InputError, normalizeEmail, requiredText } from "./eligibility.ts";
import type { Grant, Member } from "./types.ts";
import { MEMBER_PRICING } from "./member-pricing.ts";
import { SHIPPING_POLICY } from "./shipping-policy.ts";

// 収益モデル案の4,000円とは分離し，現在公開中の送料条件を使う．
export const CHECKOUT_POLICY = { version: "member-shop-2026-11-06", discountPercent: MEMBER_PRICING.oneTimeDiscountPercent, recurringDiscountPercent: MEMBER_PRICING.recurringDiscountPercent, recurringCheckoutEnabled: MEMBER_PRICING.recurringCheckoutEnabled, shippingFeeJpy: SHIPPING_POLICY.shippingFeeJpy, freeShippingThresholdJpy: SHIPPING_POLICY.freeShippingThresholdJpy } as const;
export const SHOP_PRODUCTS = [
  { sku: "HS-COFFEE-MOCHA-10G", name: "Burn the midnight oil｜ドリップバッグ 1袋（10g）", unitPriceJpy: 432, bags: 1 },
  { sku: "HS-COFFEE-MOCHA-5PACK", name: "Burn the midnight oil｜ドリップバッグ 5袋セット", unitPriceJpy: 2052, bags: 5 },
] as const;
export const BOOK_PRODUCT = { sku: "HS-BOOK-ANOKOTO-A5", name: "あのことの関係性について", unitPriceJpy: 1500, bags: 0 } as const;
export const STOREFRONT_PRODUCTS = [...SHOP_PRODUCTS, BOOK_PRODUCT] as const;
export class CheckoutConflict extends Error {}
export interface CheckoutProduct { sku: string; name: string; unitPriceJpy: number; bags: number }
export interface CartLine { sku: string; quantity: number }

export function memberQuote(items: unknown, options: { eligible: boolean; storefront: boolean; extras?: CheckoutProduct[] } = { eligible: true, storefront: false }) {
  const products = [...(options.storefront ? STOREFRONT_PRODUCTS : SHOP_PRODUCTS), ...(options.extras ?? [])];
  if (!Array.isArray(items) || !items.length || items.length > products.length) throw new InputError("商品と数量を確認してください．");
  const seen = new Set<string>();
  const lines = items.map(item => {
    if (!item || typeof item !== "object") throw new InputError("商品を確認してください．");
    const { sku, quantity } = item as CartLine;
    const product = products.find(p => p.sku === sku);
    if (!product || seen.has(sku) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100) throw new InputError("商品と数量を確認してください．");
    seen.add(sku);
    const { name, unitPriceJpy, bags } = product;
    return { sku, name, unitPriceJpy, bags, quantity, subtotalJpy: unitPriceJpy * quantity };
  }).sort((a, b) => a.sku.localeCompare(b.sku));
  const subtotalJpy = lines.reduce((n, l) => n + l.subtotalJpy, 0);
  const discountPercent = options.eligible ? Number(CHECKOUT_POLICY.discountPercent) : 0;
  const discountableJpy = lines.reduce((sum, line) => sum + (line.bags > 0 ? line.subtotalJpy : 0), 0);
  const discountJpy = Math.round(discountableJpy * discountPercent / 100);
  const shippingJpy = subtotalJpy >= CHECKOUT_POLICY.freeShippingThresholdJpy ? 0 : CHECKOUT_POLICY.shippingFeeJpy;
  return { policyVersion: CHECKOUT_POLICY.version as string, lines, subtotalJpy, discountPercent, discountJpy, shippingJpy, totalJpy: subtotalJpy - discountJpy + shippingJpy, bags: lines.reduce((n, l) => n + l.bags * l.quantity, 0) };
}

export function allocateDiscount(discountJpy: number, subtotals: number[]) {
  const subtotal = subtotals.reduce((sum, amount) => sum + amount, 0);
  if (!Number.isSafeInteger(discountJpy) || discountJpy < 0 || discountJpy > subtotal) throw new InputError("割引条件を確認してください．");
  if (!discountJpy) return subtotals.map(() => 0);
  const allocations = subtotals.map(amount => Math.floor(discountJpy * amount / subtotal));
  let remaining = discountJpy - allocations.reduce((sum, amount) => sum + amount, 0);
  for (let i = 0; remaining > 0; i++) {
    if (subtotals[i] > 0) {
      allocations[i]++;
      remaining--;
    }
  }
  return allocations;
}

export async function ensureBuyer(db: D1Database, user: { id: string; email: string; name?: string }) {
  const email = normalizeEmail(user.email);
  const now = new Date().toISOString();
  // 既存会員は /api/me で照合する．台帳と競合する場合は購入者を二重作成しない．
  await db.prepare(`INSERT OR IGNORE INTO members (id,display_name,claim_email,auth_user_id,status,created_at,updated_at)
    SELECT ?,?,?,?,'active',?,? WHERE NOT EXISTS (SELECT 1 FROM member_emails WHERE email=? COLLATE NOCASE)`)
    .bind(`BUYER-${crypto.randomUUID()}`, user.name?.slice(0, 100) || "購入者", email, user.id, now, now, email).run();
  const linked = await db.prepare("SELECT id,status FROM members WHERE auth_user_id=?").bind(user.id).first<{ id: string; status: string }>();
  if (!linked) throw new CheckoutConflict("ログイン情報を再読み込みしてからお試しください．");
  if (linked.status === "blocked") throw new CheckoutConflict("購入について運営へお問い合わせください．");
  return linked.id;
}

export function shippingRecipient(input: unknown, email: string) {
  if (!input || typeof input !== "object") throw new InputError("国内の配送先を入力してください．");
  const body = input as Record<string, unknown>;
  if (body.country !== "JP") throw new InputError("配送先は日本国内に限ります．");
  const postalCode = requiredText(body.postalCode, "郵便番号", 8).replaceAll("-", "");
  if (!/^\d{7}$/.test(postalCode)) throw new InputError("郵便番号を確認してください．");
  const prefectures = ["北海道","青森県","岩手県","宮城県","秋田県","山形県","福島県","茨城県","栃木県","群馬県","埼玉県","千葉県","東京都","神奈川県","新潟県","富山県","石川県","福井県","山梨県","長野県","岐阜県","静岡県","愛知県","三重県","滋賀県","京都府","大阪府","兵庫県","奈良県","和歌山県","鳥取県","島根県","岡山県","広島県","山口県","徳島県","香川県","愛媛県","高知県","福岡県","佐賀県","長崎県","熊本県","大分県","宮崎県","鹿児島県","沖縄県"];
  const prefecture = requiredText(body.prefecture, "都道府県", 4);
  if (!prefectures.includes(prefecture)) throw new InputError("都道府県を確認してください．");
  const phone = requiredText(body.phone, "電話番号", 25).replace(/[\s()-]/g, "");
  if (!/^(?:0\d{9,10}|\+81\d{9,10})$/.test(phone)) throw new InputError("国内の電話番号を確認してください．");
  return {
    display_name: requiredText(body.name, "お届け先の氏名", 100), email_address: email,
    phone_number: phone.startsWith("0") ? `+81${phone.slice(1)}` : phone,
    address: { country: "JP", postal_code: postalCode, administrative_district_level_1: prefecture,
      locality: requiredText(body.city, "市区町村", 100), address_line_1: requiredText(body.addressLine1, "町名・番地", 200),
      ...(body.addressLine2 ? { address_line_2: requiredText(body.addressLine2, "建物名・部屋番号", 200) } : {}) },
  };
}

export async function memberAccess(db: D1Database, userId: string) {
  const member = await db.prepare("SELECT * FROM members WHERE auth_user_id = ?").bind(userId).first<Member>();
  const grants = member ? (await db.prepare("SELECT * FROM membership_grants WHERE member_id = ?").bind(member.id).all<Grant>()).results : [];
  return { member, grants, benefit: eligibility(member?.status ?? "unlinked", grants) };
}
