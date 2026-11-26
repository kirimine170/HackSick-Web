import { BOOK_PRODUCT, memberAccess, memberQuote, STOREFRONT_PRODUCTS, type CheckoutProduct } from "./checkout.ts";
import { InputError, normalizeEmail, requiredText } from "./eligibility.ts";
import type { Env } from "./types.ts";

export type FulfillmentSource = "hacksick" | "essen";
export interface ShopProduct extends CheckoutProduct {
  square_item_id: string;
  description: string;
  required_status: string | null;
  fulfillment_source: FulfillmentSource;
  enabled: number;
  has_photo: number;
}
interface Coupon {
  id: string;
  code: string;
  label: string;
  percent: number;
  allowed_skus_json: string;
  recipient_email: string | null;
  expires_at: string;
  account_limit: number;
  use_limit: number | null;
  budget_jpy: number | null;
  revoked_at: string | null;
}
export interface AppliedCoupon { id: string; skus: string[] }
export type ShopQuote = ReturnType<typeof memberQuote> & {
  coupon?: AppliedCoupon;
  discountLabel?: string;
  fulfillmentSource: FulfillmentSource;
};

const clock = () => new Date().toISOString();
const skuPattern = /^[A-Z0-9][A-Z0-9_-]{0,63}$/;
const statusPattern = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const codePattern = /^[A-Z0-9][A-Z0-9_-]{3,63}$/;
const productSelect = "sku,square_item_id,name,description,unit_price_jpy AS unitPriceJpy,bags,required_status,fulfillment_source,enabled,photo IS NOT NULL AS has_photo";
const info = "現在の商品・クーポン条件を確認してください．";
const validKey = (value: unknown, label: string, pattern: RegExp) => {
  const key = requiredText(value, label, 64);
  if (!pattern.test(key)) throw new InputError(`${label}を確認してください．`);
  return key;
};
const whole = (value: unknown, min: number, max: number, label: string) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new InputError(`${label}を確認してください．`);
  return value;
};
function future(value: unknown) {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed) || parsed <= Date.now()) throw new InputError("未来の有効期限を指定してください．");
  return new Date(parsed).toISOString();
}

export async function shopProducts(env: Env, userId?: string, access?: Awaited<ReturnType<typeof memberAccess>>) {
  const rows = (await env.DB.prepare(`SELECT ${productSelect} FROM shop_products WHERE enabled=1 ORDER BY sku`).all<ShopProduct>()).results;
  if (!userId) return rows.filter(row => !row.required_status && (row.fulfillment_source === "hacksick" || (Boolean(env.ESSEN_BASE_URL) && Boolean(env.ESSEN_LOCATION_ID) && env.ESSEN_LOCATION_ID !== env.SQUARE_LOCATION_ID)));
  const current = access ?? await memberAccess(env.DB, userId);
  const statuses = current.benefit.eligible && current.member
    ? (await env.DB.prepare("SELECT status_key FROM shop_member_statuses WHERE member_id=? AND (expires_at IS NULL OR expires_at>?)")
      .bind(current.member.id, clock()).all<{ status_key: string }>()).results.map(s => s.status_key)
    : [];
  return rows.filter(row => (!row.required_status || statuses.includes(row.required_status)) &&
    (row.fulfillment_source === "hacksick" || (Boolean(env.ESSEN_BASE_URL) && Boolean(env.ESSEN_LOCATION_ID) && env.ESSEN_LOCATION_ID !== env.SQUARE_LOCATION_ID)));
}

export function visibleShopProduct(row: ShopProduct) {
  return {
    sku: row.sku, name: row.name, unitPriceJpy: row.unitPriceJpy, bags: row.bags,
    category: row.required_status ? "限定商品" : row.bags > 0 ? "珈琲" : "商品",
    description: row.description, fulfillmentSource: row.fulfillment_source,
    images: row.has_photo ? [{ src: `/api/shop/media/${row.sku}`, alt: row.name }] : [],
  };
}

async function usage(db: D1Database, couponId: string, userId: string, exclude: string) {
  return (await db.prepare(`SELECT COUNT(*) AS uses, COALESCE(SUM(discount_jpy),0) AS spent,
    COUNT(CASE WHEN auth_user_id=? THEN 1 END) AS personal FROM shop_coupon_uses WHERE coupon_id=? AND order_id<>?`)
    .bind(userId, couponId, exclude).first<{ uses: number; spent: number; personal: number }>())!;
}

export async function quoteShopOrder(env: Env, userId: string | null, items: unknown, storefront: boolean, couponSelector?: { code: unknown } | { id: string }, exclude = "") {
  const access = userId ? await memberAccess(env.DB, userId) : undefined;
  if (access?.member?.status === "blocked" || (!storefront && !access?.benefit.eligible)) throw new InputError(info);
  const extras = await shopProducts(env, userId ?? undefined, access);
  const quote = memberQuote(items, { eligible: Boolean(access?.benefit.eligible), storefront, extras });
  const sources = new Set(quote.lines.map(line => extras.find(p => p.sku === line.sku)?.fulfillment_source ?? "hacksick"));
  if (sources.size !== 1) throw new InputError("発送元が異なる商品は，カートで発送元を選び，別々にお会計ください．");
  const result: ShopQuote = { ...quote, fulfillmentSource: [...sources][0] };
  if (!couponSelector) return result;
  if (!userId) throw new InputError("クーポンをご利用の場合はログインしてください．");
  const coupon = "code" in couponSelector
    ? await env.DB.prepare("SELECT * FROM shop_coupons WHERE code=?").bind(validKey(String(couponSelector.code ?? "").trim().toUpperCase(), "クーポンコード", codePattern)).first<Coupon>()
    : await env.DB.prepare("SELECT * FROM shop_coupons WHERE id=?").bind(couponSelector.id).first<Coupon>();
  const buyer = await env.DB.prepare("SELECT email, emailVerified FROM user WHERE id=?").bind(userId).first<{ email: string; emailVerified: number }>();
  if (!coupon || coupon.revoked_at || coupon.expires_at <= clock() || !buyer?.emailVerified ||
      (coupon.recipient_email && normalizeEmail(buyer.email) !== coupon.recipient_email)) throw new InputError(info);
  const counts = await usage(env.DB, coupon.id, userId, exclude);
  if (counts.personal >= coupon.account_limit || (coupon.use_limit !== null && counts.uses >= coupon.use_limit)) throw new InputError(info);
  const skus = JSON.parse(coupon.allowed_skus_json) as string[];
  const eligibleTotal = quote.lines.reduce((sum, line) => sum + (skus.includes(line.sku) ? line.subtotalJpy : 0), 0);
  const discount = Math.min(Math.round(eligibleTotal * coupon.percent / 100), coupon.budget_jpy === null ? Infinity : coupon.budget_jpy - counts.spent);
  if (discount <= 0) throw new InputError(info);
  if (discount <= quote.discountJpy) return result;
  return { ...result, discountPercent: coupon.percent, discountJpy: discount, discountLabel: coupon.label,
    totalJpy: quote.subtotalJpy - discount + quote.shippingJpy, coupon: { id: coupon.id, skus } };
}

export async function reserveCoupon(db: D1Database, orderId: string, userId: string, coupon: AppliedCoupon, discountJpy: number) {
  const inserted = await db.prepare(`INSERT INTO shop_coupon_uses (order_id,coupon_id,auth_user_id,discount_jpy,state)
    SELECT o.id,c.id,o.auth_user_id,?,'reserved'
    FROM shop_coupons c JOIN member_orders o ON o.id=? AND o.auth_user_id=? AND o.state='paying'
    JOIN user u ON u.id=o.auth_user_id AND u.emailVerified=1
    WHERE c.id=? AND c.revoked_at IS NULL AND c.expires_at>? AND (c.recipient_email IS NULL OR u.email=c.recipient_email COLLATE NOCASE)
      AND (SELECT COUNT(*) FROM shop_coupon_uses WHERE coupon_id=c.id AND auth_user_id=o.auth_user_id)<c.account_limit
      AND (c.use_limit IS NULL OR (SELECT COUNT(*) FROM shop_coupon_uses WHERE coupon_id=c.id)<c.use_limit)
      AND (c.budget_jpy IS NULL OR ?+COALESCE((SELECT SUM(discount_jpy) FROM shop_coupon_uses WHERE coupon_id=c.id),0)<=c.budget_jpy)
    ON CONFLICT(order_id) DO NOTHING`).bind(discountJpy, orderId, userId, coupon.id, clock(), discountJpy).run();
  return inserted.meta.changes === 1;
}

export async function shopSettings(env: Env) {
  const db = env.DB;
  const [products, coupons, statuses, staff] = await db.batch([
    db.prepare(`SELECT ${productSelect} FROM shop_products ORDER BY sku`),
    db.prepare(`SELECT c.*,COUNT(u.order_id) AS held_or_used,
      COALESCE(SUM(CASE WHEN u.state='consumed' THEN u.discount_jpy ELSE 0 END),0) AS spent_jpy
      FROM shop_coupons c LEFT JOIN shop_coupon_uses u ON u.coupon_id=c.id GROUP BY c.id ORDER BY c.expires_at DESC LIMIT 200`),
    db.prepare("SELECT member_id,status_key,expires_at FROM shop_member_statuses ORDER BY member_id,status_key LIMIT 200"),
    db.prepare("SELECT email,enabled FROM shop_fulfillment_staff ORDER BY email"),
  ]);
  const rows = products.results as ShopProduct[];
  const partnerActive = Boolean(env.ESSEN_BASE_URL && env.ESSEN_LOCATION_ID && env.ESSEN_LOCATION_ID !== env.SQUARE_LOCATION_ID);
  const couponProducts = [
    ...STOREFRONT_PRODUCTS.map(({ sku, name, bags, unitPriceJpy }) => ({
      sku, name, unitPriceJpy, category: bags > 0 ? "珈琲" : "書籍", selectable: true,
    })),
    ...rows.map(row => {
      const { sku, name, category, unitPriceJpy } = visibleShopProduct(row);
      return { sku, name, category, unitPriceJpy, selectable: Boolean(row.enabled) && (row.fulfillment_source === "hacksick" || partnerActive) };
    }),
  ];
  return { products: rows, coupons: coupons.results, statuses: statuses.results, staff: staff.results, couponProducts };
}

export async function searchCouponRecipients(db: D1Database, query: string) {
  const keyword = query.trim().slice(0, 100);
  if (!keyword) return { recipients: [], more: false };
  const pattern = `%${keyword.replace(/[~%_]/g, "~$&")}%`;
  const { results } = await db.prepare(`
    WITH recipients AS (
      SELECT u.email, COALESCE(m.display_name, NULLIF(u.name,''), u.email) AS name,
        m.id AS member_id, m.hsap_id AS hsapId, 1 AS hasAccount
      FROM user u
      LEFT JOIN members m ON m.id=COALESCE(
        (SELECT id FROM members WHERE auth_user_id=u.id),
        (SELECT member_id FROM member_emails WHERE email=u.email COLLATE NOCASE),
        (SELECT id FROM members WHERE claim_email=u.email COLLATE NOCASE)
      )
      WHERE u.emailVerified=1 AND (m.status IS NULL OR m.status='active')
      UNION ALL
      SELECT m.claim_email, m.display_name, m.id, m.hsap_id, 0
      FROM members m
      WHERE m.status='active' AND m.auth_user_id IS NULL AND NOT EXISTS (
        SELECT 1 FROM user u WHERE u.email=m.claim_email COLLATE NOCASE AND u.emailVerified=1
      )
    )
    SELECT email,name,hsapId,hasAccount FROM recipients r
    WHERE r.name LIKE ? ESCAPE '~' OR r.email LIKE ? ESCAPE '~' OR r.hsapId LIKE ? ESCAPE '~' OR EXISTS (
      SELECT 1 FROM member_emails a WHERE a.member_id=r.member_id AND a.email LIKE ? ESCAPE '~'
    )
    ORDER BY hasAccount DESC,name,email LIMIT 21
  `).bind(pattern,pattern,pattern,pattern).all<{ email: string; name: string; hsapId: string | null; hasAccount: number }>();
  return { recipients: results.slice(0, 20), more: results.length > 20 };
}

export function shopAudit(db: D1Database, actor: string, action: string, subject: string) {
  return db.prepare("INSERT INTO shop_operations_log VALUES (?,?,?,?,?)").bind(crypto.randomUUID(), actor, action, subject, clock());
}

export async function saveShopStatus(db: D1Database, actor: string, body: Record<string, unknown>) {
  const member = requiredText(body.memberId, "会員ID", 100);
  const key = validKey(body.status, "販売ステータス", statusPattern);
  if (!await db.prepare("SELECT id FROM members WHERE id=?").bind(member).first()) throw new InputError("会員が見つかりません．");
  const change = body.enabled === false ? db.prepare("DELETE FROM shop_member_statuses WHERE member_id=? AND status_key=?").bind(member, key)
    : db.prepare("INSERT INTO shop_member_statuses VALUES (?,?,?) ON CONFLICT(member_id,status_key) DO UPDATE SET expires_at=excluded.expires_at")
      .bind(member, key, body.expiresAt ? future(body.expiresAt) : null);
  await db.batch([change, shopAudit(db, actor, body.enabled === false ? "status.remove" : "status.save", `${member}:${key}`)]);
}

export async function saveShopProduct(env: Env, actor: string, body: Record<string, unknown>) {
  const sku = validKey(body.sku, "SKU", skuPattern);
  if (STOREFRONT_PRODUCTS.some(product => product.sku === sku)) throw new InputError("既存の通常商品とは別のSKUを指定してください．");
  if (body.enabled === false) {
    await env.DB.batch([env.DB.prepare("UPDATE shop_products SET enabled=0 WHERE sku=?").bind(sku), shopAudit(env.DB, actor, "product.disable", sku)]);
    return;
  }
  const source = body.fulfillmentSource === "essen" ? "essen" : "hacksick";
  const squareId = validKey(body.squareItemId, "Square商品ID", /^[A-Za-z0-9_-]{5,64}$/);
  const old = await env.DB.prepare("SELECT fulfillment_source,square_item_id FROM shop_products WHERE sku=?").bind(sku).first<{fulfillment_source:string;square_item_id:string}>();
  if (old && (old.fulfillment_source !== source || old.square_item_id !== squareId)) throw new InputError("発送元・Square商品を変更する場合は別のSKUを使ってください．");
  const required = body.requiredStatus ? validKey(body.requiredStatus, "対象ステータス", statusPattern) : null;
  const photo = typeof body.photo === "string" && body.photo.length <= 700000 ? body.photo.match(/^data:(image\/jpeg|image\/png|image\/webp);base64,([A-Za-z0-9+/=]+)$/) : null;
  if (body.photo && !photo) throw new InputError("500KB以内のJPEG・PNG・WebP画像を指定してください．");
  let bytes: ArrayBuffer | null = null;
  if (photo) {
    const image = Uint8Array.from(atob(photo[2]), char => char.charCodeAt(0));
    const signature = Array.from(image.slice(0, 12));
    const webP = [82,73,70,70].every((v,i)=>signature[i]===v) && [87,69,66,80].every((v,i)=>signature[i+8]===v);
    if (image.byteLength > 500000 || !(photo[1] === "image/jpeg" ? signature[0] === 255 && signature[1] === 216 :
      photo[1] === "image/png" ? [137,80,78,71,13,10,26,10].every((v,i)=>signature[i]===v) : webP)) throw new InputError("画像形式またはファイルサイズを確認してください．");
    bytes = image.buffer;
  }
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO shop_products VALUES (?,?,?,?,?,?,?,?,1,?,?) ON CONFLICT(sku) DO UPDATE SET
      name=excluded.name,description=excluded.description,unit_price_jpy=excluded.unit_price_jpy,bags=excluded.bags,
      required_status=excluded.required_status,enabled=1,photo=COALESCE(excluded.photo,shop_products.photo),photo_type=COALESCE(excluded.photo_type,shop_products.photo_type)`)
      .bind(sku, squareId, requiredText(body.name, "商品名", 120), requiredText(body.description, "説明", 2000),
        whole(body.unitPriceJpy, 1, 1000000, "税込価格"), whole(body.bags ?? 0, 0, 100, "袋数"), required, source, bytes, photo?.[1] ?? null),
    shopAudit(env.DB, actor, "product.save", sku),
  ]);
}

export async function issueShopCoupon(db: D1Database, actor: string, body: Record<string, unknown>) {
  if (body.revokeId) {
    const id = requiredText(body.revokeId, "クーポンID", 36);
    await db.batch([db.prepare("UPDATE shop_coupons SET revoked_at=COALESCE(revoked_at,?) WHERE id=?").bind(clock(), id), shopAudit(db, actor, "coupon.revoke", id)]);
    return {};
  }
  const template = body.template;
  if (!["lt","photographer","supporter","custom"].includes(String(template))) throw new InputError("クーポンの種類を確認してください．");
  const code = body.code ? validKey(String(body.code).toUpperCase(), "クーポンコード", codePattern) : crypto.randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase();
  if (!Array.isArray(body.skus) || !body.skus.length || body.skus.length > 100) throw new InputError("対象SKUを指定してください．");
  const skus = [...new Set(body.skus.map(sku => validKey(sku, "SKU", skuPattern)))];
  for (const sku of skus) {
    if (!STOREFRONT_PRODUCTS.some(p => p.sku === sku) && !await db.prepare("SELECT sku FROM shop_products WHERE sku=?").bind(sku).first()) throw new InputError("存在する商品のSKUを指定してください．");
  }
  const personal = body.email ? normalizeEmail(body.email) : null;
  if ((template === "photographer" || template === "supporter") && !personal) throw new InputError("利用する方のメールを指定してください．");
  const percent = template === "lt" ? 10 : template === "photographer" ? 50 : template === "supporter" ? 20 : whole(body.percent, 1, 99, "割引率");
  const budget = template === "photographer" ? 3000 * whole(body.photos, 1, 1000, "撮影枚数")
    : template === "supporter" ? 400 : body.budgetJpy == null ? null : whole(body.budgetJpy, 1, 10000000, "累計上限");
  if (template === "photographer" && body.costConfirmed !== true) throw new InputError("原価と配送費を確認してください．");
  const id = crypto.randomUUID();
  if (await db.prepare("SELECT id FROM shop_coupons WHERE code=?").bind(code).first()) throw new InputError("このコードはすでに使われています．");
  await db.batch([
    db.prepare("INSERT INTO shop_coupons VALUES (?,?,?,?,?,?,?,?,?,?,NULL)").bind(id, code, requiredText(body.label, "名称", 80), percent,
      JSON.stringify(skus), personal, body.expiresAt ? future(body.expiresAt) : new Date(Date.now() + 30 * 86400000).toISOString(),
      template === "lt" || template === "supporter" ? 1 : whole(body.accountLimit ?? (template === "photographer" ? budget : 1), 1, 10000000, "1人あたりの利用回数"),
      body.useLimit == null ? null : whole(body.useLimit, 1, 100000, "利用上限"), budget),
    shopAudit(db, actor, "coupon.issue", id),
  ]);
  return { id, code };
}

export function locationFor(env: Env, source: FulfillmentSource) {
  const location = source === "essen" ? env.ESSEN_LOCATION_ID : env.SQUARE_LOCATION_ID;
  if (!location || (source === "essen" && location === env.SQUARE_LOCATION_ID)) throw new InputError("発送元の在庫を確認できません．");
  return location;
}

export const isBook = (sku: string) => sku === BOOK_PRODUCT.sku;
