import { createAuth, type DeliverOTP } from "./auth.ts";
import { eligibility, InputError, normalizeEmail, requiredText, validateGrant } from "./eligibility.ts";
import type { Env, Grant, Member } from "./types.ts";
import { BUSINESS_POLICY } from "./business-policy.ts";
import { decideBenefit, recordBenefit, tokyoMonth, type BenefitContext, type BenefitKind, type Redemption } from "./benefits.ts";
import { issueMemberPass, readMemberPass } from "./member-pass.ts";
import { estimateCoffeeOrder, integer, quoteOrder } from "./commerce.ts";
import { isPromotionKind, PROMOTION_POLICY, simulatePromotion } from "./promotion-policy.ts";
import { COFFEE_COST_POLICY } from "./coffee-cost-policy.ts";
import { CHECKOUT_POLICY, SHOP_PRODUCTS, STOREFRONT_PRODUCTS, CheckoutConflict, memberAccess, type shippingRecipient } from "./checkout.ts";
import { shopGuest } from "./guest-checkout.ts";
import { checkoutConfigured, checkoutAvailable, squareGateway, validSquareSignature, type SquareGateway } from "./square.ts";
import { importHsap } from "./hsap.ts";
import { beginSquareAuthorization, finishSquareAuthorization, squareAccessToken, squareConnectionStatus } from "./square-oauth.ts";
import { checkoutChannelEnabled, sharedInventory, prepareSharedOrder, paySharedOrder, visibleSharedOrder, reconcileSharedOrder, sweepSharedOrders, type SharedOrder } from "./shared-checkout.ts";
import { syncMonthlySubscriptions } from "./billing.ts";
import { deliverOrderNotifications } from "./order-notifications.ts";
import { readShipment, recordShipment, visibleShipment } from "./order-shipment.ts";
import { issueShopCoupon, locationFor, quoteShopOrder, saveShopProduct, saveShopStatus, searchCouponRecipients, shopProducts, shopSettings, visibleShopProduct } from "./shop-operations.ts";
import { essenStaff, fulfillmentOrders, saveDispatch, saveFulfillmentStaff } from "./fulfillment.ts";
import { shopProductMedia } from "./product-media.ts";
import { adminPanel } from "./admin-panel.ts";
import { productNotFound, storefrontMetadata } from "./storefront-meta.ts";
import { coffeeShop, trialPricing, prepareCoffeeEnrollment, getCoffeeEnrollment, visibleCoffeeEnrollment, payCoffeeEnrollment, updateCoffeeCard, cancelCoffeeEnrollment, reconcileCoffeeEnrollment, sweepCoffeeEnrollments, billCoffeeSubscriptions, deliverCoffeeNotices, coffeeCapability, type CoffeeEnrollment } from "./coffee-recurring.ts";
import { COFFEE_SUBSCRIPTIONS, previewCoffeeSubscription } from "./coffee-subscriptions.ts";

const json = (value: unknown, status = 200) => Response.json(value, { status });
const id = () => crypto.randomUUID();

async function lastShippingAddress(db: D1Database, userId: string) {
  const order = await db.prepare("SELECT recipient_json FROM member_orders WHERE auth_user_id=? AND state='paid' ORDER BY created_at DESC LIMIT 1").bind(userId).first<{ recipient_json: string }>();
  if (!order) return null;
  const recipient = JSON.parse(order.recipient_json) as ReturnType<typeof shippingRecipient>;
  const address = recipient.address;
  if (address?.country !== "JP") return null;
  return { name: recipient.display_name, phone: recipient.phone_number, postalCode: address.postal_code,
    prefecture: address.administrative_district_level_1, city: address.locality, addressLine1: address.address_line_1,
    addressLine2: address.address_line_2 ?? "" };
}

function audit(db: D1Database, actor: string, member: string, action: string, detail: unknown, now: string) {
  return db.prepare("INSERT INTO audit_log (id, actor_user_id, member_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id(), actor, member, action, JSON.stringify(detail), now);
}

async function readBody(request: Request, maximum = 16384): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new InputError("JSON形式で送信してください．");
  const reader = request.body?.getReader();
  if (!reader) throw new InputError("入力内容がありません．");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximum) { await reader.cancel(); throw new InputError("入力内容が大きすぎます．"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new InputError("入力内容を読み取れません．"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new InputError("入力内容を確認してください．");
  return body as Record<string, unknown>;
}

export function createWorker(deliverOTP?: DeliverOTP, gatewayFactory: (env: Env) => SquareGateway = squareGateway) {
  const authInstances = new WeakMap<D1Database, Map<string, ReturnType<typeof createAuth>>>();
  function authFor(env: Env, origin: string, partner: boolean) {
    let origins = authInstances.get(env.DB);
    if (!origins) {
      origins = new Map();
      authInstances.set(env.DB, origins);
    }
    let auth = origins.get(origin);
    if (!auth) {
      auth = createAuth(env, deliverOTP, origin, partner);
      origins.set(origin, auth);
    }
    return auth;
  }

  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      let response: Response;
      try {
        response = await route(request, env);
      } catch (error) {
        response = error instanceof InputError ? json({ error: error.message }, 400) : error instanceof CheckoutConflict ? json({ error: error.message }, 409) : json({ error: "処理を完了できませんでした．時間をおいて，同じ購入受付から再試行してください．" }, 503);
      }
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "no-store");
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("Referrer-Policy", "same-origin");
      headers.set("X-Frame-Options", "DENY");
      if (env.WALLET_ENABLED === "true") headers.set("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
      const squareCdn = env.SQUARE_ENVIRONMENT === "production" ? "https://web.squarecdn.com" : "https://sandbox.web.squarecdn.com";
      const squarePci = env.SQUARE_ENVIRONMENT === "production" ? "https://pci-connect.squareup.com" : "https://pci-connect.squareupsandbox.com";
      headers.set("Content-Security-Policy", `default-src 'self'; script-src 'self' ${squareCdn}; style-src 'self' 'unsafe-inline' ${squareCdn}; img-src 'self' data: https://*.squarecdn.com; font-src 'self' https://square-fonts-production-f.squarecdn.com https://d1g145x70srn7h.cloudfront.net; connect-src 'self' ${squareCdn} ${squarePci} https://o160250.ingest.sentry.io; frame-src 'self' ${squareCdn}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
      if (new URL(request.url).protocol === "https:") headers.set("Strict-Transport-Security", "max-age=31536000");
      return new Response(response.body, { status: response.status, headers });
    },
    async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
      ctx.waitUntil((async()=>{
        const gateway=gatewayFactory(env);
        const checks=await Promise.allSettled([sweepSharedOrders(env,gateway),syncMonthlySubscriptions(env,gateway)]);
        if(checks.every(check=>check.status==="fulfilled")){await sweepCoffeeEnrollments(env,gateway);await billCoffeeSubscriptions(env,gateway);}
      })());
      ctx.waitUntil(deliverOrderNotifications(env));
      ctx.waitUntil(deliverCoffeeNotices(env));
      if (env.SQUARE_CLIENT_ID) ctx.waitUntil((async () => {
        if ((await squareConnectionStatus(env)).expiresAt) await squareAccessToken(env);
        await env.DB.prepare("DELETE FROM square_oauth_states WHERE expires_at < ?").bind(new Date().toISOString()).run();
      })());
    },
  };

  async function route(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const membersOrigin = new URL(env.AUTH_BASE_URL).origin;
    const shopOrigin = env.SHOP_BASE_URL ? new URL(env.SHOP_BASE_URL).origin : null;
    const origin = url.origin;
    const storefront = origin !== membersOrigin && origin === shopOrigin;
    const partner = Boolean(env.ESSEN_BASE_URL && origin === new URL(env.ESSEN_BASE_URL).origin && origin !== membersOrigin && !storefront);
    if (partner) {
      if (["/", "/shipping.js", "/style.css"].includes(url.pathname) && request.method === "GET") {
        return env.ASSETS.fetch(url.pathname === "/" ? new Request(new URL("/shipping.html", url), request) : request);
      }
      if (!url.pathname.startsWith("/api/auth/") && !url.pathname.startsWith("/api/fulfillment/")) return json({ error: "ページが見つかりません．" },404);
    }
    if (origin !== membersOrigin && !storefront && !partner) return json({ error: "アクセス先のURLを確認してください．" }, 421);
    if (url.pathname === "/api/config" && request.method === "GET") return json({
      google: !storefront && Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
      email: Boolean(env.RESEND_API_KEY || deliverOTP),
      coffee: checkoutChannelEnabled(env, storefront) && env.COFFEE_RECURRING_ENABLED === "true",
      storefront,
      ...(shopOrigin ? { shopUrl: shopOrigin } : {}),
    });
    if (url.pathname === "/.well-known/apple-developer-merchantid-domain-association" && request.method === "GET") {
      const file = await env.ASSETS.fetch(request);
      return file.ok ? new Response(file.body, { headers: { "Content-Type": "application/octet-stream", "Content-Disposition": "attachment" } }) : file;
    }
    if (!url.pathname.startsWith("/api/")) {
      if (url.pathname === "/shipping.html" || url.pathname === "/shipping.js") return json({ error: "ページが見つかりません．" }, 404);
      if (["/operations", "/shop"].includes(url.pathname)) {
        return storefront ? json({ error: "ページが見つかりません．" }, 404) : env.ASSETS.fetch(new Request(new URL("/", url), request));
      }
      const productPath = url.pathname.match(/^\/products\/([A-Z0-9_-]{1,64})$/);
      if (productPath) {
        const sku = productPath[1];
        const publicProducts = storefront ? STOREFRONT_PRODUCTS : SHOP_PRODUCTS;
        if (!publicProducts.some(product => product.sku === sku)) {
          const session = await authFor(env, origin, partner).api.getSession({ headers: request.headers });
          const userId = session?.user.emailVerified ? session.user.id : undefined;
          if (!(await shopProducts(env, userId)).some(product => product.sku === sku)) return productNotFound(storefront);
        }
      }
      if (productPath || ["/cart", "/checkout", "/orders", "/coffee", "/login"].includes(url.pathname)) {
        const page = await env.ASSETS.fetch(new Request(new URL("/", url), request));
        return storefront ? storefrontMetadata(page, url) : page;
      }
      if (storefront && url.pathname === "/") return storefrontMetadata(await env.ASSETS.fetch(request), url);
      return env.ASSETS.fetch(request);
    }
    if (storefront && !/^\/api\/(?:me$|storefront$|auth\/|shop(?:\/|$)|coffee(?:\/|$))/.test(url.pathname)) {
      return json({ error: "ページが見つかりません．" }, 404);
    }
    if (url.pathname === "/api/square/oauth/callback" && request.method === "GET") {
      await finishSquareAuthorization(env, url);
      return Response.redirect(`${origin}/operations?view=connections&square=connected`, 303);
    }
    if (url.pathname === "/api/square/webhook" && request.method === "POST") {
      if (!env.SQUARE_WEBHOOK_SIGNATURE_KEY || env.SQUARE_WEBHOOK_URL !== `${origin}/api/square/webhook`) return json({ error: "未設定です．" }, 503);
      const reader = request.body?.getReader();
      if (!reader) return json({ error: "本文がありません．" }, 400);
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length; if (size > 262144) { await reader.cancel(); return json({ error: "本文が大きすぎます．" }, 413); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const raw = new TextDecoder().decode(bytes);
      if (!await validSquareSignature(raw, request.headers.get("x-square-hmacsha256-signature") ?? "", env.SQUARE_WEBHOOK_SIGNATURE_KEY!, env.SQUARE_WEBHOOK_URL!)) return json({ error: "署名を確認できません．" }, 403);
      let event: { event_id?: string; type?: string; data?: { object?: { payment?: { order_id?: string }; refund?: {payment_id?:string}; order_updated?: { order_id?: string }; order_created?: { order_id?: string } } } };
      try { event = JSON.parse(raw); } catch { return json({ error: "通知を確認できません．" }, 400); }
      if (typeof event.event_id !== "string" || !event.event_id || event.event_id.length > 255) return json({ error: "通知IDを確認できません．" }, 400);
      const done = await env.DB.prepare("SELECT event_id FROM checkout_webhook_events WHERE event_id = ?").bind(event.event_id).first();
      if (done) return json({ received: true });
      const object = event.data?.object;
      let orderId = ["payment.created", "payment.updated"].includes(event.type ?? "") ? object?.payment?.order_id : event.type === "order.updated" ? object?.order_updated?.order_id : event.type === "order.created" ? object?.order_created?.order_id : null;
      if (["refund.created","refund.updated"].includes(event.type ?? "") && typeof object?.refund?.payment_id === "string") orderId=(await gatewayFactory(env).getPayment(object.refund.payment_id)).order_id;
      if (typeof orderId === "string") {
        const shared = await env.DB.prepare("SELECT * FROM member_orders WHERE square_order_id=?").bind(orderId).first<SharedOrder>();
        if (shared) await reconcileSharedOrder(env, shared, gatewayFactory(env));
      }
      if (event.type?.startsWith("invoice.") || event.type?.startsWith("subscription.") || event.type === "refund.updated") await syncMonthlySubscriptions(env,gatewayFactory(env),true);
      await env.DB.prepare("INSERT OR IGNORE INTO checkout_webhook_events VALUES (?, ?)").bind(event.event_id, new Date().toISOString()).run();
      return json({ received: true });
    }
    const auth = authFor(env, origin, partner);
    if (url.pathname.startsWith("/api/auth/")) return auth.handler(request);
    if (request.method !== "GET" && request.headers.get("Origin") !== origin) return json({ error: "送信元を確認できません．" }, 403);
    const session = await auth.api.getSession({ headers: request.headers });
    const account = session?.user.emailVerified ? session.user : null;
    if (storefront && url.pathname === "/api/storefront" && request.method === "GET") return json({
      products: [...STOREFRONT_PRODUCTS.map(product => ({ ...product, ...shopProductMedia(product.bags) })),
        ...(await shopProducts(env, account?.id)).map(visibleShopProduct)],
      plans: COFFEE_SUBSCRIPTIONS.plans.map(plan => ({ ...plan, quote: previewCoffeeSubscription(plan.id, false) })),
      trial: trialPricing(),
    });
    const shopMedia = url.pathname.match(/^\/api\/shop\/media\/([A-Z0-9_-]{1,64})$/);
    if (shopMedia && request.method === "GET") {
      const product = (await shopProducts(env, account?.id)).find(row => row.sku === shopMedia[1]);
      if (!product) return json({ error: "写真が見つかりません．" },404);
      const image = await env.DB.prepare("SELECT photo,photo_type FROM shop_products WHERE sku=? AND enabled=1 AND required_status IS ?")
        .bind(product.sku, product.required_status).first<{photo: number[] | ArrayBuffer | null; photo_type: string}>();
      if (!image?.photo) return json({ error: "写真が見つかりません．" },404);
      return new Response(image.photo instanceof ArrayBuffer ? image.photo : Uint8Array.from(image.photo),
        { headers: { "Content-Type": image.photo_type, "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/api/shop/shipping-address" && !partner && request.method === "GET") {
      return account ? json({ shippingAddress: await lastShippingAddress(env.DB, account.id) }) : json({ error: "ログインしてください．" }, 401);
    }
    const guestRoute = storefront && (
      (request.method === "GET" && ["/api/shop", "/api/shop/checkouts"].includes(url.pathname)) ||
      (request.method === "POST" && ["/api/shop/quote", "/api/shop/checkouts"].includes(url.pathname)) ||
      (/^\/api\/shop\/checkouts\/[0-9a-f-]{36}(?:\/(?:pay|cancel))?$/i.test(url.pathname) && ["GET", "POST"].includes(request.method))
    );
    const guest = !account && guestRoute ? await shopGuest(request, env, url.pathname === "/api/shop") : null;
    const user = account ?? guest;
    if (!user) return json({ error: guestRoute ? "ショップを開き直して購入状況をご確認ください．" : "ログインしてください．" }, 401);
    const db = env.DB;
    const now = new Date().toISOString();
    if (partner) {
      if (!await essenStaff(db, user.email)) return json({ error: "発送担当として登録されていません．" }, 403);
      if (url.pathname === "/api/fulfillment/orders" && request.method === "GET") return json({ orders: await fulfillmentOrders(db, true) });
      const match = url.pathname.match(/^\/api\/fulfillment\/orders\/([0-9a-f-]{36})\/(dispatch|shipment)$/i);
      if (!match || request.method !== "POST") return json({ error: "ページが見つかりません．" }, 404);
      const order = await db.prepare("SELECT * FROM member_orders WHERE id=? AND fulfillment_source='essen' AND state='paid'").bind(match[1]).first<SharedOrder>();
      if (!order) return json({ error: "注文が見つかりません．" }, 404);
      const body = await readBody(request);
      return json(match[2] === "dispatch" ? await saveDispatch(db, order.id, user.id, body, "essen")
        : await recordShipment(env, order, user.id, body, gatewayFactory(env), user.email));
    }
    const operator = account ? await db.prepare("SELECT role FROM operators WHERE auth_user_id = ?").bind(user.id).first<{ role: "viewer" | "manager" }>() : null;

    if (url.pathname === "/api/me" && request.method === "GET") {
      // 初回のみ，運営が確認したメールの所有者へ紐付ける．既存紐付けは自動変更しない．
      const pending = await db.prepare("SELECT m.id FROM members m WHERE (m.claim_email = ? COLLATE NOCASE OR EXISTS (SELECT 1 FROM member_emails e WHERE e.member_id = m.id AND e.email = ? COLLATE NOCASE)) AND m.auth_user_id IS NULL AND m.status = 'active'").bind(user.email, user.email).first<{ id: string }>();
      if (pending) await db.batch([
        db.prepare("UPDATE members SET auth_user_id = ?, updated_at = ? WHERE id = ? AND auth_user_id IS NULL AND NOT EXISTS (SELECT 1 FROM members WHERE auth_user_id = ?)").bind(user.id, now, pending.id, user.id),
        db.prepare("INSERT INTO audit_log (id, actor_user_id, member_id, action, detail, created_at) SELECT ?, ?, ?, 'member.claim', '{}', ? WHERE changes() = 1").bind(id(), user.id, pending.id, now),
      ]);
      const member = await db.prepare("SELECT id, display_name, hsap_id, status FROM members WHERE auth_user_id = ?").bind(user.id).first<Member>();
      const grants = member ? (await db.prepare("SELECT id, kind, valid_from, valid_until, revoked_at, evidence_id FROM membership_grants WHERE member_id = ?").bind(member.id).all<Grant>()).results : [];
      // 会員向けレスポンスに決済ID・内部確認内容・請求先メールを含めない．
      return json({ user: { id: user.id, email: user.email }, operator: operator?.role ?? null,
        member, grants: grants.map(grant => {
          const { evidence_id: _, ...visible } = grant;
          return { ...visible, active: eligibility(member?.status ?? "unlinked", [grant]).eligible };
        }),
        benefit: eligibility(member?.status ?? "unlinked", grants), checkoutAvailable: await checkoutAvailable(env) });
    }

    if (url.pathname === "/api/member-pass" && request.method === "POST") {
      const { member, benefit } = await memberAccess(db, user.id);
      if (!member || !benefit.eligible) return json({ error: "会員QRを表示するには，有効な会員資格が必要です．" }, 403);
      return json(await issueMemberPass(env, member.id, user.id));
    }

    if (url.pathname === "/api/shop" && request.method === "GET") {
      const access = account ? await memberAccess(db, account.id) : undefined;
      const extras = await shopProducts(env, account?.id, access);
      const connected = Boolean(env.SQUARE_ACCESS_TOKEN || (await squareConnectionStatus(env)).connected);
      let inventory: Awaited<ReturnType<typeof sharedInventory>> | null = null;
      if (connected) {
        const gateway = gatewayFactory(env);
        try { inventory = await sharedInventory(env, gateway, "", storefront, extras.filter(p => p.fulfillment_source === "hacksick")); }
        catch { /* 不明な在庫では決済を有効にしない． */ }
        if (inventory !== null && extras.some(p => p.fulfillment_source === "essen")) {
          try { inventory.push(...await sharedInventory(env, gateway, "", false, extras.filter(p => p.fulfillment_source === "essen"), locationFor(env,"essen"))); }
          catch { /* ESSENの在庫不明時は該当商品だけを販売停止する． */ }
        }
      }
      const products = (storefront ? STOREFRONT_PRODUCTS : SHOP_PRODUCTS).map(p => ({ ...p, ...shopProductMedia(p.bags), fulfillmentSource: "hacksick" }));
      const canPurchase = access?.member?.status !== "blocked" && (storefront || Boolean(access?.benefit.eligible));
      const enabled = checkoutChannelEnabled(env, storefront) && inventory !== null && await checkoutAvailable(env);
      const response = json({ products: [...products, ...extras.map(visibleShopProduct)].map(p => ({ ...p, available: inventory?.find(i => i.sku === p.sku)?.available ?? 0 })),
        policy: CHECKOUT_POLICY, stock: { shared: true, available: inventory !== null }, eligible: Boolean(access?.benefit.eligible), canPurchase, storefront, enabled,
        wallets: env.WALLET_ENABLED === "true", paymentFormPreview: operator?.role === "manager" && inventory !== null, applicationId: env.SQUARE_CLIENT_ID,
        locationId: env.SQUARE_LOCATION_ID, essenLocationId: env.ESSEN_LOCATION_ID, buyerEmail: account?.email ?? null, environment: env.SQUARE_ENVIRONMENT === "production" ? "production" : "sandbox",
        ...(account ? { shippingAddress: await lastShippingAddress(db, account.id) } : {}) });
      if (guest?.cookie) response.headers.append("Set-Cookie", guest.cookie);
      return response;
    }
    if (url.pathname === "/api/shop/quote" && request.method === "POST") {
      const access = account ? await memberAccess(db, account.id) : undefined;
      if (access?.member?.status === "blocked" || (!storefront && !access?.benefit.eligible)) return json({ error: "現在の購入条件を確認してください．" }, 403);
      const body = await readBody(request);
      return json(await quoteShopOrder(env, account?.id ?? null, body.items, storefront, body.couponCode ? { code: body.couponCode } : undefined));
    }
    if (url.pathname === "/api/shop/checkouts" && request.method === "POST") {
      const body = await readBody(request);
      return prepareSharedOrder(env, user, body, gatewayFactory(env), storefront, guest ? normalizeEmail(body.contactEmail) : undefined);
    }
    const checkoutPath = url.pathname.match(/^\/api\/shop\/checkouts\/([0-9a-f-]{36})(\/(?:pay|cancel))?$/i);
    if (checkoutPath && (request.method === "GET" || request.method === "POST")) {
      if (request.method === "POST" && checkoutPath[2] === "/pay") return paySharedOrder(env, user.id, checkoutPath[1], await readBody(request), gatewayFactory(env), undefined, storefront, Boolean(guest));
      const row = await db.prepare("SELECT * FROM member_orders WHERE id = ? AND auth_user_id = ?").bind(checkoutPath[1], user.id).first<SharedOrder>();
      if (!row) return json({ error: "購入情報が見つかりません．" }, 404);
      if (request.method === "POST" && checkoutPath[2] === "/cancel") {
        if (row.state !== "ready") throw new CheckoutConflict("この購入は処理中です．購入状況を確認してください．");
        await db.prepare("UPDATE member_orders SET state='canceled',updated_at=? WHERE id=? AND state='ready'").bind(now, row.id).run();
        return json({ canceled: true });
      }
      if (request.method !== "GET" || checkoutPath[2]) return json({ error: "ページが見つかりません．" }, 404);
      const order = await reconcileSharedOrder(env, row, gatewayFactory(env));
      const shipment = await readShipment(db, order.id);
      const dispatch = await db.prepare("SELECT planned_date,hold_reason IS NOT NULL AS held FROM shop_dispatch WHERE order_id=?").bind(order.id).first<{ planned_date:string|null;held:number }>();
      return json({ ...visibleSharedOrder(order), shipment: shipment ? visibleShipment(shipment) : null,
        dispatch: dispatch ? {plannedDate:dispatch.planned_date,held:Boolean(dispatch.held)} : null });
    }
    if (url.pathname === "/api/shop/checkouts" && request.method === "GET") {
      const rows = (await db.prepare("SELECT * FROM member_orders WHERE auth_user_id = ? ORDER BY created_at DESC LIMIT 20").bind(user.id).all<SharedOrder>()).results;
      return json({ checkouts: rows.map(visibleSharedOrder) });
    }

    if (url.pathname === "/api/coffee" && request.method === "GET") {
      const shop = await coffeeShop(env,user,gatewayFactory(env));
      return json({ ...shop, enabled: shop.enabled && checkoutChannelEnabled(env, storefront) });
    }
    if (storefront && url.pathname.startsWith("/api/coffee/") && request.method === "POST" && !url.pathname.endsWith("/cancel") &&
        !checkoutChannelEnabled(env, true)) return json({ error: "現在，購入の受付を停止しています．" },503);
    if(url.pathname==="/api/coffee/enrollments"&&request.method==="POST")return json(await prepareCoffeeEnrollment(env,user,await readBody(request),gatewayFactory(env),storefront));
    if(url.pathname==="/api/coffee/enrollments"&&request.method==="GET"){
      const rows=(await db.prepare("SELECT * FROM coffee_enrollments WHERE auth_user_id=? ORDER BY created_at DESC LIMIT 20").bind(user.id).all<CoffeeEnrollment>()).results;
      return json({enrollments:await Promise.all(rows.map(row=>visibleCoffeeEnrollment(env,row,gatewayFactory(env))))});
    }
    const coffeePath=url.pathname.match(/^\/api\/coffee\/enrollments\/([0-9a-f-]{36})(\/(?:pay|card|cancel))?$/i);
    if(coffeePath){
      const gateway=gatewayFactory(env);
      if(request.method==="POST"&&coffeePath[2]==="/pay")return payCoffeeEnrollment(env,user,coffeePath[1],await readBody(request),gateway);
      if(request.method==="POST"&&coffeePath[2]==="/card")return updateCoffeeCard(env,user,coffeePath[1],await readBody(request),gateway);
      if(request.method==="POST"&&coffeePath[2]==="/cancel")return cancelCoffeeEnrollment(env,user.id,coffeePath[1],gateway);
      if(request.method==="GET"&&!coffeePath[2]){
        const enrollment=await getCoffeeEnrollment(env,user.id,coffeePath[1]);if(!enrollment)return json({error:"定期便が見つかりません．"},404);
        return json(await visibleCoffeeEnrollment(env,await reconcileCoffeeEnrollment(env,enrollment,gateway),gateway));
      }
      return json({error:"ページが見つかりません．"},404);
    }

    if (!url.pathname.startsWith("/api/admin/")) return json({ error: "ページが見つかりません．" }, 404);
    if (!operator) return json({ error: "運営権限が必要です．" }, 403);
    if (request.method !== "GET" && operator.role !== "manager") return json({ error: "変更権限が必要です．" }, 403);
    if (url.pathname === "/api/admin/panel" && request.method === "GET") {
      return new Response(adminPanel, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (url.pathname === "/api/admin/lt/check-in" && request.method === "POST") {
      const body = await readBody(request);
      const eventId = requiredText(body.eventId, "LT会のイベントID", 100);
      const pass = await readMemberPass(env, body.token);
      const { member, grants, benefit } = await memberAccess(db, pass.userId);
      if (!member || member.id !== pass.memberId) return json({ error: "会員の紐付けが変更されています．会員QRを更新してください．" }, 409);
      const kind = "LT_WAIVER";
      const context = { eventId, eventAt: now };
      const redemptions = (await db.prepare("SELECT kind, benefit_key, event_id FROM benefit_redemptions WHERE member_id = ? AND kind = 'LT_WAIVER' AND benefit_key = ?")
        .bind(member.id, tokyoMonth(new Date(now))).all<Redemption>()).results;
      const decision = decideBenefit({ kind, memberStatus: member.status, grants, redemptions, context }, new Date(now));
      const preview = { displayName: member.display_name, qualifications: benefit.reasons,
        month: tokyoMonth(new Date(now)), eligible: benefit.eligible, allowed: decision.allowed,
        reason: decision.allowed ? null : decision.reason };
      if (body.record !== true) return json(preview);
      if (body.month !== preview.month) return json({ error: "受付月を確認するため，会員資格を再度確認してください．" }, 409);
      if (!decision.allowed) return json({ error: decision.reason }, 409);
      const result = await recordBenefit(db, { memberId: member.id, actorId: user.id, kind, context,
        reason: "会員QRによるLT会の受付", decision, now, expectedAuthUserId: pass.userId });
      if (!result) return json({ error: "特典は提供済みか，会員資格が変更されています．" }, 409);
      return json({ ...preview, ...result, allowed: false, recorded: true }, 201);
    }

    if (url.pathname === "/api/admin/policy" && request.method === "GET") return json({ ...BUSINESS_POLICY, coffeeCost: COFFEE_COST_POLICY, promotions: PROMOTION_POLICY });
    if (url.pathname === "/api/admin/square" && request.method === "GET") return json(await squareConnectionStatus(env));
    if(url.pathname==="/api/admin/coffee"&&request.method==="GET"){
      const rows=(await db.prepare("SELECT id,auth_user_id,member_id,plan_id,state,next_billing_date,created_at FROM coffee_enrollments ORDER BY created_at DESC LIMIT 100").all()).results;
      return json({...await coffeeCapability(env),enrollments:rows});
    }
    if(url.pathname==="/api/admin/coffee/reconcile"&&request.method==="POST"){await sweepSharedOrders(env,gatewayFactory(env));await sweepCoffeeEnrollments(env,gatewayFactory(env));return json({reconciled:true});}
    if (url.pathname === "/api/admin/square/authorize" && request.method === "POST") return json(await beginSquareAuthorization(env, user.id));
    if (url.pathname === "/api/admin/imports/hsap" && request.method === "POST") return json(await importHsap(db, user.id, await readBody(request)));
    if (url.pathname === "/api/admin/billing/sync" && request.method === "POST") return json({ synced: await syncMonthlySubscriptions(env,gatewayFactory(env),true) });
    if (url.pathname === "/api/admin/shop/stock" && request.method === "GET") {
      if (!(env.SQUARE_ACCESS_TOKEN || (await squareConnectionStatus(env)).connected)) return json({ shared: true, connected: false, products: [] });
      return json({ shared: true, connected: true, products: await sharedInventory(env, gatewayFactory(env), "", Boolean(env.SHOP_BASE_URL)) });
    }
    if (url.pathname === "/api/admin/shop/stock" && request.method === "POST") {
      return json({ error: "在庫はSquareの商品ライブラリで共通管理します．" }, 410);
    }
    if (url.pathname === "/api/admin/shop/reconcile" && request.method === "POST") {
      if (!checkoutConfigured(env)) return json({ error: "未設定です．" }, 503);
      await sweepSharedOrders(env, gatewayFactory(env)); return json({ reconciled: true });
    }
    if (url.pathname === "/api/admin/shop/checkouts" && request.method === "GET") return json({ checkouts: await fulfillmentOrders(db, false) });
    if (request.method === "GET" && ["/api/admin/shop/settings", "/api/admin/shop/coupon-recipients"].includes(url.pathname)) {
      if (operator.role !== "manager") return json({ error: "変更権限が必要です．" },403);
      return json(url.pathname.endsWith("/coupon-recipients")
        ? await searchCouponRecipients(db, url.searchParams.get("q") ?? "")
        : await shopSettings(env));
    }
    if (url.pathname === "/api/admin/shop/status" && request.method === "POST") {
      await saveShopStatus(db, user.id, await readBody(request)); return json({ saved: true });
    }
    if (url.pathname === "/api/admin/shop/product" && request.method === "POST") {
      await saveShopProduct(env, user.id, await readBody(request, 720000)); return json({ saved: true });
    }
    if (url.pathname === "/api/admin/shop/coupon" && request.method === "POST") {
      return json(await issueShopCoupon(db, user.id, await readBody(request)));
    }
    if (url.pathname === "/api/admin/shop/fulfillment-staff" && request.method === "POST") {
      await saveFulfillmentStaff(db, user.id, await readBody(request)); return json({ saved: true });
    }
    const dispatchPath = url.pathname.match(/^\/api\/admin\/shop\/checkouts\/([0-9a-f-]{36})\/dispatch$/i);
    if (dispatchPath && request.method === "POST") return json(await saveDispatch(db, dispatchPath[1], user.id, await readBody(request)));
    const shipmentPath = url.pathname.match(/^\/api\/admin\/shop\/checkouts\/([0-9a-f-]{36})\/shipment$/i);
    if (shipmentPath && request.method === "POST") {
      if (env.SQUARE_ENVIRONMENT === "production" && !env.RESEND_API_KEY) return json({ error: "発送メールの送信設定を確認してください．" }, 503);
      const order = await db.prepare("SELECT * FROM member_orders WHERE id=?").bind(shipmentPath[1]).first<SharedOrder>();
      if (!order) return json({ error: "注文が見つかりません．" }, 404);
      return json(await recordShipment(env, order, user.id, await readBody(request), gatewayFactory(env)));
    }
    if (url.pathname === "/api/admin/simulations/coupon" && request.method === "POST") {
      const body = await readBody(request);
      if (!isPromotionKind(body.kind)) throw new InputError("クーポンの種類を確認してください．");
      const cost = (key: string) => body[key] === undefined || body[key] === null ? null : integer(body[key] as number, key);
      let eligible = false;
      if (body.memberId) {
        const memberId=requiredText(body.memberId,"会員ID");
        const member = await db.prepare("SELECT status FROM members WHERE id=?").bind(memberId).first<{status:string}>();
        if (!member) return json({error:"会員が見つかりません．"},404);
        const grants = (await db.prepare("SELECT * FROM membership_grants WHERE member_id=?").bind(memberId).all<Grant>()).results;
        eligible = eligibility(member.status,grants).eligible;
      }
      return json(simulatePromotion({items:body.items,kind:body.kind,memberEligible:eligible,photoCount:body.photoCount as number | undefined,
        parcels:cost("parcels"),packagingJpy:cost("packagingJpy"),laborJpy:cost("laborJpy"),otherCostsJpy:cost("otherCostsJpy"),
        feeBasisPoints:body.feeBasisPoints===undefined?360:cost("feeBasisPoints")}));
    }
    if (url.pathname === "/api/admin/simulations/order" && request.method === "POST") {
      const body = await readBody(request);
      const catalog: Record<string, { unitPriceJpy: number; bags: number; isTrialSet?: boolean }> = {
        "HS-COFFEE-MOCHA-10G": { unitPriceJpy: 432, bags: 1 },
        "HS-COFFEE-MOCHA-5PACK": { unitPriceJpy: 2052, bags: 5 },
        "DRAFT-COFFEE-TRIAL-3": { unitPriceJpy: 980, bags: 3, isTrialSet: true },
      };
      if (!Array.isArray(body.items) || !body.items.length || body.items.length > 50) throw new InputError("商品を確認してください．");
      const lines = body.items.map(item => {
        if (!item || typeof item !== "object") throw new InputError("商品を確認してください．");
        const { sku, quantity } = item as { sku: string; quantity: number };
        const product = Object.hasOwn(catalog, sku) ? catalog[sku] : null;
        if (!product) throw new InputError("商品を確認してください．");
        integer(quantity, "数量", 1);
        return { sku, quantity, ...product };
      });
      let eligible = false;
      if (body.memberId) {
        const memberId = requiredText(body.memberId, "会員ID");
        const member = await db.prepare("SELECT status FROM members WHERE id = ?").bind(memberId).first<{ status: string }>();
        if (!member) return json({ error: "会員が見つかりません．" }, 404);
        const grants = (await db.prepare("SELECT * FROM membership_grants WHERE member_id = ?").bind(memberId).all<Grant>()).results;
        eligible = eligibility(member.status, grants).eligible;
      }
      const couponPercent = body.couponPercent === undefined ? 0 : integer(body.couponPercent as number, "試算クーポンの割引率");
      const quote = quoteOrder({ lines, memberEligible: eligible, recurring: body.recurring === true, coupon: couponPercent ? { id: "simulation-coupon", percent: couponPercent } : undefined });
      const cost = (key: string) => body[key] === undefined || body[key] === null ? null : integer(body[key] as number, key);
      const contribution = estimateCoffeeOrder({
        revenueJpy: quote.totalJpy, coffeeBags: lines.reduce((sum, line) => sum + line.quantity * line.bags, 0),
        parcels: cost("parcels"), packagingJpy: cost("packagingJpy"), laborJpy: cost("laborJpy"), otherCostsJpy: cost("otherCostsJpy"),
        feeBasisPoints: body.feeBasisPoints === undefined ? 360 : cost("feeBasisPoints"),
      });
      return json({ mode: "simulation", live: false, stockReserved: false, quote, contribution });
    }

    if (url.pathname === "/api/admin/members" && request.method === "GET") {
      const query = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
      const after = (url.searchParams.get("after") ?? "").slice(0, 100);
      const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
      const rows = (await db.prepare("SELECT * FROM members WHERE id > ? AND (display_name LIKE ? ESCAPE '\\' OR claim_email LIKE ? ESCAPE '\\' OR hsap_id LIKE ? ESCAPE '\\') ORDER BY id LIMIT 51").bind(after, pattern, pattern, pattern).all<Member>()).results;
      const page = rows.slice(0, 50);
      return json({ members: page, next: rows.length > 50 ? page.at(-1)?.id : null });
    }
    if (url.pathname === "/api/admin/members" && request.method === "POST") {
      const body = await readBody(request);
      const memberId = `HS-${id()}`;
      const email = normalizeEmail(body.email);
      const name = requiredText(body.displayName, "表示名", 100);
      const hsapId = body.hsapId ? requiredText(body.hsapId, "HSAP ID", 40) : null;
      if (hsapId && !/^HSAP-\d{6}$/.test(hsapId)) throw new InputError("HSAP IDを確認してください．");
      const existing = await db.prepare("SELECT id FROM members WHERE claim_email = ? COLLATE NOCASE OR id IN (SELECT member_id FROM member_emails WHERE email = ? COLLATE NOCASE) OR (? IS NOT NULL AND hsap_id = ?)").bind(email, email, hsapId, hsapId).first();
      if (existing) return json({ error: "このメールまたはHSAP IDは登録済みです．" }, 409);
      await db.batch([
        db.prepare("INSERT INTO members (id, display_name, claim_email, hsap_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)").bind(memberId, name, email, hsapId, now, now),
        db.prepare("INSERT INTO member_emails (email, member_id, source, created_at) VALUES (?, ?, 'member-registration', ?)").bind(email, memberId, now),
        audit(db, user.id, memberId, "member.create", { hsapId }, now),
      ]);
      return json({ id: memberId }, 201);
    }

    const detail = url.pathname.match(/^\/api\/admin\/members\/([^/]+)(?:\/(grants|billing-links|status|benefits|benefit-redemptions))?$/);
    if (detail) {
      const memberId = detail[1];
      const member = await db.prepare("SELECT * FROM members WHERE id = ?").bind(memberId).first<Member>();
      if (!member) return json({ error: "会員が見つかりません．" }, 404);
      if (detail[2] === "benefits" && request.method === "GET") {
        const grants = (await db.prepare("SELECT * FROM membership_grants WHERE member_id = ?").bind(memberId).all<Grant>()).results;
        const records = (await db.prepare("SELECT * FROM benefit_redemptions WHERE member_id = ? ORDER BY created_at DESC").bind(memberId).all<Redemption>()).results;
        const decide = (kind: BenefitKind, context?: BenefitContext) => decideBenefit({ kind, memberStatus: member.status, grants, redemptions: records, context });
        return json({ policyVersion: BUSINESS_POLICY.version, live: false, month: tokyoMonth(new Date()),
          ltWaiver: decide("LT_WAIVER", { eventId: "availability-check", eventAt: now }), joinSticker: decide("JOIN_STICKER"), loyaltySticker: decide("LOYALTY_STICKER"), redemptions: records });
      }
      if (!detail[2] && request.method === "GET") {
        const [grants, billing, history] = await db.batch([
          db.prepare("SELECT * FROM membership_grants WHERE member_id = ? ORDER BY created_at DESC").bind(memberId),
          db.prepare("SELECT * FROM billing_links WHERE member_id = ? ORDER BY created_at DESC").bind(memberId),
          db.prepare("SELECT a.actor_user_id, u.name AS actor_name, a.action, a.detail, a.created_at FROM audit_log a LEFT JOIN user u ON u.id = a.actor_user_id WHERE a.member_id = ? ORDER BY a.created_at DESC LIMIT 50").bind(memberId),
        ]);
        return json({ member, grants: grants.results, billing: billing.results, history: history.results });
      }
      if (request.method !== "POST") return json({ error: "この操作には対応していません．" }, 405);
      const body = await readBody(request);
      if (detail[2] === "benefit-redemptions") {
        const kinds: BenefitKind[] = ["LT_WAIVER", "JOIN_STICKER", "LOYALTY_STICKER", "SPEAKER_STICKER", "FIRST_TALK_COFFEE"];
        if (!kinds.includes(body.kind as BenefitKind)) throw new InputError("特典の種類を確認してください．");
        const kind = body.kind as BenefitKind;
        const reason = requiredText(body.reason, "提供確認の記録", 1000);
        const context: BenefitContext = {
          eventId: body.eventId ? requiredText(body.eventId, "イベントID", 100) : undefined,
          eventAt: body.eventAt as string | undefined,
          speakerConfirmed: body.speakerConfirmed === true, firstTalkConfirmed: body.firstTalkConfirmed === true,
        };
        const grants = (await db.prepare("SELECT * FROM membership_grants WHERE member_id = ?").bind(memberId).all<Grant>()).results;
        const records = (await db.prepare("SELECT kind, benefit_key, event_id FROM benefit_redemptions WHERE member_id = ?").bind(memberId).all<Redemption>()).results;
        const decision = decideBenefit({ kind, memberStatus: member.status, grants, redemptions: records, context });
        if (!decision.allowed) return json({ error: decision.reason }, 409);
        const result = await recordBenefit(db, { memberId, actorId: user.id, kind, context, reason, decision, now });
        if (!result) return json({ error: "特典は提供済みか，会員資格が変更されています．" }, 409);
        return json(result, 201);
      }
      if (detail[2] === "grants") {
        const grant = validateGrant(body);
        if (grant.kind === "HSAP" && member.hsap_id !== grant.evidenceId) throw new InputError("登録済みHSAP IDと一致しません．");
        const duplicate = await db.prepare("SELECT id FROM membership_grants WHERE member_id = ? AND kind = ? AND evidence_id = ? AND valid_from = ?").bind(memberId, grant.kind, grant.evidenceId, grant.validFrom).first();
        if (duplicate) return json({ error: "この資格記録は登録済みです．" }, 409);
        const grantId = id();
        await db.batch([
          db.prepare("INSERT INTO membership_grants (id, member_id, kind, valid_from, valid_until, evidence_id, confirmed_by, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(grantId, memberId, grant.kind, grant.validFrom, grant.validUntil, grant.evidenceId, user.id, grant.reason, now),
          audit(db, user.id, memberId, "grant.create", { grantId, ...grant }, now),
        ]);
        return json({ id: grantId }, 201);
      }
      if (detail[2] === "billing-links") {
        const customer = requiredText(body.customerId, "Square Customer ID");
        const subscription = requiredText(body.subscriptionId, "Square Subscription ID");
        if (await db.prepare("SELECT id FROM billing_links WHERE square_subscription_id = ?").bind(subscription).first()) return json({ error: "このSquare契約は登録済みです．" }, 409);
        await db.batch([
          db.prepare("INSERT INTO billing_links (id, member_id, square_customer_id, square_subscription_id, confirmed_by, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id(), memberId, customer, subscription, user.id, now),
          audit(db, user.id, memberId, "billing.link", { customer, subscription }, now),
        ]);
        return json({ saved: true }, 201);
      }
      if (detail[2] === "status") {
        if (body.status !== "active" && body.status !== "blocked") throw new InputError("状態を確認してください．");
        const reason = requiredText(body.reason, "変更理由", 1000);
        await db.batch([
          db.prepare("UPDATE members SET status = ?, updated_at = ? WHERE id = ?").bind(body.status, now, memberId),
          audit(db, user.id, memberId, "member.status", { status: body.status, reason }, now),
        ]);
        return json({ saved: true });
      }
    }
    const revoke = url.pathname.match(/^\/api\/admin\/grants\/([^/]+)\/revoke$/);
    if (revoke && request.method === "POST") {
      const grant = await db.prepare("SELECT member_id, revoked_at FROM membership_grants WHERE id = ?").bind(revoke[1]).first<{ member_id: string; revoked_at: string | null }>();
      if (!grant) return json({ error: "資格が見つかりません．" }, 404);
      if (grant.revoked_at) return json({ error: "この資格は取消済みです．" }, 409);
      const reason = requiredText((await readBody(request)).reason, "取消理由", 1000);
      await db.batch([
        db.prepare("UPDATE membership_grants SET revoked_at = ?, revocation_source='operator' WHERE id = ?").bind(now, revoke[1]),
        audit(db, user.id, grant.member_id, "grant.revoke", { grantId: revoke[1], reason }, now),
      ]);
      return json({ saved: true });
    }
    return json({ error: "ページが見つかりません．" }, 404);
  }
}

export default createWorker();
