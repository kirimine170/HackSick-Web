import type { Env } from "./types.ts";
import { InputError, requiredText } from "./eligibility.ts";
import { CheckoutConflict, SHOP_PRODUCTS, ensureBuyer, memberAccess, shippingRecipient } from "./checkout.ts";
import { COFFEE_SUBSCRIPTIONS, previewCoffeeSubscription, trialPricing } from "./coffee-subscriptions.ts";
import { SHIPPING_POLICY } from "./shipping-policy.ts";
import { refreshBillingForUser } from "./billing.ts";
import { checkoutAvailable, type SquareGateway } from "./square.ts";
import { squareConnectionStatus } from "./square-oauth.ts";
import { sharedInventory, paySharedOrder, reconcileSharedOrder, squareRequest, visibleSharedOrder, type OrderQuote, type SharedOrder, type SharedProduct } from "./shared-checkout.ts";

export const COFFEE_TERMS_VERSION = "coffee-recurring-2026-11-07";
type User = { id: string; email: string; name?: string };
export interface CoffeeEnrollment {
  id: string; auth_user_id: string; member_id: string; plan_id: string; fingerprint: string; recipient_json: string; pricing_consent_json: string;
  state: "ready" | "activating" | "card_required" | "active" | "action_required" | "review" | "canceled";
  square_card_id: string | null; card_brand: string | null; card_last4: string | null; card_attempt_key: string;
  next_billing_date: string; terms_version: string; consented_at: string; created_at: string; updated_at: string;
}
const json = (value: unknown, status = 200) => Response.json(value, { status });
const time = () => new Date().toISOString();
export const tokyoDate = (date = new Date()) => new Date(date.getTime() + 9 * 3600000).toISOString().slice(0, 10);
export function nextCoffeeBillingDate(date = new Date()) {
  const [year, month] = tokyoDate(date).split("-").map(Number);
  return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
}
const uuid = (value: unknown) => {
  const key = requiredText(value, "受付ID", 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) throw new InputError("受付IDを確認してください．");
  return key;
};
const nonce = (value: unknown) => {
  const token = requiredText(value, "カードの確認結果", 2048);
  if (!/^cnon:[A-Za-z0-9_+=:/.-]{5,2000}$/.test(token)) throw new InputError("カード入力欄で本人認証を完了してください．");
  return token;
};
async function audit(env: Env, enrollment: CoffeeEnrollment, action: string, detail: unknown = {}) {
  await env.DB.prepare("INSERT INTO shop_audit VALUES (?,?,?,?,?)").bind(crypto.randomUUID(), enrollment.auth_user_id, action, JSON.stringify({ enrollmentId: enrollment.id, ...detail as object }), time()).run();
}
const consentPolicy = (planId: string) => {
  const plan = COFFEE_SUBSCRIPTIONS.plans.find(plan => plan.id === planId);
  if (!plan) throw new InputError("定期便のプランを確認してください．");
  return { basePriceExTaxJpy: plan.basePriceExTaxJpy, shippingFeeJpy: SHIPPING_POLICY.shippingFeeJpy, freeShippingThresholdJpy: SHIPPING_POLICY.freeShippingThresholdJpy, termsVersion: COFFEE_TERMS_VERSION };
};
export async function coffeeCapability(env: Env) {
  const scopes = env.SQUARE_ENVIRONMENT === "sandbox" && env.SQUARE_ACCESS_TOKEN ? ["CUSTOMERS_WRITE"] : (await squareConnectionStatus(env)).scopes;
  const connected = await checkoutAvailable(env);
  return { enabled: env.COFFEE_RECURRING_ENABLED === "true" && connected && scopes.includes("CUSTOMERS_WRITE"), connected, needsAuthorization: !scopes.includes("CUSTOMERS_WRITE") };
}
async function requireEnabled(env: Env) {
  if (!(await coffeeCapability(env)).enabled) throw new CheckoutConflict("定期便の受付は準備中です．");
}
async function access(env: Env, userId: string, gateway: SquareGateway) {
  await refreshBillingForUser(env, userId, gateway);
  const result = await memberAccess(env.DB, userId);
  if (result.member?.status === "blocked") throw new CheckoutConflict("購入について運営へお問い合わせください．");
  return result;
}
export { trialPricing } from "./coffee-subscriptions.ts";

export async function coffeeShop(env: Env, user: User, gateway: SquareGateway) {
  const result = await access(env, user.id, gateway);
  return { ...await coffeeCapability(env), termsVersion: COFFEE_TERMS_VERSION, eligible: result.benefit.eligible,
    plans: COFFEE_SUBSCRIPTIONS.plans.map(plan => ({ ...plan, quote: previewCoffeeSubscription(plan.id, result.benefit.eligible) })),
    trial: trialPricing(), nextBillingDate: nextCoffeeBillingDate(), billingDay: 1, shippingAroundDay: 10,
    applicationId: env.SQUARE_CLIENT_ID, locationId: env.SQUARE_LOCATION_ID, environment: env.SQUARE_ENVIRONMENT, buyerEmail: user.email };
}
export async function prepareCoffeeEnrollment(env: Env, user: User, body: Record<string, unknown>, gateway: SquareGateway) {
  await requireEnabled(env); const eligibility = await access(env, user.id, gateway);
  if (body.acceptedTerms !== true || body.acceptedCardStorage !== true || body.termsVersion !== COFFEE_TERMS_VERSION) throw new InputError("定期購入・カード保管・料金・出荷日・解約条件を確認してください．");
  const key = uuid(body.requestId); const planId = requiredText(body.planId, "プラン", 60); const pricing = consentPolicy(planId);
  const recipient = shippingRecipient(body.shipping, user.email); const nextDate = nextCoffeeBillingDate();
  const fingerprint = JSON.stringify({ planId, recipient, nextDate, pricing });
  const previous = await env.DB.prepare("SELECT * FROM coffee_enrollments WHERE id=?").bind(key).first<CoffeeEnrollment>();
  if (previous) { if (previous.auth_user_id !== user.id || previous.fingerprint !== fingerprint) throw new CheckoutConflict("申込内容が変わっています．申込状況を確認してください．"); return visibleCoffeeEnrollment(env, previous, gateway); }
  if (await env.DB.prepare("SELECT id FROM coffee_enrollments WHERE auth_user_id=? AND state<>'canceled'").bind(user.id).first()) throw new CheckoutConflict("申込済みの定期便があります．定期便の管理欄をご確認ください．");
  const stock = await sharedInventory(env, gateway); allocateCoffeeStock(trialPricing().bags, stock);
  const memberId = eligibility.member?.id ?? await ensureBuyer(env.DB, user); const now = time();
  await env.DB.prepare("INSERT INTO coffee_enrollments (id,auth_user_id,member_id,plan_id,fingerprint,recipient_json,pricing_consent_json,state,card_attempt_key,next_billing_date,terms_version,consented_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'ready',?,?,?,?,?,?)")
    .bind(key, user.id, memberId, planId, fingerprint, JSON.stringify(recipient), JSON.stringify(pricing), crypto.randomUUID(), nextDate, COFFEE_TERMS_VERSION, now, now, now).run();
  const enrollment = (await getCoffeeEnrollment(env, user.id, key))!;
  await audit(env, enrollment, "coffee.prepare"); return visibleCoffeeEnrollment(env, enrollment, gateway);
}
export async function getCoffeeEnrollment(env: Env, userId: string, enrollmentId: string) {
  return env.DB.prepare("SELECT * FROM coffee_enrollments WHERE id=? AND auth_user_id=?").bind(enrollmentId, userId).first<CoffeeEnrollment>();
}
export async function visibleCoffeeEnrollment(env: Env, enrollment: CoffeeEnrollment, gateway: SquareGateway) {
  const eligible = (await memberAccess(env.DB, enrollment.auth_user_id)).benefit.eligible;
  const orders = (await env.DB.prepare("SELECT * FROM member_orders WHERE coffee_enrollment_id=? ORDER BY created_at DESC LIMIT 24").bind(enrollment.id).all<SharedOrder>()).results;
  return { id: enrollment.id, planId: enrollment.plan_id, state: enrollment.state, nextBillingDate: enrollment.next_billing_date,
    shipping: JSON.parse(enrollment.recipient_json),
    card: enrollment.card_last4 ? { brand: enrollment.card_brand, last4: enrollment.card_last4 } : null,
    trial: trialPricing(), nextQuote: previewCoffeeSubscription(enrollment.plan_id, eligible), orders: orders.map(visibleSharedOrder),
    termsVersion: enrollment.terms_version };
}
export function allocateCoffeeStock(bags: number, inventory: SharedProduct[]) {
  const packs = Math.min(Math.floor(bags / 5), inventory.find(p => p.sku === "HS-COFFEE-MOCHA-5PACK")?.available ?? 0);
  const singles = bags - packs * 5;
  if (singles > (inventory.find(p => p.sku === "HS-COFFEE-MOCHA-10G")?.available ?? 0)) throw new CheckoutConflict("発送できる共通在庫が不足しています．請求せず，運営で確認します．");
  return SHOP_PRODUCTS.flatMap(product => { const quantity = product.bags === 5 ? packs : singles; return quantity ? [{ ...product, quantity, subtotalJpy: product.unitPriceJpy * quantity }] : []; });
}
async function customerFor(env: Env, enrollment: CoffeeEnrollment, gateway: SquareGateway) {
  await env.DB.prepare("INSERT OR IGNORE INTO coffee_customers VALUES (?,?,NULL,?)").bind(enrollment.auth_user_id, crypto.randomUUID(), time()).run();
  const entry = (await env.DB.prepare("SELECT * FROM coffee_customers WHERE auth_user_id=?").bind(enrollment.auth_user_id).first<{ creation_key: string; square_customer_id: string | null }>())!;
  if (entry.square_customer_id) return entry.square_customer_id;
  const recipient = JSON.parse(enrollment.recipient_json) as ReturnType<typeof shippingRecipient>;
  // HSAPの既存顧客や保存カードをメール検索で流用しない．専用アプリの確認済み購入者だけを作る．
  const result = await squareRequest<{ customer: { id: string; reference_id?: string } }>(gateway, "/customers", "POST", { idempotency_key: entry.creation_key, reference_id: `coffee:${enrollment.auth_user_id}`, given_name: recipient.display_name, email_address: recipient.email_address, address: recipient.address, phone_number: recipient.phone_number });
  if (!result.customer?.id || result.customer.reference_id !== `coffee:${enrollment.auth_user_id}`) throw new Error("COFFEE_CUSTOMER_MISMATCH");
  await env.DB.prepare("UPDATE coffee_customers SET square_customer_id=? WHERE auth_user_id=? AND square_customer_id IS NULL").bind(result.customer.id, enrollment.auth_user_id).run();
  return result.customer.id;
}
async function prepareCycle(env: Env, enrollment: CoffeeEnrollment, cycle: string, requestId: string, customerId: string, gateway: SquareGateway, retry = false) {
  let existing = await env.DB.prepare("SELECT * FROM member_orders WHERE coffee_enrollment_id=? AND coffee_cycle=?").bind(enrollment.id, cycle).first<SharedOrder>();
  if (existing && retry && existing.id !== requestId && ["failed", "canceled"].includes(existing.state)) {
    await env.DB.prepare("UPDATE member_orders SET coffee_cycle=? WHERE id=? AND state IN ('failed','canceled')").bind(`${cycle}:previous:${existing.id}`, existing.id).run(); existing = null;
  }
  if (existing) return existing;
  if (await env.DB.prepare("SELECT id FROM member_orders WHERE auth_user_id=? AND state IN ('paying','review')").bind(enrollment.auth_user_id).first()) throw new CheckoutConflict("確認中のお支払いがあります．結果の確認をお待ちください．");
  const eligibility = await access(env, enrollment.auth_user_id, gateway);
  const price = cycle === "trial" ? trialPricing() : previewCoffeeSubscription(enrollment.plan_id, eligibility.benefit.eligible);
  const stock = await sharedInventory(env, gateway); const lines = allocateCoffeeStock(price.bags, stock);
  const subtotalJpy = lines.reduce((sum, line) => sum + line.subtotalJpy, 0);
  if (subtotalJpy < price.goodsTotalJpy) throw new CheckoutConflict("商品価格の整合を運営で確認します．請求は行いません．");
  const quote: OrderQuote = { policyVersion: COFFEE_SUBSCRIPTIONS.version, lines, subtotalJpy, bags: price.bags, discountPercent: price.discountPercent,
    discountJpy: subtotalJpy - price.goodsTotalJpy, shippingJpy: price.shippingJpy, totalJpy: price.totalJpy,
    planBaseExTaxJpy: price.basePriceExTaxJpy, memberDiscountExTaxJpy: price.discountExTaxJpy, taxJpy: price.taxJpy, taxPercent: COFFEE_SUBSCRIPTIONS.taxPercent, goodsTotalJpy: price.goodsTotalJpy,
    discountLabel: cycle === "trial" ? "お試し便専用料金" : price.discountPercent ? "定期便専用料金・会員特典5％" : "定期便専用料金",
    fulfillmentHint: cycle === "trial" ? "決済後5日以内を目安に出荷" : `${cycle.slice(0,7)}の10日ごろ一斉発送` };
  const now = time();
  await env.DB.prepare("INSERT OR IGNORE INTO member_orders (id,auth_user_id,member_id,fingerprint,quote_json,recipient_json,catalog_json,state,created_at,expires_at,updated_at,purchase_kind,coffee_enrollment_id,coffee_cycle,square_customer_id) VALUES (?,?,?,?,?,?,?,'ready',?,?,?,?,?,?,?)")
    .bind(requestId, enrollment.auth_user_id, enrollment.member_id, JSON.stringify({ enrollmentId: enrollment.id, cycle, quote }), JSON.stringify(quote), enrollment.recipient_json, JSON.stringify(stock), now, new Date(Date.now()+900000).toISOString(), now, cycle === "trial" ? "coffee-trial" : "coffee-cycle", enrollment.id, cycle, customerId).run();
  const order = await env.DB.prepare("SELECT * FROM member_orders WHERE coffee_enrollment_id=? AND coffee_cycle=?").bind(enrollment.id,cycle).first<SharedOrder>();
  if (!order || order.auth_user_id !== enrollment.auth_user_id) throw new CheckoutConflict("購入受付を確認してください．");
  return order;
}
async function allowed(env: Env, enrollmentId: string, order: SharedOrder) {
  const enrollment = await env.DB.prepare("SELECT * FROM coffee_enrollments WHERE id=?").bind(enrollmentId).first<CoffeeEnrollment>();
  if (!enrollment || enrollment.state === "canceled" || enrollment.state === "review") return false;
  const buyer = await memberAccess(env.DB, enrollment.auth_user_id);
  if (buyer.member?.status === "blocked") return false;
  if (order.coffee_cycle === "trial") return ["ready", "activating", "action_required"].includes(enrollment.state);
  if (!["active", "action_required"].includes(enrollment.state) || JSON.stringify(consentPolicy(enrollment.plan_id)) !== enrollment.pricing_consent_json) return false;
  const price = previewCoffeeSubscription(enrollment.plan_id, buyer.benefit.eligible);
  return (JSON.parse(order.quote_json) as OrderQuote).totalJpy === price.totalJpy && order.coffee_cycle === enrollment.next_billing_date;
}
async function saveCard(env: Env, enrollment: CoffeeEnrollment, customerId: string, sourceId: string, gateway: SquareGateway) {
  const current = await getCoffeeEnrollment(env,enrollment.auth_user_id,enrollment.id);
  if (!current || current.state === "canceled") return;
  const result = await squareRequest<{ card: { id: string; customer_id: string; enabled: boolean; card_brand?: string; last_4?: string } }>(gateway,"/cards","POST",{ idempotency_key: enrollment.card_attempt_key, source_id: sourceId, card: { customer_id: customerId, reference_id: `coffee:${enrollment.id}` } });
  const card = result.card;
  if (!card?.id?.startsWith("ccof:") || card.customer_id !== customerId || card.enabled !== true || !/^\d{4}$/.test(card.last_4 ?? "")) throw new Error("COFFEE_CARD_MISMATCH");
  await env.DB.prepare("UPDATE coffee_enrollments SET square_card_id=?,card_brand=?,card_last4=?,state='active',updated_at=? WHERE id=? AND state<>'canceled'").bind(card.id, card.card_brand ?? "CARD", card.last_4, time(), enrollment.id).run();
  await audit(env,enrollment,"coffee.card-store");
  await queueCoffeeNotice(env,enrollment,"enrolled");
}
export async function payCoffeeEnrollment(env: Env, user: User, enrollmentId: string, body: Record<string,unknown>, gateway: SquareGateway) {
  await requireEnabled(env); let enrollment = await getCoffeeEnrollment(env,user.id,enrollmentId);
  if (!enrollment) return json({error:"定期便が見つかりません．"},404);
  if (["canceled","review"].includes(enrollment.state)) throw new CheckoutConflict("定期便の状態を運営で確認してください．");
  const requestId = uuid(body.requestId); const source = nonce(body.sourceId);
  const trial = await env.DB.prepare("SELECT * FROM member_orders WHERE coffee_enrollment_id=? AND coffee_cycle='trial'").bind(enrollment.id).first<SharedOrder>();
  const cycle = trial?.state === "paid" ? enrollment.next_billing_date : "trial";
  if (cycle === "trial" && enrollment.next_billing_date !== nextCoffeeBillingDate()) {
    await env.DB.prepare("UPDATE coffee_enrollments SET next_billing_date=?,updated_at=? WHERE id=? AND state<>'canceled'").bind(nextCoffeeBillingDate(),time(),enrollment.id).run();
    throw new CheckoutConflict("月が替わったため，通常便の初回決済日を更新しました．申込状況から日付を確認し直してください．");
  }
  if (cycle !== "trial" && enrollment.state !== "action_required") return json(await visibleCoffeeEnrollment(env,enrollment,gateway));
  if(cycle!=="trial"&&cycle.slice(0,7)!==tokyoDate().slice(0,7))throw new CheckoutConflict("過去月のお支払いは運営へご相談ください．");
  if(cycle!=="trial"){
    await env.DB.prepare("UPDATE coffee_enrollments SET card_attempt_key=? WHERE id=?").bind(requestId,enrollment.id).run();enrollment.card_attempt_key=requestId;
  }
  const customer = await customerFor(env,enrollment,gateway);
  const order = await prepareCycle(env,enrollment,cycle,requestId,customer,gateway,true);
  if (cycle === "trial") await env.DB.prepare("UPDATE coffee_enrollments SET state='activating',updated_at=? WHERE id=? AND state IN ('ready','action_required','activating')").bind(time(),enrollment.id).run();
  const response = await paySharedOrder(env,user.id,order.id,body,gateway,{kind:cycle === "trial"?"coffee-trial":"coffee-cycle",customerId:customer,sourceId:source,customerInitiated:true,authorize:()=>allowed(env,enrollment!.id,order)});
  const latest=(await env.DB.prepare("SELECT * FROM member_orders WHERE id=?").bind(order.id).first<SharedOrder>())!;
  if (latest.state === "paid") {
    try { await saveCard(env,enrollment,customer,latest.square_payment_id!,gateway); }
    catch { await setState(env,enrollment,"card_required"); }
    if (cycle !== "trial") await advanceCycle(env,enrollment,cycle);
  } else if (["review","paying"].includes(latest.state)) await setState(env,enrollment,"review");
  else if (["failed","canceled"].includes(latest.state)) await setState(env,enrollment,"action_required");
  enrollment=(await getCoffeeEnrollment(env,user.id,enrollmentId))!;
  if(!response.ok) return response;
  return json(await visibleCoffeeEnrollment(env,enrollment,gateway));
}
async function setState(env: Env, enrollment: CoffeeEnrollment, state: CoffeeEnrollment["state"]) {
  await env.DB.prepare("UPDATE coffee_enrollments SET state=?,updated_at=? WHERE id=? AND state<>'canceled'").bind(state,time(),enrollment.id).run();
  if(["action_required","card_required","review"].includes(state))await queueCoffeeNotice(env,enrollment,`action:${enrollment.next_billing_date}`);
}
async function advanceCycle(env: Env,enrollment: CoffeeEnrollment,cycle:string) {
  const next=nextCoffeeBillingDate(new Date(`${cycle}T00:00:00+09:00`));
  await env.DB.prepare("UPDATE coffee_enrollments SET next_billing_date=?,updated_at=? WHERE id=? AND next_billing_date=? AND state<>'canceled'").bind(next,time(),enrollment.id,cycle).run();
}
export async function updateCoffeeCard(env:Env,user:User,enrollmentId:string,body:Record<string,unknown>,gateway:SquareGateway){
  await requireEnabled(env);const enrollment=await getCoffeeEnrollment(env,user.id,enrollmentId);
  if(!enrollment)return json({error:"定期便が見つかりません．"},404);
  if(body.acceptedCardStorage!==true||!["card_required","active"].includes(enrollment.state))throw new InputError("カード保管への同意と申込状況を確認してください．");
  const paid=await env.DB.prepare("SELECT id FROM member_orders WHERE coffee_enrollment_id=? AND coffee_cycle='trial' AND state='paid'").bind(enrollment.id).first();
  if(!paid)throw new CheckoutConflict("お試し便の決済状態を先に確認してください．");
  const customer=await customerFor(env,enrollment,gateway);const attempt=uuid(body.requestId);
  await env.DB.prepare("UPDATE coffee_enrollments SET card_attempt_key=? WHERE id=? AND state IN ('card_required','active')").bind(attempt,enrollment.id).run();
  enrollment.card_attempt_key=attempt;await saveCard(env,enrollment,customer,nonce(body.sourceId),gateway);
  return json(await visibleCoffeeEnrollment(env,(await getCoffeeEnrollment(env,user.id,enrollment.id))!,gateway));
}
export async function cancelCoffeeEnrollment(env:Env,userId:string,enrollmentId:string,gateway:SquareGateway){
  const enrollment=await getCoffeeEnrollment(env,userId,enrollmentId);if(!enrollment)return json({error:"定期便が見つかりません．"},404);
  // 決済と同じロックを使い，解約完了後に新しい月次請求が始まることを防ぐ．
  const owner=`cancel:${enrollment.id}`;
  const lock=await env.DB.prepare("UPDATE member_payment_lock SET owner=?,expires_at=? WHERE id=1 AND expires_at<?").bind(owner,new Date(Date.now()+60000).toISOString(),time()).run();
  if(!lock.meta.changes)throw new CheckoutConflict("決済を確認中です．少し待って解約を再試行してください．");
  try{await env.DB.prepare("UPDATE coffee_enrollments SET state='canceled',updated_at=? WHERE id=?").bind(time(),enrollment.id).run();await audit(env,enrollment,"coffee.cancel");await queueCoffeeNotice(env,enrollment,"canceled");}
  finally{await env.DB.prepare("UPDATE member_payment_lock SET owner=NULL,expires_at='1970-01-01T00:00:00.000Z' WHERE id=1 AND owner=?").bind(owner).run();}
  return json(await visibleCoffeeEnrollment(env,(await getCoffeeEnrollment(env,userId,enrollmentId))!,gateway));
}
/** 申込時の明示同意のある契約だけを月初に請求する．在庫・資格が不明なら決済しない． */
export async function billCoffeeSubscriptions(env:Env,gateway:SquareGateway,clock=new Date()){
  if(env.COFFEE_RECURRING_ENABLED!=="true"||!(await coffeeCapability(env)).enabled)return {processed:0};
  const today=tokyoDate(clock);if(!today.endsWith("-01"))return {processed:0};
  if(await env.DB.prepare("SELECT id FROM member_payment_lock WHERE id=1 AND expires_at>?").bind(time()).first())return {processed:0};
  const owner=crypto.randomUUID();
  const lease=await env.DB.prepare("UPDATE coffee_billing_lock SET owner=?,expires_at=? WHERE id=1 AND expires_at<?").bind(owner,new Date(Date.now()+900000).toISOString(),time()).run();
  if(!lease.meta.changes)return {processed:0};
  try{
  const enrollments=(await env.DB.prepare("SELECT * FROM coffee_enrollments WHERE state='active' AND next_billing_date<=? ORDER BY next_billing_date,id LIMIT 10").bind(today).all<CoffeeEnrollment>()).results;
  let processed=0;
  for(const enrollment of enrollments){
    const renewed=await env.DB.prepare("UPDATE coffee_billing_lock SET expires_at=? WHERE id=1 AND owner=? AND expires_at>?").bind(new Date(Date.now()+900000).toISOString(),owner,time()).run();
    if(!renewed.meta.changes)break;
    if(enrollment.next_billing_date!==today||!enrollment.square_card_id||JSON.stringify(consentPolicy(enrollment.plan_id))!==enrollment.pricing_consent_json){await setState(env,enrollment,"action_required");continue;}
    try{
      await access(env,enrollment.auth_user_id,gateway);
      const customer=await customerFor(env,enrollment,gateway);
      const order=await prepareCycle(env,enrollment,today,crypto.randomUUID(),customer,gateway);
      const quote=JSON.parse(order.quote_json) as OrderQuote;
      const response=await paySharedOrder(env,enrollment.auth_user_id,order.id,{confirmedTotalJpy:quote.totalJpy},gateway,{kind:"coffee-cycle",customerId:customer,sourceId:enrollment.square_card_id,customerInitiated:false,authorize:()=>allowed(env,enrollment.id,order)});
      const row=(await env.DB.prepare("SELECT * FROM member_orders WHERE id=?").bind(order.id).first<SharedOrder>())!;
      if(row.state==="paid"){await advanceCycle(env,enrollment,today);await audit(env,enrollment,"coffee.cycle-paid",{orderId:row.id,cycle:today});processed++;}
      else if(["paying","review"].includes(row.state))await setState(env,enrollment,"review");
      else if(!response.ok||["failed","canceled"].includes(row.state))await setState(env,enrollment,"action_required");
    }catch{await setState(env,enrollment,"action_required");await audit(env,enrollment,"coffee.billing-held",{cycle:today});}
  }
  return {processed};
  }finally{await env.DB.prepare("UPDATE coffee_billing_lock SET owner=NULL,expires_at='1970-01-01T00:00:00.000Z' WHERE id=1 AND owner=?").bind(owner).run();}
}
export async function reconcileCoffeeEnrollment(env:Env,enrollment:CoffeeEnrollment,gateway:SquareGateway){
  const orders=(await env.DB.prepare("SELECT * FROM member_orders WHERE coffee_enrollment_id=? AND coffee_cycle NOT LIKE '%:previous:%' ORDER BY created_at DESC LIMIT 24").bind(enrollment.id).all<SharedOrder>()).results;
  // 継続中の契約を古いお試し決済・カードへ戻さない．初回登録の回復だけに使う．
  const recoveringTrial=enrollment.state==="activating"||(enrollment.state==="review"&&!enrollment.square_card_id);
  const current = orders.find(order => order.coffee_cycle === enrollment.next_billing_date) ?? (recoveringTrial?orders.find(order => order.coffee_cycle === "trial"):undefined);
  for(const order of current ? [current] : []){
    const latest=await reconcileSharedOrder(env,order,gateway);
    if(latest.state==="paid"&&["review","activating"].includes(enrollment.state)){
      if(latest.coffee_cycle==="trial"){
        try{await saveCard(env,enrollment,await customerFor(env,enrollment,gateway),latest.square_payment_id!,gateway);}catch{await setState(env,enrollment,"card_required");}
      }else{await setState(env,enrollment,"active");await advanceCycle(env,enrollment,latest.coffee_cycle!);}
    }else if(latest.state==="paid"&&latest.coffee_cycle!=="trial")await advanceCycle(env,enrollment,latest.coffee_cycle!);
    else if(["failed","canceled"].includes(latest.state)&&["review","activating"].includes(enrollment.state))await setState(env,enrollment,"action_required");
  }
  if(enrollment.state!=="canceled"&&(await env.DB.prepare("SELECT id FROM member_orders WHERE coffee_enrollment_id=? AND state='review'").bind(enrollment.id).first()))await setState(env,enrollment,"review");
  return (await getCoffeeEnrollment(env,enrollment.auth_user_id,enrollment.id))!;
}

export async function sweepCoffeeEnrollments(env:Env,gateway:SquareGateway){
  const rows=(await env.DB.prepare("SELECT DISTINCT e.* FROM coffee_enrollments e LEFT JOIN member_orders o ON o.coffee_enrollment_id=e.id AND o.coffee_cycle=e.next_billing_date WHERE e.state IN ('activating','review') OR (e.state='active' AND o.state='paid') LIMIT 20").all<CoffeeEnrollment>()).results;
  const results=await Promise.allSettled(rows.map(row=>reconcileCoffeeEnrollment(env,row,gateway)));
  if(results.some(result=>result.status==="rejected"))throw Error("COFFEE_RECONCILIATION_PENDING");
}

async function queueCoffeeNotice(env:Env,enrollment:CoffeeEnrollment,kind:string){
  if(env.SQUARE_ENVIRONMENT!=="production")return;
  const now=time();
  for(const audience of ["buyer","operator"]){
    await env.DB.prepare("INSERT OR IGNORE INTO coffee_notices (id,enrollment_id,kind,audience,next_attempt_at,created_at) VALUES (?,?,?,?,?,?)")
      .bind(`${enrollment.id}:${kind}:${audience}`,enrollment.id,kind,audience,now,now).run();
  }
}
/** 申込・支払失敗・解約に伴う取引通知．カード情報・配送先はメール本文へ含めない． */
export async function deliverCoffeeNotices(env:Env,transport:typeof fetch=fetch){
  if(env.SQUARE_ENVIRONMENT!=="production"||!env.RESEND_API_KEY)return;
  const rows=(await env.DB.prepare("SELECT * FROM coffee_notices WHERE state IN ('pending','sending') AND next_attempt_at<=? ORDER BY created_at LIMIT 10").bind(time()).all<{id:string;enrollment_id:string;kind:string;audience:string;attempts:number;created_at:string}>()).results;
  for(const notice of rows){
    const claimed=await env.DB.prepare("UPDATE coffee_notices SET state='sending',attempts=attempts+1,next_attempt_at=? WHERE id=? AND state IN ('pending','sending') AND next_attempt_at<=?").bind(new Date(Date.now()+120000).toISOString(),notice.id,time()).run();if(!claimed.meta.changes)continue;
    const enrollment=await env.DB.prepare("SELECT * FROM coffee_enrollments WHERE id=?").bind(notice.enrollment_id).first<CoffeeEnrollment>();
    const valid=enrollment&&(notice.kind==="enrolled"?enrollment.state==="active":notice.kind==="canceled"?enrollment.state==="canceled":["review","card_required","action_required"].includes(enrollment.state));
    if(!valid){await env.DB.prepare("UPDATE coffee_notices SET state='canceled' WHERE id=?").bind(notice.id).run();continue;}
    const user=await env.DB.prepare('SELECT email FROM user WHERE id=?').bind(enrollment!.auth_user_id).first<{email:string}>();
    const to=notice.audience==="buyer"?user?.email:env.ORDER_NOTIFICATION_EMAIL;
    if(!to){await env.DB.prepare("UPDATE coffee_notices SET state='failed' WHERE id=?").bind(notice.id).run();continue;}
    const plan=COFFEE_SUBSCRIPTIONS.plans.find(p=>p.id===enrollment!.plan_id)!;
    const title=notice.kind==="enrolled"?"珈琲定期便のお申込みを受け付けました":notice.kind==="canceled"?"珈琲定期便を解約しました":"珈琲定期便の確認が必要です";
    const detail=notice.kind==="enrolled"?`通常便の次回決済日は${enrollment!.next_billing_date}，出荷は10日ごろです．基本料金は税別${plan.basePriceExTaxJpy}円で，その回の会員資格・税率・送料条件から支払総額を計算します．`:
      notice.kind==="canceled"?"今後の自動請求を停止しました．お支払い済みの注文の取消・返金はshop@へご相談ください．":"在庫・お支払い・カード登録の確認が必要なため，次の自動請求を停止しています．支払結果が確認中の場合は，重ねて支払わず運営へお問い合わせください．";
    try{
      const portal = env.SHOP_BASE_URL ?? env.AUTH_BASE_URL;
      const result=await transport("https://api.resend.com/emails",{method:"POST",headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,"Content-Type":"application/json","Idempotency-Key":`coffee-${notice.id}`},body:JSON.stringify({from:env.MAIL_FROM,to:[to],reply_to:"shop@hacksick.com",subject:`HackSick ${title}`,text:`${title}．\n${plan.name}\n受付番号：${enrollment!.id}\n\n${detail}\n\n申込・購入状況：${portal}\nお問い合わせ：shop@hacksick.com`}),signal:AbortSignal.timeout(10000)});
      if(!result.ok)throw Error("COFFEE_MAIL_FAILED");const value=await result.json() as {id?:string};if(!value.id)throw Error("COFFEE_MAIL_FAILED");
      await env.DB.prepare("UPDATE coffee_notices SET state='sent',provider_id=? WHERE id=?").bind(value.id,notice.id).run();
    }catch{await env.DB.prepare("UPDATE coffee_notices SET state=?,next_attempt_at=? WHERE id=?").bind(notice.attempts>=9||Date.now()-Date.parse(notice.created_at)>23*3600000?"failed":"pending",new Date(Date.now()+Math.min(60,2**(notice.attempts+1))*60000).toISOString(),notice.id).run();}
  }
}
