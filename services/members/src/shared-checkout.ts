import type { Env } from "./types.ts";
import { InputError, requiredText } from "./eligibility.ts";
import { allocateDiscount, BOOK_PRODUCT, SHOP_PRODUCTS, STOREFRONT_PRODUCTS, CheckoutConflict, ensureBuyer, memberAccess, memberDiscountableSubtotal, memberQuote, shippingRecipient } from "./checkout.ts";
import { checkoutAvailable, SquareRequestError, type SquareGateway, type SquareOrder, type SquarePayment } from "./square.ts";
import { refreshBillingForUser } from "./billing.ts";
import { locationFor, quoteShopOrder, reserveCoupon, shopProducts, type AppliedCoupon, type FulfillmentSource, type ShopProduct } from "./shop-operations.ts";
import { ensureGuestActor } from "./guest-checkout.ts";
import { queueOrderNotifications } from "./order-notifications.ts";

export type OrderQuote = ReturnType<typeof memberQuote> & { coupon?: AppliedCoupon; fulfillmentSource?: FulfillmentSource; discountLabel?: string; memberDiscountJpy?: number; fulfillmentHint?: string; planBaseExTaxJpy?: number; memberDiscountExTaxJpy?: number; taxJpy?: number; taxPercent?: number; goodsTotalJpy?: number };
type Quote = OrderQuote;
type Recipient = ReturnType<typeof shippingRecipient>;
export interface SharedOrder {
  id: string; auth_user_id: string; member_id: string; fingerprint: string;
  quote_json: string; recipient_json: string; catalog_json: string;
  state: "ready" | "paying" | "paid" | "failed" | "canceled" | "review";
  square_order_id: string | null; square_payment_id: string | null; review_reason: string | null;
  created_at: string; expires_at: string; updated_at: string;
  inventory_synced: number;
  fulfillment_source?: FulfillmentSource;
  square_location_id?: string | null;
  order_channel?: "shop" | "members";
  purchase_kind?: "one-time" | "coffee-trial" | "coffee-cycle";
  coffee_enrollment_id?: string | null;
  coffee_cycle?: string | null;
  square_customer_id?: string | null;
}
interface CatalogObject {
  id: string; type: string; is_deleted?: boolean; present_at_all_locations?: boolean;
  present_at_location_ids?: string[]; absent_at_location_ids?: string[];
  item_data?: { is_archived?: boolean; variations?: CatalogObject[] };
  item_variation_data?: { item_id: string; sku?: string; sellable?: boolean; stockable?: boolean; price_money?: { amount: number; currency: string }; track_inventory?: boolean; location_overrides?: { location_id: string; track_inventory?: boolean; sold_out?: boolean; price_money?: { amount: number; currency: string } }[] };
}
export interface SharedProduct { sku: string; variationId: string; available: number; rawAvailable: number; squareItemId?: string }
const parentIds = ["UN24C26GOGFGUCD7UN6YTYGQ", "LQSNTW5JKHNFRVV3BLBFHECJ", "B7WPK6VNARQJTYCLQ2TRMCYJ"];
const catalogPrices = [400, 1900, 1500];
const now = () => new Date().toISOString();
const json = (data: unknown, status = 200) => Response.json(data, { status });
export async function squareRequest<T>(gateway: SquareGateway, path: string, method = "GET", body?: unknown): Promise<T> {
  if (!gateway.request) throw new Error("SQUARE_GATEWAY_UNAVAILABLE");
  return gateway.request<T>(path, method, body);
}
const present = (object: CatalogObject, location: string) => !object.is_deleted && !object.absent_at_location_ids?.includes(location) &&
  (object.present_at_all_locations === true || object.present_at_location_ids?.includes(location) === true);

/** カタログと店舗在庫を毎回読み，表示用のローカル在庫へ置き換えない． */
export async function sharedInventory(
  env: Env, gateway: SquareGateway, excludeOrderId = "", includeBook = false,
  extras: Pick<ShopProduct, "sku" | "unitPriceJpy" | "square_item_id">[] = [], location = env.SQUARE_LOCATION_ID!,
): Promise<SharedProduct[]> {
  const shopProducts = location === env.SQUARE_LOCATION_ID ? (includeBook ? STOREFRONT_PRODUCTS : SHOP_PRODUCTS) : [];
  const configuredIds = env.SQUARE_ENVIRONMENT === "sandbox" && env.SQUARE_SANDBOX_ITEM_IDS ? env.SQUARE_SANDBOX_ITEM_IDS.split(",") : parentIds;
  const entries = [
    ...shopProducts.map((product, i) => ({ product, parentId: configuredIds[i], priceOptions: [product.unitPriceJpy, catalogPrices[i]], custom: false })),
    ...extras.map(product => ({ product, parentId: product.square_item_id, priceOptions: [product.unitPriceJpy], custom: true })),
  ];
  if (!entries.length) return [];
  const ids = [...new Set(entries.map(entry => entry.parentId))];
  const catalog = await squareRequest<{ objects?: CatalogObject[] }>(gateway, "/catalog/batch-retrieve", "POST", { object_ids: ids, include_related_objects: false });
  const products = entries.flatMap(({ product, parentId, priceOptions, custom }) => {
    const parent = catalog.objects?.find(object => object.id === parentId && object.type === "ITEM");
    const matches = parent?.item_data?.variations?.filter(v => !v.is_deleted && v.type === "ITEM_VARIATION" && v.item_variation_data?.sku === product.sku) ?? [];
    if (!parent || parent.item_data?.is_archived || !present(parent, location) || matches.length !== 1) {
      if (custom) return [];
      throw new Error("CATALOG_NOT_SELLABLE");
    }
    const variation = matches[0]; const data = variation.item_variation_data!;
    const override = data.location_overrides?.find(o => o.location_id === location);
    const price = override?.price_money ?? data.price_money;
    if (!present(variation, location) || data.item_id !== parent.id || data.sellable === false || data.stockable === false || override?.sold_out ||
      (override?.track_inventory ?? data.track_inventory) !== true || price?.currency !== "JPY" || !priceOptions.includes(price.amount)) {
      if (custom) return [];
      throw new Error("CATALOG_CONFIG_MISMATCH");
    }
    return [{ sku: product.sku, variationId: variation.id, available: 0, rawAvailable: 0, ...(custom ? { squareItemId: parentId } : {}) }];
  });
  if (!products.length) return [];
  let cursor: string | undefined; const counts: { catalog_object_id: string; location_id: string; state: string; quantity: string; calculated_at?: string }[] = [];
  do {
    const data = await squareRequest<{ counts?: typeof counts; cursor?: string }>(gateway, "/inventory/counts/batch-retrieve", "POST", {
      catalog_object_ids: products.map(p => p.variationId), location_ids: [location], states: ["IN_STOCK"], ...(cursor ? { cursor } : {}),
    });
    counts.push(...(data.counts ?? [])); cursor = data.cursor;
    if (counts.length > 100) throw new Error("INVENTORY_RESPONSE_TOO_LARGE");
  } while (cursor);
  // 不明な決済と，Squareの在庫へ未反映の支払済み注文を保守的に差し引く．
  // 在庫の値だけでは他チャネルの売却と区別できないため，注文IDを持つ売却記録を照合する．
  const held = (await env.DB.prepare("SELECT * FROM member_orders WHERE (state IN ('paying','review') OR (state='paid' AND inventory_synced=0)) AND id<>? AND COALESCE(square_location_id,?)=?")
    .bind(excludeOrderId, env.SQUARE_LOCATION_ID, location).all<SharedOrder>()).results;
  const pendingPaid=held.filter(row=>row.state==="paid"&&row.square_order_id);
  const acknowledged=new Set<string>();
  if(pendingPaid.length){
    interface Adjustment { transaction_id?:string;catalog_object_id:string;from_state:string;to_state:string;from_location_id:string;to_location_id:string;quantity:string;created_at:string }
    const adjustments:Adjustment[]=[];
    try{
      let changesCursor:string|undefined;
      const after=new Date(Math.min(...pendingPaid.map(row=>Date.parse(row.created_at)))-10000).toISOString();
      do{
        const page=await squareRequest<{changes?:{type:string;adjustment?:Adjustment}[];cursor?:string}>(gateway,"/inventory/changes/batch-retrieve","POST",{
          catalog_object_ids:products.map(p=>p.variationId),location_ids:[location],types:["ADJUSTMENT"],updated_after:after,...(changesCursor?{cursor:changesCursor}:{}),
        });
        adjustments.push(...(page.changes??[]).flatMap(change=>change.type==="ADJUSTMENT"&&change.adjustment?[change.adjustment]:[]));changesCursor=page.cursor;
        if(adjustments.length>2000)throw new Error("INVENTORY_CHANGES_TOO_LARGE");
      }while(changesCursor);
      for(const row of pendingPaid){
        const quote=JSON.parse(row.quote_json) as Quote;const catalog=JSON.parse(row.catalog_json) as SharedProduct[];
        const applied=quote.lines.every(line=>{
          const variation=catalog.find(p=>p.sku===line.sku)?.variationId;
          const sales=adjustments.filter(a=>a.transaction_id===row.square_order_id&&a.catalog_object_id===variation&&a.from_state==="IN_STOCK"&&a.to_state==="SOLD"&&a.from_location_id===location&&a.to_location_id===location);
          if(!sales.length||sales.some(a=>!Number.isFinite(Date.parse(a.created_at))))return false;
          const total=sales.reduce((sum,a)=>sum+Number(a.quantity),0);const latest=Math.max(...sales.map(a=>Date.parse(a.created_at)));
          const count=counts.find(c=>c.catalog_object_id===variation&&c.location_id===location&&c.state==="IN_STOCK");
          return total===line.quantity&&Boolean(count?.calculated_at)&&Date.parse(count!.calculated_at!)>=latest;
        });
        if(applied){
          const negative=quote.lines.some(line=>{const variation=catalog.find(p=>p.sku===line.sku)?.variationId;return counts.some(c=>c.catalog_object_id===variation&&Number(c.quantity)<0);});
          if(negative){await update(env,row,"review","stock-conflict");continue;}
          const result=await env.DB.prepare("UPDATE member_orders SET inventory_synced=1 WHERE id=? AND state='paid' AND inventory_synced=0").bind(row.id).run();
          if(result.meta.changes)acknowledged.add(row.id);
        }
      }
    }catch{ /* 在庫記録を確認できない間は確保を継続する． */ }
  }
  return products.map(product => {
    const count = counts.filter(c => c.catalog_object_id === product.variationId && c.location_id === location && c.state === "IN_STOCK");
    if (count.length > 1) throw new Error("INVENTORY_AMBIGUOUS");
    const quantity = count.length ? Number(count[0].quantity) : 0;
    if (!Number.isSafeInteger(quantity)) throw new Error("INVENTORY_INVALID");
    const reserved = held.filter(row=>!acknowledged.has(row.id)).reduce((sum, row) => sum + (JSON.parse(row.quote_json) as Quote).lines.filter(l => l.sku === product.sku).reduce((n, l) => n + l.quantity, 0), 0);
    return { ...product, rawAvailable: quantity, available: Math.max(0, quantity - reserved) };
  });
}
export const orderLocation = (env: Env, row: SharedOrder) => row.square_location_id ?? env.SQUARE_LOCATION_ID!;
export const checkoutChannelEnabled = (env: Env, storefront: boolean) =>
  !storefront || env.SQUARE_ENVIRONMENT !== "production" || env.STOREFRONT_CHECKOUT_ENABLED === "true";
async function orderInventory(env: Env, gateway: SquareGateway, quote: Quote, row: SharedOrder, exclude = "") {
  const catalog = JSON.parse(row.catalog_json) as SharedProduct[];
  // SKUと拠点は受付時の値で照合し，後日の商品設定変更で既存注文を別拠点へ動かさない．
  const extras = quote.lines.flatMap(line => {
    const square_item_id = catalog.find(product => product.sku === line.sku)?.squareItemId;
    return square_item_id ? [{ ...line, square_item_id } ] : [];
  });
  return sharedInventory(env, gateway, exclude, includesBook(quote), extras, orderLocation(env, row));
}
function sufficient(quote: Quote, products: SharedProduct[]) {
  if (quote.lines.some(line => (products.find(p => p.sku === line.sku)?.available ?? 0) < line.quantity)) throw new CheckoutConflict("在庫が不足しています．数量を変更してお試しください．");
}
export function visibleSharedOrder(row: SharedOrder) {
  return { id: row.id, state: row.state, quote: JSON.parse(row.quote_json), expiresAt: row.expires_at, kind: row.purchase_kind ?? "one-time" };
}
async function update(env: Env, row: SharedOrder, state: SharedOrder["state"], reason: string | null = null) {
  const changes = [env.DB.prepare("UPDATE member_orders SET state=?,review_reason=?,updated_at=? WHERE id=?")
    .bind(state, reason, now(), row.id)];
  if (state === "paid") changes.push(env.DB.prepare("UPDATE shop_coupon_uses SET state='consumed' WHERE order_id=? AND state='reserved'").bind(row.id));
  if (state === "failed" || state === "canceled") changes.push(env.DB.prepare("DELETE FROM shop_coupon_uses WHERE order_id=? AND state='reserved'").bind(row.id));
  await env.DB.batch(changes);
  const latest=(await env.DB.prepare("SELECT * FROM member_orders WHERE id=?").bind(row.id).first<SharedOrder>())!;
  await queueOrderNotifications(env,latest);
  return latest;
}

export async function prepareSharedOrder(env: Env, user: { id: string; email: string; name?: string }, body: Record<string, unknown>, gateway: SquareGateway, storefront = false, guestEmail?: string) {
  if (!checkoutChannelEnabled(env, storefront) || !await checkoutAvailable(env)) return json({ error: "現在，購入の受付を停止しています．" }, 503);
  if (!guestEmail) await refreshBillingForUser(env,user.id,gateway);
  const access = guestEmail ? undefined : await memberAccess(env.DB, user.id);
  if (access?.member?.status === "blocked" || (!storefront && !access?.benefit.eligible)) return json({ error: "現在の購入条件を確認してください．" }, 403);
  if (body.acceptedTerms !== true) throw new InputError("送料・出荷目安・返品条件を確認してください．");
  const key = requiredText(body.requestId, "購入受付ID", 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) throw new InputError("購入受付IDを確認してください．");
  const quote = await quoteShopOrder(env, guestEmail ? null : user.id, body.items, storefront, body.couponCode ? { code: body.couponCode } : undefined);
  const recipient = shippingRecipient(body.shipping, guestEmail ?? user.email);
  const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ quote, recipient })))), b => b.toString(16).padStart(2, "0")).join("");
  const previous = await env.DB.prepare("SELECT * FROM member_orders WHERE id=?").bind(key).first<SharedOrder>();
  if (previous) {
    if (previous.auth_user_id !== user.id || previous.fingerprint !== fingerprint) throw new CheckoutConflict("購入内容が変わっています．購入状況を確認してからやり直してください．");
    return json(visibleSharedOrder(previous));
  }
  if (await env.DB.prepare("SELECT id FROM member_orders WHERE auth_user_id=? AND state IN ('paying','review')").bind(user.id).first()) throw new CheckoutConflict("確認中のお支払いがあります．再度支払わず，購入状況を確認してください．");
  const location = locationFor(env, quote.fulfillmentSource);
  const extras = (await shopProducts(env, guestEmail ? undefined : user.id, access)).filter(product => quote.lines.some(line => line.sku === product.sku));
  const inventory = await sharedInventory(env, gateway, "", includesBook(quote), extras, location);
  sufficient(quote, inventory);
  if (guestEmail) await ensureGuestActor(env.DB, user);
  const memberId = access?.member?.id ?? await ensureBuyer(env.DB, user);
  const time = now(); const expires = new Date(Date.now() + 15 * 60000).toISOString();
  const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO member_orders (id,auth_user_id,member_id,fingerprint,quote_json,recipient_json,catalog_json,state,created_at,expires_at,updated_at,fulfillment_source,square_location_id,order_channel)
    SELECT ?,?,?,?,?,?,?,'ready',?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM member_orders WHERE auth_user_id=? AND created_at>=?) < 15`)
    .bind(key, user.id, memberId, fingerprint, JSON.stringify(quote), JSON.stringify(recipient), JSON.stringify(inventory), time, expires, time, quote.fulfillmentSource, location, storefront ? "shop" : "members", user.id, new Date(Date.now() - 3600000).toISOString()).run();
  const row = await env.DB.prepare("SELECT * FROM member_orders WHERE id=?").bind(key).first<SharedOrder>();
  if (!row) throw new CheckoutConflict("購入受付が混み合っています．時間をおいてお試しください．");
  if (!inserted.meta.changes && (row.auth_user_id !== user.id || row.fingerprint !== fingerprint)) throw new CheckoutConflict("購入受付を確認してください．");
  return json(visibleSharedOrder(row));
}

const includesBook = (quote: Quote) => quote.lines.some(line => line.sku === BOOK_PRODUCT.sku);

export function sharedOrderPayload(env: Env, row: SharedOrder) {
  const quote = JSON.parse(row.quote_json) as Quote; const products = JSON.parse(row.catalog_json) as SharedProduct[];
  const memberDiscount = quote.memberDiscountJpy ?? 0;
  const memberAllocations = allocateDiscount(memberDiscount, quote.lines.map(memberDiscountableSubtotal));
  const allocations = allocateDiscount(quote.discountJpy - memberDiscount, quote.lines.map((line, i) => {
    if (!quote.coupon) return memberDiscountableSubtotal(line);
    return quote.coupon.skus.includes(line.sku) ? line.subtotalJpy - memberAllocations[i] : 0;
  }));
  const discountsByLine = quote.lines.map((_, i) => [
    { uid: `stack-member-${i}`, name: "会員特典10％", amount: memberAllocations[i] },
    { uid: `member-${i}`, name: quote.discountLabel ?? "会員特典10％", amount: allocations[i] },
  ].filter(entry => entry.amount));
  const money = (amount: number) => ({ amount, currency: "JPY" });
  return { idempotency_key: row.id, order: {
    location_id: orderLocation(env, row), reference_id: row.id,
    ...(row.square_customer_id ? { customer_id: row.square_customer_id } : {}),
    line_items: quote.lines.map((line, i) => ({ uid: `line-${i}`, catalog_object_id: products.find(p => p.sku === line.sku)!.variationId,
      quantity: String(line.quantity), base_price_money: money(line.unitPriceJpy), ...(discountsByLine[i].length ? { applied_discounts: discountsByLine[i].map(({ uid }) => ({ discount_uid: uid })) } : {}), ...(quote.taxPercent !== undefined ? { applied_taxes: [{ tax_uid: "food-tax" }] } : {}) })),
    discounts: discountsByLine.flat().map(({ uid, name, amount }) => ({
      uid, name, type: "FIXED_AMOUNT", scope: "LINE_ITEM", amount_money: money(amount),
    })),
    ...(quote.taxPercent !== undefined ? { taxes: [{ uid: "food-tax", name: "食品・軽減税率", percentage: String(quote.taxPercent), type: "INCLUSIVE", scope: "LINE_ITEM" }] } : {}),
    ...(quote.shippingJpy ? { service_charges: [{ uid: "shipping", name: "国内送料", calculation_phase: "TOTAL_PHASE", taxable: false, amount_money: money(quote.shippingJpy) }] } : {}),
    pricing_options: { auto_apply_discounts: false, auto_apply_taxes: false },
    fulfillments: [{ type: "SHIPMENT", state: "PROPOSED", shipment_details: { recipient: JSON.parse(row.recipient_json) } }],
  } };
}
function validOrder(env: Env, row: SharedOrder, order: SquareOrder) {
  const quote = JSON.parse(row.quote_json) as Quote;
  return order.id === row.square_order_id && order.location_id === orderLocation(env, row) && order.reference_id === row.id &&
    order.total_money?.currency === "JPY" && order.total_money.amount === quote.totalJpy &&
    (quote.taxJpy === undefined || (order.total_tax_money?.currency === "JPY" && order.total_tax_money.amount === quote.taxJpy)) &&
    order.fulfillments?.some(f => f.type === "SHIPMENT" && f.shipment_details?.recipient?.address?.country === "JP");
}
function validPayment(env: Env, row: SharedOrder, payment: SquarePayment) {
  return payment.order_id === row.square_order_id && payment.location_id === orderLocation(env, row) && payment.total_money?.currency === "JPY" &&
    payment.total_money.amount === (JSON.parse(row.quote_json) as Quote).totalJpy && !(payment.refunded_money?.amount);
}

export async function reconcileSharedOrder(env: Env, row: SharedOrder, gateway: SquareGateway, squareOrder?: SquareOrder) {
  if (!row.square_order_id || ["ready", "failed", "canceled"].includes(row.state)) return row;
  const order = squareOrder ?? await gateway.getOrder(row.square_order_id);
  if (!validOrder(env, row, order)) return update(env, row, "review", "order-mismatch");
  const ids = new Set([...(order.tenders ?? []).flatMap(t => t.payment_id ? [t.payment_id] : []), ...(row.square_payment_id ? [row.square_payment_id] : [])]);
  const payments = await Promise.all([...ids].map(id => gateway.getPayment(id)));
  const completed = payments.filter(p => p.status === "COMPLETED");
  if (row.review_reason === "stock-conflict") return row;
  if (completed.length === 1 && !payments.some(p => !["COMPLETED","FAILED","CANCELED"].includes(p.status)) && validPayment(env, row, completed[0])) {
    await env.DB.prepare("UPDATE member_orders SET square_payment_id=? WHERE id=?").bind(completed[0].id, row.id).run();
    return update(env, row, "paid");
  }
  if (payments.length && payments.every(p => ["FAILED", "CANCELED"].includes(p.status)) && row.state !== "paid") return update(env, row, "failed");
  if (completed.length || row.state === "paid" || order.state === "CANCELED") return update(env, row, "review", "payment-mismatch");
  // 送信結果が不明な場合は，新しい決済キーで再請求しない．
  return row.state === "paying" && Date.now() - Date.parse(row.updated_at) > 120000 ? update(env, row, "review", "payment-result-unknown") : row;
}

export interface TrustedCoffeePayment {
  kind: "coffee-trial" | "coffee-cycle";
  customerId: string;
  sourceId: string;
  customerInitiated: boolean;
  authorize: () => Promise<boolean>;
}
export async function paySharedOrder(env: Env, userId: string, orderId: string, body: Record<string, unknown>, gateway: SquareGateway, coffee?: TrustedCoffeePayment, storefront = false, guest = false) {
  if (!checkoutChannelEnabled(env, storefront) || !await checkoutAvailable(env)) return json({ error: "現在，購入の受付を停止しています．" }, 503);
  let row = await env.DB.prepare("SELECT * FROM member_orders WHERE id=? AND auth_user_id=?").bind(orderId, userId).first<SharedOrder>();
  if (!row) return json({ error: "購入情報が見つかりません．" }, 404);
  if (!coffee && row.order_channel !== (storefront ? "shop" : "members")) return json({ error: "購入を開始したサイトでお支払いください．" }, 409);
  if (coffee ? row.purchase_kind !== coffee.kind || row.square_customer_id !== coffee.customerId : row.purchase_kind && row.purchase_kind !== "one-time") throw new InputError("この購入に対応する決済画面をご利用ください．");
  if (row.state !== "ready") return json(visibleSharedOrder(await reconcileSharedOrder(env, row, gateway)));
  if (Date.parse(row.expires_at) <= Date.now()) return json(visibleSharedOrder(await update(env, row, "canceled")));
  if (!coffee && !guest) await refreshBillingForUser(env,userId,gateway);
  const quote = JSON.parse(row.quote_json) as Quote;
  const authorized = async () => {
    if (coffee) return coffee.authorize();
    const access = guest ? undefined : await memberAccess(env.DB, userId);
    if (access?.member?.status === "blocked" || (!storefront && (!access?.benefit.eligible || includesBook(quote)))) return false;
    try {
      const checked = await quoteShopOrder(env, guest ? null : userId, quote.lines, storefront, quote.coupon ? { id: quote.coupon.id } : undefined, row!.id);
      return checked.totalJpy === quote.totalJpy && checked.discountJpy === quote.discountJpy &&
        checked.memberDiscountJpy === quote.memberDiscountJpy && checked.coupon?.id === quote.coupon?.id && checked.fulfillmentSource === (row!.fulfillment_source ?? "hacksick") &&
        checked.lines.every((line, i) => line.sku === quote.lines[i].sku && line.unitPriceJpy === quote.lines[i].unitPriceJpy);
    } catch (error) { if (error instanceof InputError) return false; throw error; }
  };
  if (!await authorized()) return json({ error: "現在の購入条件を確認してください．" }, 403);
  const token = coffee?.sourceId ?? requiredText(body.sourceId, "カードの確認結果", 2048);
  if (!(coffee && !coffee.customerInitiated ? /^ccof:[A-Za-z0-9_+=:/.-]{3,2000}$/ : /^cnon:[A-Za-z0-9_+=:/.-]{5,2000}$/).test(token)) throw new InputError("カード入力欄で本人認証を完了してください．");
  const verificationToken = !coffee && env.WALLET_ENABLED === "true" && body.verificationToken
    ? requiredText(body.verificationToken, "本人認証の確認結果", 6000) : undefined;
  if (body.confirmedTotalJpy !== (JSON.parse(row.quote_json) as Quote).totalJpy) throw new InputError("合計金額をもう一度確認してください．");
  const lease = await env.DB.prepare("UPDATE member_payment_lock SET owner=?,expires_at=? WHERE id=1 AND expires_at<?")
    .bind(row.id, new Date(Date.now() + 120000).toISOString(), now()).run();
  if (!lease.meta.changes) throw new CheckoutConflict("ほかのお支払いを処理中です．少し待って同じ購入を再試行してください．");
  let paymentSent = false;
  try {
    row = (await env.DB.prepare("SELECT * FROM member_orders WHERE id=?").bind(row.id).first<SharedOrder>())!;
    if (row.state !== "ready") return json(visibleSharedOrder(await reconcileSharedOrder(env, row, gateway)));
    const current = await orderInventory(env, gateway, quote, row); sufficient(quote, current);
    const original = JSON.parse(row.catalog_json) as SharedProduct[];
    if (quote.lines.some(line => current.find(p => p.sku === line.sku)?.variationId !== original.find(p => p.sku === line.sku)?.variationId)) throw new CheckoutConflict("商品情報が更新されました．購入をやり直してください．");
    const claimed = await env.DB.prepare("UPDATE member_orders SET state='paying',updated_at=? WHERE id=? AND state='ready'").bind(now(), row.id).run();
    if (!claimed.meta.changes) throw new CheckoutConflict("同じ購入を処理中です．購入状況をご確認ください．");
    const created = await squareRequest<{ order: SquareOrder }>(gateway, "/orders", "POST", sharedOrderPayload(env, row));
    await env.DB.prepare("UPDATE member_orders SET square_order_id=?,updated_at=? WHERE id=?").bind(created.order.id, now(), row.id).run();
    row.square_order_id = created.order.id; row.state = "paying";
    if (!validOrder(env, row, created.order) || created.order.state !== "OPEN") return json(visibleSharedOrder(await update(env, row, "review", "order-mismatch")));
    // 決済直前の再確認．在庫を持たないready受付は引当としない．自身のpaying分だけ戻して判定する．
    const beforePay = await orderInventory(env, gateway, quote, row, row.id);
    sufficient(quote, beforePay);
    if (!await authorized()) return json(visibleSharedOrder(await update(env, row, "canceled")));
    if (quote.coupon && !await reserveCoupon(env.DB, row.id, userId, quote.coupon, quote.discountJpy - (quote.memberDiscountJpy ?? 0))) {
      return json(visibleSharedOrder(await update(env, row, "canceled")));
    }
    paymentSent = true;
    const recipient = JSON.parse(row.recipient_json) as Recipient;
    const result = await squareRequest<{ payment: SquarePayment }>(gateway, "/payments", "POST", {
      idempotency_key: row.id, source_id: token,
      ...(verificationToken ? { verification_token: verificationToken } : {}), order_id: row.square_order_id, location_id: orderLocation(env, row),
      amount_money: { amount: quote.totalJpy, currency: "JPY" }, autocomplete: true,
      reference_id: row.id, buyer_email_address: recipient.email_address, shipping_address: recipient.address,
      ...(coffee ? { customer_id: coffee.customerId, customer_details: { customer_initiated: coffee.customerInitiated, seller_keyed_in: false } } : {}),
      note: coffee ? "HackSick珈琲定期便" : "HackSickショップ",
    });
    await env.DB.prepare("UPDATE member_orders SET square_payment_id=?,updated_at=? WHERE id=?").bind(result.payment.id, now(), row.id).run();
    row.square_payment_id = result.payment.id;
    if (result.payment.status === "COMPLETED" && validPayment(env, row, result.payment)) {
      row = await update(env, row, "paid");
      try {
        if ((await orderInventory(env, gateway, quote, row)).some(p => p.rawAvailable < 0 && quote.lines.some(line => line.sku === p.sku))) row = await update(env, row, "review", "stock-conflict");
      } catch { /* 決済証明は保存済み．在庫API障害で再請求可能な状態に戻さない． */ }
    }
    else if (["FAILED", "CANCELED"].includes(result.payment.status)) row = await update(env, row, "failed");
    else row = await update(env, row, "review", "payment-pending");
    return json(visibleSharedOrder(row));
  } catch (error) {
    const latest = await env.DB.prepare("SELECT * FROM member_orders WHERE id=?").bind(row.id).first<SharedOrder>();
    if (latest?.state === "paying") {
      const declines = ["CARD_DECLINED","GENERIC_DECLINE","INSUFFICIENT_FUNDS","CVV_FAILURE","VERIFY_CVV_FAILURE","VERIFY_AVS_FAILURE","CARD_EXPIRED","EXPIRATION_FAILURE","INVALID_CARD_DATA","CARD_TOKEN_EXPIRED","CARD_TOKEN_USED","PAYMENT_LIMIT_EXCEEDED","CARD_DECLINED_VERIFICATION_REQUIRED"];
      if (paymentSent && error instanceof SquareRequestError && error.status === 400 && error.codes.length && error.codes.every(code => declines.includes(code))) {
        return json(visibleSharedOrder(await update(env,latest,"failed")));
      }
      // APIが明示的に拒否した場合も，結果照合が済むまで二重請求を防ぐ．
      await update(env, latest, paymentSent ? "review" : "canceled", paymentSent ? "payment-result-unknown" : "before-payment-failed");
    }
    if (error instanceof CheckoutConflict || error instanceof InputError) throw error;
    throw new CheckoutConflict(paymentSent ? "お支払い結果を確認中です．もう一度支払わず，購入状況をご確認ください．" : "決済を開始できませんでした．在庫・購入状況を確認してください．");
  } finally {
    await env.DB.prepare("UPDATE member_payment_lock SET owner=NULL,expires_at='1970-01-01T00:00:00.000Z' WHERE id=1 AND owner=?").bind(row.id).run();
  }
}
export async function sweepSharedOrders(env: Env, gateway: SquareGateway) {
  if (!(env.SQUARE_ACCESS_TOKEN || env.SQUARE_CLIENT_ID)) return;
  await env.DB.prepare("UPDATE member_orders SET state='canceled',updated_at=? WHERE state='ready' AND expires_at<?").bind(now(), now()).run();
  const rows = (await env.DB.prepare("SELECT * FROM member_orders WHERE (state IN ('paying','review') OR (state='paid' AND inventory_synced=0)) AND square_order_id IS NOT NULL ORDER BY updated_at LIMIT 20").all<SharedOrder>()).results;
  const results = await Promise.allSettled(rows.map(row => reconcileSharedOrder(env, row, gateway)));
  if (results.some(r => r.status === "rejected")) throw new Error("MEMBER_ORDER_RECONCILIATION_PENDING");
  const paid = rows.filter(row => row.state === "paid");
  for (const row of paid) await orderInventory(env, gateway, JSON.parse(row.quote_json) as Quote, row);
}
