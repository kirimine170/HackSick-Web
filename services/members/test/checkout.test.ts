import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createWorker } from "../src/worker.ts";
import { CHECKOUT_POLICY, memberQuote, shippingRecipient } from "../src/checkout.ts";
import { normalizeHsapRows, HSAP_SOURCE } from "../src/hsap.ts";
import { validSquareSignature, SquareRequestError, type SquareGateway, type SquareOrder, type SquarePayment } from "../src/square.ts";
import type { Env } from "../src/types.ts";

const shipping = { name: "試験用受取人", phone: "09000000000", country: "JP", postalCode: "100-0001", prefecture: "東京都", city: "千代田区", addressLine1: "試験用住所1", addressLine2: "" };
const single = [{ sku: "HS-COFFEE-MOCHA-10G", quantity: 1 }];
test("公開中の送料条件と10％引き，円単位の丸めを使う", () => {
  assert.equal(CHECKOUT_POLICY.recurringDiscountPercent, 5);
  assert.equal(CHECKOUT_POLICY.recurringCheckoutEnabled, false);
  assert.equal(memberQuote(single).totalJpy, 889);
  assert.equal(memberQuote([{ sku: "HS-COFFEE-MOCHA-5PACK", quantity: 1 }]).totalJpy, 2347);
  const two = memberQuote([{ sku: "HS-COFFEE-MOCHA-5PACK", quantity: 2 }]);
  assert.equal(two.subtotalJpy, 4104); assert.equal(two.discountJpy, 410); assert.equal(two.shippingJpy, 500); assert.equal(two.totalJpy, 4194);
  const free = memberQuote([{ sku: "HS-COFFEE-MOCHA-5PACK", quantity: 3 }]); assert.equal(free.shippingJpy, 0);
  for (const items of [[], [{ sku: "x", quantity: 1 }], [{ sku: single[0].sku, quantity: 0.5 }], [...single, ...single]]) assert.throws(() => memberQuote(items));
  assert.throws(() => shippingRecipient({ ...shipping, country: "US" }, "test@example.invalid"));
  assert.throws(() => shippingRecipient({ ...shipping, postalCode: "123" }, "test@example.invalid"));
});

test("HSAPの確定メールを推測せず，未承認・退会・重複メールを見分ける", () => {
  const row = { hsapId: "HSAP-000001", displayName: "試験会員", email: "person@example.invalid", status: "承認済" };
  assert.equal(normalizeHsapRows([row])[0].workspaceEmail, null);
  assert.equal(normalizeHsapRows([{ ...row, departedAt: "2026-11-01" }])[0].active, false);
  assert.equal(normalizeHsapRows([{ ...row, status: "申請中" }])[0].active, false);
  assert.throws(() => normalizeHsapRows([row, { ...row, hsapId: "HSAP-000002" }]));
  assert.throws(() => normalizeHsapRows([{ ...row, workspaceEmail: "other@outside.invalid" }]));
});

test("共通Square在庫の会員決済を，実際の認証とD1で検証する", async t => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {fetch(){return new Response('test')}}", d1Databases: ["DB"], compatibilityDate: "2026-11-03" })); t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  for (const file of (await readdir("migrations")).filter(f => f.endsWith(".sql")).sort()) { const sql = (await readFile(`migrations/${file}`,"utf8")).replace(/^--.*$/gm,""); await db.batch(sql.split(";").map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s))); }
  const origin = "http://localhost:8787"; const codes = new Map<string,string>(); const orders = new Map<string,SquareOrder>(); const payments = new Map<string,SquarePayment>();
  let stock = 8; let inventoryLag = false; const inventorySales:any[]=[]; const delayedSales:any[]=[]; let decline = false; let paymentCalls = 0; let loseResponse = false; let wrongAmount = false; let beforePayment: (()=>Promise<void>) | null = null;
  const parents=["UN24C26GOGFGUCD7UN6YTYGQ","LQSNTW5JKHNFRVV3BLBFHECJ","B7WPK6VNARQJTYCLQ2TRMCYJ"];
  const skus=[single[0].sku,"HS-COFFEE-MOCHA-5PACK","HS-BOOK-ANOKOTO-A5"];
  let bookStock = 8;
  const gateway: SquareGateway = {
    async request<T>(path:string,_method?:string,body?:unknown):Promise<T> {
      const payload=body as any; let result:any;
      if(path === "/catalog/batch-retrieve") result={objects:parents.map((parent,i)=>({id:parent,type:"ITEM",present_at_all_locations:true,item_data:{variations:[{id:`variation-${i}`,type:"ITEM_VARIATION",present_at_all_locations:true,item_variation_data:{item_id:parent,sku:skus[i],track_inventory:true,price_money:{amount:[432,2052,1500,600,800][i],currency:"JPY"}}}]}}))};
      else if(path === "/inventory/counts/batch-retrieve") result={counts:skus.map((_,i)=>({catalog_object_id:`variation-${i}`,location_id:"test-location",state:"IN_STOCK",quantity:String(i === 2 ? bookStock : stock),calculated_at:new Date().toISOString()}))};
      else if(path === "/inventory/changes/batch-retrieve") result={changes:inventorySales.map(adjustment=>({type:"ADJUSTMENT",adjustment}))};
      else if(path === "/orders") {
        let order=orders.get(payload.idempotency_key);
        if(!order){ const o=payload.order; const amount=o.line_items.reduce((n:number,l:any)=>n+Number(l.quantity)*l.base_price_money.amount,0)-o.discounts.reduce((n:number,d:any)=>n+d.amount_money.amount,0)+(o.service_charges?.[0]?.amount_money.amount??0);
          order={id:payload.idempotency_key,location_id:o.location_id,reference_id:o.reference_id,state:"OPEN",total_money:{amount:amount+(wrongAmount?1:0),currency:"JPY"},fulfillments:o.fulfillments};orders.set(order!.id,order!); }
        result={order};
      } else if(path === "/payments") {
        paymentCalls++; if(decline)throw new SquareRequestError(400,["CARD_DECLINED"]); if(beforePayment)await beforePayment();
        const payment:SquarePayment={id:`payment-${payload.order_id}`,order_id:payload.order_id,location_id:payload.location_id,status:"COMPLETED",total_money:payload.amount_money}; payments.set(payment.id,payment); const order=orders.get(payload.order_id)!;order.tenders=[{payment_id:payment.id}];const sale={transaction_id:order.id,catalog_object_id:"variation-0",from_state:"IN_STOCK",to_state:"SOLD",from_location_id:"test-location",to_location_id:"test-location",quantity:"1",created_at:new Date().toISOString()};if(inventoryLag)delayedSales.push(sale);else{stock--;inventorySales.push(sale);}result={payment};if(loseResponse)throw new Error("simulated lost response");
      } else throw new Error(`unexpected test API ${path}`);
      return structuredClone(result) as T;
    },
    async getOrder(id){return structuredClone(orders.get(id)!);},async getPayment(id){return structuredClone(payments.get(id)!);},
  };
  const worker=createWorker(async({email,otp})=>{codes.set(email,otp);},()=>gateway);
  const env={DB:db,ASSETS:{fetch:async()=>new Response("asset")},AUTH_BASE_URL:origin,BETTER_AUTH_SECRET:"shared-integration-test-secret-only",GOOGLE_WORKSPACE_DOMAIN:"hacksick.com",MAIL_FROM:"test@example.invalid",CHECKOUT_ENABLED:"true",SQUARE_ENVIRONMENT:"sandbox",SQUARE_ACCESS_TOKEN:"fake",SQUARE_CLIENT_ID:"sandbox-test",SQUARE_LOCATION_ID:"test-location",SQUARE_WEBHOOK_SIGNATURE_KEY:"test-signature",SQUARE_WEBHOOK_URL:`${origin}/api/square/webhook`} as unknown as Env;
  let ip=0;
  const call=(path:string,cookie="",body?:unknown,source=origin)=>worker.fetch(new Request(origin+path,{method:body===undefined?"GET":"POST",headers:{Cookie:cookie,Origin:source,"Content-Type":"application/json","cf-connecting-ip":`192.0.2.${ip}`},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);
  async function login(email:string){ip++;assert.equal((await call("/api/auth/email-otp/send-verification-otp","",{email,type:"sign-in"})).status,200);const res=await call("/api/auth/sign-in/email-otp","",{email,otp:codes.get(email)});assert.equal(res.status,200);const user=(await res.json() as any).user;return{id:user.id as string,cookie:res.headers.getSetCookie().map(v=>v.split(";")[0]).join("; ")};}
  const operator=await login("operator@example.invalid"); await db.prepare("INSERT INTO operators VALUES (?,'manager',?)").bind(operator.id,new Date().toISOString()).run();
  const hsap=await login("hsap@example.invalid"),monthly=await login("monthly@example.invalid"),outsider=await login("outsider@hacksick.com");
  await t.test("運営画面のHTMLは公開ページから分離し，運営アカウントへだけ返す", async () => {
    assert.equal((await call("/api/admin/panel")).status, 401);
    assert.equal((await call("/api/admin/panel", outsider.cookie)).status, 403);
    const panel = await call("/api/admin/panel", operator.cookie);
    assert.equal(panel.status, 200);
    assert.equal(panel.headers.get("cache-control"), "no-store");
    assert.match(await panel.text(), /id="shop-coupon-form"/);
    const page = await readFile("public/index.html", "utf8");
    assert.doesNotMatch(page, /id="shop-coupon-form"|id="hsap-import-form"/);
  });
  async function addMember(email:string,cookie:string,kind:string){const response=await call("/api/admin/members",operator.cookie,{email,displayName:"合成会員",...(kind==="HSAP"?{hsapId:"HSAP-000010"}:{})});assert.equal(response.status,201);const memberId=(await response.json() as any).id;assert.equal((await call(`/api/admin/members/${memberId}/grants`,operator.cookie,{kind,validFrom:new Date(Date.now()-86400000).toISOString(),validUntil:new Date(Date.now()+86400000).toISOString(),evidenceId:kind==="HSAP"?"HSAP-000010":"synthetic-paid-evidence",reason:"合成データで在籍・入金を確認"})).status,201);await call("/api/me",cookie);return memberId as string;}
  const hsapId=await addMember("hsap@example.invalid",hsap.cookie,"HSAP");await addMember("monthly@example.invalid",monthly.cookie,"MONTHLY");
  const purchase=(requestId=crypto.randomUUID(),items=single)=>({requestId,items,shipping,acceptedTerms:true,discountPercent:100,totalJpy:1});
  const prepare=async(cookie=hsap.cookie,body: Record<string, unknown>=purchase())=>{const response=await call("/api/shop/checkouts",cookie,body);assert.equal(response.status,200,await response.clone().text());return await response.json() as any;};
  const pay=(id:string,cookie=hsap.cookie,sourceId="cnon:synthetic-token")=>call(`/api/shop/checkouts/${id}/pay`,cookie,{sourceId,confirmedTotalJpy:889});
  await t.test("ログイン・会員資格・Origin・公開スイッチで購入を制限する",async()=>{assert.equal((await call("/api/shop/checkouts","",purchase())).status,401);assert.equal((await call("/api/shop/checkouts",outsider.cookie,purchase())).status,403);assert.equal((await call("/api/shop/checkouts",hsap.cookie,purchase(),"https://evil.invalid")).status,403);env.CHECKOUT_ENABLED="false";assert.equal((await call("/api/shop/checkouts",hsap.cookie,purchase())).status,503);env.CHECKOUT_ENABLED="true";assert.equal((await call("/api/admin/shop/stock",operator.cookie,{allocatedBags:50})).status,410);});
  await t.test("HSAP・月額会員に同じ10％引き，送料は割引対象外，準備だけでは在庫を変更しない",async()=>{for(const cookie of [hsap.cookie,monthly.cookie]){const r=await prepare(cookie);assert.equal(r.quote.totalJpy,889);assert.equal(r.quote.discountJpy,43);assert.equal(r.quote.shippingJpy,500);}assert.equal(stock,8);const shop=await(await call("/api/shop",hsap.cookie)).json() as any;assert.equal(shop.stock.shared,true);assert.equal(shop.products[0].available,8);assert.equal(shop.policy.discountPercent,10);assert.equal(shop.policy.recurringDiscountPercent,5);assert.equal(shop.policy.recurringCheckoutEnabled,false);});
  let first:any;
  await t.test("カタログ商品を使う注文で，共通在庫が決済時に減る．同一受付は一度しか請求しない",async()=>{first=await prepare();const r=await pay(first.id);assert.equal(r.status,200,await r.clone().text());assert.equal((await r.json() as any).state,"paid");assert.equal(stock,7);assert.equal(paymentCalls,1);await pay(first.id);assert.equal(paymentCalls,1);assert.equal((await call(`/api/shop/checkouts/${first.id}`,monthly.cookie)).status,404);assert.equal((await call("/api/shop/checkouts",monthly.cookie,purchase(first.id))).status,409);});
  await t.test("現金・外部決済への偽装は拒否する",async()=>{const r=await prepare();assert.equal((await pay(r.id,hsap.cookie,"CASH")).status,400);assert.equal((await pay(r.id,hsap.cookie,"EXTERNAL")).status,400);assert.equal(paymentCalls,1);});
  await t.test("決済前に在庫と資格を再確認する",async()=>{const r=await prepare();stock=0;assert.equal((await pay(r.id)).status,409);assert.equal(paymentCalls,1);stock=7;await db.prepare("UPDATE members SET status='blocked' WHERE id=?").bind(hsapId).run();assert.equal((await pay(r.id)).status,403);await db.prepare("UPDATE members SET status='active' WHERE id=?").bind(hsapId).run();});
  await t.test("決済応答が消えても同じ支払いを再作成せず，Square記録から復旧する",async()=>{const r=await prepare();loseResponse=true;assert.equal((await pay(r.id)).status,409);loseResponse=false;const calls=paymentCalls;const recovered=await pay(r.id);assert.equal((await recovered.json() as any).state,"paid");assert.equal(paymentCalls,calls);});
  await t.test("カードの明示的な拒否は未払いで終わり，通信障害と区別する",async()=>{const r=await prepare();decline=true;const before=stock;const response=await pay(r.id);assert.equal(response.status,200);assert.equal((await response.json() as any).state,"failed");assert.equal(stock,before);decline=false;});
  await t.test("金額不一致はカードに請求せず確認対象にする",async()=>{const r=await prepare();wrongAmount=true;const calls=paymentCalls;const response=await pay(r.id);assert.equal((await response.json() as any).state,"review");assert.equal(paymentCalls,calls);wrongAmount=false;await db.prepare("UPDATE member_orders SET state='canceled' WHERE id=?").bind(r.id).run();});
  await t.test("会員カート内の同時決済は直列化する",async()=>{const a=await prepare(),b=await prepare(monthly.cookie);let release!:()=>void;let entered!:()=>void;const started=new Promise<void>(r=>{entered=r;});const gate=new Promise<void>(r=>{release=r;});beforePayment=async()=>{entered();await gate;};const firstPay=pay(a.id);await started;assert.equal((await pay(b.id,monthly.cookie)).status,409);release();assert.equal((await firstPay).status,200);beforePayment=null;});
  await t.test("未署名通知は拒否し，署名付き通知でもSquareの支払済み記録を再確認する",async()=>{const orderId=first.id;const raw=JSON.stringify({event_id:"synthetic-event",type:"payment.updated",data:{object:{payment:{order_id:orderId}}}});const notify=(signature:string)=>worker.fetch(new Request(origin+"/api/square/webhook",{method:"POST",headers:{"x-square-hmacsha256-signature":signature},body:raw}),env);assert.equal((await notify("bad")).status,403);const key=await crypto.subtle.importKey("raw",new TextEncoder().encode("test-signature"),{name:"HMAC",hash:"SHA-256"},false,["sign"]);const signature=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(env.SQUARE_WEBHOOK_URL+raw)))));payments.get(`payment-${orderId}`)!.refunded_money={amount:10,currency:"JPY"};assert.equal((await notify(signature)).status,200);assert.equal((await db.prepare("SELECT state FROM member_orders WHERE id=?").bind(orderId).first<any>()).state,"review");assert.equal((await notify(signature)).status,200);});
  await t.test("一般販売との競合による負在庫を確認対象として保持する",async()=>{const r=await prepare(monthly.cookie);beforePayment=async()=>{stock=0;};const response=await pay(r.id,monthly.cookie);assert.equal((await response.json() as any).state,"review");beforePayment=null;stock=4;for(let i=0;i<2;i++){const checked=await call(`/api/shop/checkouts/${r.id}`,monthly.cookie);assert.equal((await checked.json() as any).state,"review");}});
  await t.test("支払済みでも在庫反映前は確保を続け，最後の1点を再販売しない",async()=>{await db.prepare("UPDATE member_orders SET state='canceled' WHERE state='review'").run();stock=1;inventoryLag=true;const r=await prepare();const paid=await pay(r.id);assert.equal((await paid.json() as any).state,"paid");assert.equal(stock,1);const pendingStock=await(await call("/api/shop",hsap.cookie)).json() as any;assert.equal(pendingStock.products[0].available,0);assert.equal((await call("/api/shop/checkouts",hsap.cookie,purchase())).status,409);for(const sale of delayedSales.splice(0)){stock--;inventorySales.push(sale);}inventoryLag=false;await call("/api/shop",hsap.cookie);assert.equal((await db.prepare("SELECT inventory_synced FROM member_orders WHERE id=?").bind(r.id).first<any>()).inventory_synced,1);stock=4;});
  await t.test("遅れて判明した一般販売との負在庫も運営確認へ移す",async()=>{stock=1;inventoryLag=true;const r=await prepare();assert.equal((await(await pay(r.id)).json() as any).state,"paid");for(const sale of delayedSales.splice(0)){stock--;inventorySales.push(sale);}inventoryLag=false;stock--;await call("/api/shop",hsap.cookie);const row=await db.prepare("SELECT state,review_reason FROM member_orders WHERE id=?").bind(r.id).first<any>();assert.equal(row.state,"review");assert.equal(row.review_reason,"stock-conflict");stock=4;});
  await t.test("HSAP取込はまず差分だけを返し，未確認メールや別人への紐付けを保存しない", async () => {
    const body = { source: HSAP_SOURCE, rows: [{ hsapId: "HSAP-000003", displayName: "取込試験", email: "imported@example.invalid", workspaceEmail: "imported@hacksick.com", status: "承認済" }] };
    assert.equal((await call("/api/admin/imports/hsap", hsap.cookie, body)).status, 403);
    assert.equal((await call("/api/admin/imports/hsap", operator.cookie, body)).status, 200);
    assert.equal(await db.prepare("SELECT id FROM members WHERE hsap_id = 'HSAP-000003'").first(), null);
    assert.equal((await call("/api/admin/imports/hsap", operator.cookie, { ...body, confirmed: true })).status, 400);
    assert.equal((await call("/api/admin/imports/hsap", operator.cookie, { ...body, confirmed: true, emailsVerified: true })).status, 200);
    const same = await call("/api/admin/imports/hsap", operator.cookie, { ...body, confirmed: true, emailsVerified: true }); assert.equal(same.status, 200);
    const count = await db.prepare("SELECT COUNT(*) AS count FROM membership_grants WHERE evidence_id = 'hsap-master:HSAP-000003' AND revoked_at IS NULL").first<any>(); assert.equal(count.count, 1);
    const user = await login("imported@hacksick.com"); const me = await (await call("/api/me", user.cookie)).json() as any; assert.equal(me.benefit.discountPercent, 10);
    await call(`/api/admin/members/${hsapId}/status`, operator.cookie, { status: "blocked", reason: "停止の検証" });
    assert.equal((await call("/api/shop/checkouts", hsap.cookie, purchase())).status, 403);
  });
  await t.test("Workspaceだけで照合するHSAP会員は，再取り込みでテスト会員のメールを取得しない", async () => {
    const workspace = "workspace-only@hacksick.com";
    const testEmail = "separate-test@example.invalid";
    const hsapCode = "HSAP-000099";
    const create = async (email: string, hsapId?: string) => {
      const result = await call("/api/admin/members", operator.cookie, { email, hsapId, displayName: "合成会員" });
      assert.equal(result.status, 201);
      return (await result.json() as { id: string }).id;
    };
    const workspaceId = await create(workspace, hsapCode);
    const testId = await create(testEmail);
    await db.prepare("UPDATE members SET hsap_workspace_only=1 WHERE id=?").bind(workspaceId).run();
    const body = {
      source: HSAP_SOURCE,
      rows: [{ hsapId: hsapCode, displayName: "合成HSAP会員", email: testEmail, status: "承認済" }],
      confirmed: true,
      emailsVerified: true,
    };
    assert.equal((await call("/api/admin/imports/hsap", operator.cookie, body)).status, 200);
    const aliases = (await db.prepare("SELECT email,member_id FROM member_emails WHERE email IN (?,?) ORDER BY email").bind(workspace, testEmail).all()).results;
    assert.deepEqual(aliases, [{ email: testEmail, member_id: testId }, { email: workspace, member_id: workspaceId }]);
    const conflicting = { ...body, rows: [{ ...body.rows[0], workspaceEmail: "changed@hacksick.com" }] };
    assert.equal((await call("/api/admin/imports/hsap", operator.cookie, conflicting)).status, 409);
  });
  await t.test("一般ショップは非会員を通常価格で受け付け，会員用の受付と管理APIは分ける", async storefrontTest => {
    const shopOrigin = "http://localhost:8788";
    env.SHOP_BASE_URL = shopOrigin;
    env.COFFEE_RECURRING_ENABLED = "true";
    const shopCall = (path: string, cookie = "", body?: unknown, source = shopOrigin) =>
      worker.fetch(new Request(shopOrigin + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { Cookie: cookie, Origin: source, "Content-Type": "application/json", "cf-connecting-ip": "192.0.2.233" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), env);
    const publicCatalog = await (await shopCall("/api/storefront")).json() as any;
    assert.deepEqual(publicCatalog.products.map((product: any) => product.unitPriceJpy), [432, 2052, 1500]);
    assert.deepEqual(publicCatalog.plans.map((plan: any) => plan.quote.totalJpy), [11664, 8078, 3524]);
    for (const path of ["/cart", "/checkout", "/orders", "/coffee", "/login", "/products/HS-COFFEE-MOCHA-5PACK"]) {
      const page = await shopCall(path);
      assert.equal(page.status, 200);
      assert.equal(await page.text(), "asset");
    }
    assert.equal((await shopCall("/api/shop/checkouts")).status, 401);
    assert.equal((await shopCall("/api/me", operator.cookie)).status, 401);
    const email = "customer@example.invalid";
    assert.equal((await shopCall("/api/auth/email-otp/send-verification-otp", "", { email, type: "sign-in" })).status, 200);
    const signedIn = await shopCall("/api/auth/sign-in/email-otp", "", { email, otp: codes.get(email) });
    assert.equal(signedIn.status, 200, await signedIn.clone().text());
    const cookie = signedIn.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    assert.match(cookie, /hacksick-shop\.session_token/);
    assert.equal((await shopCall("/api/admin/members", cookie)).status, 404);
    assert.equal((await shopCall("/api/member-pass", cookie)).status, 404);
    assert.equal((await shopCall("/api/shop/quote", cookie, { items: single }, origin)).status, 403);
    const coffee = await (await shopCall("/api/coffee", cookie)).json() as any;
    assert.equal(coffee.eligible, false);
    assert.equal(coffee.trial.totalJpy, 1558);
    const item = { sku: skus[2], quantity: 1 };
    const mixed = await (await shopCall("/api/shop/quote", cookie, { items: [...single, item] })).json() as any;
    assert.equal(mixed.totalJpy, 2432);
    assert.equal(mixed.discountJpy, 0);
    const qualifiedQuote = memberQuote([...single, item], { eligible: true, storefront: true });
    assert.equal(qualifiedQuote.discountJpy, 43);
    assert.equal(qualifiedQuote.totalJpy, 2389);
    const prepared = await shopCall("/api/shop/checkouts", cookie, purchase());
    assert.equal(prepared.status, 200, await prepared.clone().text());
    const order = await prepared.json() as any;
    assert.equal(order.quote.totalJpy, 932);
    const paid = await shopCall(`/api/shop/checkouts/${order.id}/pay`, cookie, { sourceId: "cnon:synthetic-token", confirmedTotalJpy: 932 });
    assert.equal(paid.status, 200, await paid.clone().text());
    assert.equal((await paid.json() as any).state, "paid");
    const profile = (await (await shopCall("/api/shop", cookie)).json() as any).shippingAddress;
    assert.deepEqual(profile, { name: shipping.name, phone: "+819000000000", postalCode: "1000001", prefecture: shipping.prefecture,
      city: shipping.city, addressLine1: shipping.addressLine1, addressLine2: "" });
    await storefrontTest.test("ゲスト注文はブラウザ単位で管理し，入力したメールを会員資格や配送先の照合に使わない", async () => {
      stock = 4;
      const storefront = await shopCall("/api/shop");
      assert.equal(storefront.status, 200);
      const guestCookie = storefront.headers.getSetCookie()[0]!.split(";")[0];
      const publicShop = await storefront.json() as any;
      assert.equal(publicShop.buyerEmail, null);
      assert.equal(publicShop.shippingAddress, undefined);
      assert.equal(publicShop.eligible, false);
      assert.equal((await shopCall("/api/shop/shipping-address", guestCookie)).status, 401);
      const quote = await shopCall("/api/shop/quote", guestCookie, { items: single });
      assert.equal((await quote.json() as any).totalJpy, 932);
      assert.equal((await shopCall("/api/shop/quote", guestCookie, { items: single, couponCode: "LT-TEST" })).status, 400);
      assert.equal((await shopCall("/api/coffee/enrollments", guestCookie)).status, 401);
      const body = { ...purchase(), contactEmail: email, shipping: { ...shipping, addressLine1: "ゲストのお届け先" } };
      assert.equal((await shopCall("/api/shop/checkouts", guestCookie, body, origin)).status, 403);
      assert.equal((await shopCall("/api/shop/checkouts", guestCookie, { ...body, contactEmail: "invalid" })).status, 400);
      const prepared = await shopCall("/api/shop/checkouts", guestCookie, body);
      assert.equal(prepared.status, 200, await prepared.clone().text());
      const guestOrder = await prepared.json() as { id: string };
      const route = `/api/shop/checkouts/${guestOrder.id}`;
      const before = paymentCalls;
      const payBody = { sourceId: "cnon:synthetic-token", confirmedTotalJpy: 932 };
      const invalid = guestCookie.slice(0, -1) + (guestCookie.endsWith("0") ? "1" : "0");
      assert.equal((await shopCall(route + "/pay", invalid, payBody)).status, 401);
      assert.equal((await shopCall(route, cookie)).status, 404);
      for (let attempt = 0; attempt < 2; attempt++) {
        const paid = await shopCall(route + "/pay", guestCookie, payBody);
        assert.equal(paid.status, 200, await paid.clone().text());
        assert.equal((await paid.json() as any).state, "paid");
      }
      assert.equal(paymentCalls, before + 1);
      assert.equal(stock, 3);
      const recipient = await db.prepare("SELECT auth_user_id, recipient_json FROM member_orders WHERE id=?").bind(guestOrder.id).first<{auth_user_id:string;recipient_json:string}>();
      assert.match(recipient!.auth_user_id, /^guest-/);
      assert.equal(JSON.parse(recipient!.recipient_json).email_address, email);
      assert.deepEqual((await (await shopCall("/api/shop", cookie)).json() as any).shippingAddress, profile);
    });
  });
  await t.test("発送の登録は運営担当だけが行い，購入者本人だけが追跡番号を見られる", async () => {
    stock = 4;
    const paid = await prepare(monthly.cookie);
    assert.equal((await (await pay(paid.id, monthly.cookie)).json() as any).state, "paid");
    const path = `/api/admin/shop/checkouts/${paid.id}/shipment`;
    const shipment = { dispatched: true, trackingNumbers: "123456789012" };
    assert.equal((await call(path, monthly.cookie, shipment)).status, 403);
    const viewer = await login("viewer@example.invalid");
    await db.prepare("INSERT INTO operators VALUES (?,'viewer',?)").bind(viewer.id, new Date().toISOString()).run();
    assert.equal((await call(path, viewer.cookie, shipment)).status, 403);
    const order = orders.get(paid.id)!;
    order.fulfillments![0].state = "COMPLETED";
    assert.equal((await call(path, operator.cookie, shipment)).status, 409);
    order.fulfillments![0].state = "PROPOSED";
    assert.equal((await call(path, operator.cookie, shipment)).status, 200);
    assert.equal((await call(`/api/shop/checkouts/${paid.id}`, outsider.cookie)).status, 404);
    const receipt = await (await call(`/api/shop/checkouts/${paid.id}`, monthly.cookie)).json() as any;
    assert.deepEqual(receipt.shipment.trackingNumbers, ["123456789012"]);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM order_notifications WHERE kind='buyer-shipped'").first<any>()).n, 0);
  });
  const other = await login("second-monthly@example.invalid");
  await addMember("second-monthly@example.invalid",other.cookie,"MONTHLY");
  await t.test("限定SKUは認可後だけ表示し，資格解除後の写真取得と既存受付の決済を拒否する", async () => {
    const sku = "HS-PRIVATE-PACK";
    parents.push("square-private-item"); skus.push(sku);
    const product = { sku, squareItemId: "square-private-item", name: "限定品の合成商品", description: "限定表示テスト", unitPriceJpy: 600, bags: 1, requiredStatus: "special-sale",
      photo: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNfoAAAAASUVORK5CYII=" };
    assert.equal((await call("/api/admin/shop/product", outsider.cookie, product)).status, 403);
    assert.equal((await call("/api/admin/shop/product", operator.cookie, product)).status, 200);
    assert.equal((await call(`/api/shop/media/${sku}`)).status, 404);
    assert.equal((await call(`/api/shop/media/${sku}`, monthly.cookie)).status, 404);
    const account = await (await call("/api/me",monthly.cookie)).json() as {member:{id:string}};
    const rule = { memberId: account.member.id, status: "special-sale" };
    assert.equal((await call("/api/admin/shop/status", operator.cookie, rule)).status, 200);
    const storefront = (path: string, cookie = "", payload?: object) => worker.fetch(new Request(env.SHOP_BASE_URL! + path, {
      method: payload ? "POST" : "GET",
      headers: { Cookie: cookie, Origin: env.SHOP_BASE_URL!, "Content-Type": "application/json", "cf-connecting-ip": "192.0.2.234" },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    }), env);
    const email = "monthly@example.invalid";
    assert.equal((await storefront("/api/auth/email-otp/send-verification-otp", "", { email, type: "sign-in" })).status, 200);
    const authenticated = await storefront("/api/auth/sign-in/email-otp", "", { email, otp: codes.get(email) });
    assert.equal(authenticated.status, 200);
    const shopCookie = authenticated.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    async function showsPrivate(cookie = "") {
      const response = await storefront("/api/storefront", cookie);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const catalog = await response.json() as { products: { sku: string }[] };
      return catalog.products.some(product => product.sku === sku);
    }
    assert.equal(await showsPrivate(), false);
    assert.equal(await showsPrivate(shopCookie), true);
    const privatePhoto = await call(`/api/shop/media/${sku}`, monthly.cookie);
    assert.equal(privatePhoto.status, 200);
    assert.equal(privatePhoto.headers.get("cache-control"), "no-store");
    assert.equal(privatePhoto.headers.get("content-type"), "image/png");
    const items = [{sku,quantity:1}];
    assert.equal((await call("/api/shop/quote", monthly.cookie, {items})).status, 200);
    assert.equal((await call("/api/shop/quote", other.cookie, {items})).status, 400);
    const order = await prepare(monthly.cookie,purchase(crypto.randomUUID(),items));
    assert.equal((await call("/api/admin/shop/status", operator.cookie, {...rule,enabled:false})).status, 200);
    assert.equal(await showsPrivate(shopCookie), false);
    assert.equal((await call(`/api/shop/checkouts/${order.id}/pay`,monthly.cookie,{sourceId:"cnon:synthetic-token",confirmedTotalJpy:1040})).status,403);
    assert.equal((await call(`/api/shop/media/${sku}`, monthly.cookie)).status, 404);
    assert.equal((await call("/api/shop/checkouts", monthly.cookie, purchase(crypto.randomUUID(), items))).status, 400);
  });

  await t.test("個人コードは照合済みアドレスに限り，決済否承認は利用枠を戻し，不明決済は照合まで保持する", async () => {
    stock = 8;
    await db.prepare("UPDATE member_orders SET state='canceled' WHERE state IN ('paying','review')").run();
    const issue = await call("/api/admin/shop/coupon",operator.cookie,{template:"photographer",label:"撮影協力",code:"PHOTO-5",
      photos:1,email:"monthly@example.invalid",costConfirmed:true,skus:[single[0].sku],useLimit:1});
    assert.equal(issue.status, 200, await issue.clone().text());
    const body = {items:single,couponCode:"PHOTO-5"};
    assert.equal((await call("/api/shop/quote",other.cookie,body)).status,400);
    const shown = await (await call("/api/shop/quote",monthly.cookie,body)).json() as {totalJpy:number};
    assert.equal(shown.totalJpy,716);
    const start = () => prepare(monthly.cookie,{...purchase(),couponCode:"PHOTO-5"});
    const submit = (id:string) => call(`/api/shop/checkouts/${id}/pay`,monthly.cookie,{sourceId:"cnon:synthetic-token",confirmedTotalJpy:716});
    decline = true;
    try {
      const failed = await start();
      assert.equal((await (await submit(failed.id)).json() as any).state,"failed");
      assert.equal(await db.prepare("SELECT state FROM shop_coupon_uses WHERE order_id=?").bind(failed.id).first(),null);
    } finally { decline = false; }
    const a = await start(), b = await start();
    loseResponse = true;
    try {
      assert.equal((await submit(a.id)).status,409);
      assert.equal((await db.prepare("SELECT state FROM shop_coupon_uses WHERE order_id=?").bind(a.id).first<any>()).state,"reserved");
      assert.equal((await submit(b.id)).status,403);
    } finally { loseResponse = false; }
    const count = paymentCalls;
    assert.equal((await (await submit(a.id)).json() as any).state,"paid");
    assert.equal(paymentCalls,count);
    assert.equal((await db.prepare("SELECT * FROM shop_coupon_uses WHERE order_id=?").bind(a.id).first<any>()).state,"consumed");
  });

  await t.test("発送保留中は追跡登録せず，ESSENは許可された別ホストから担当注文だけを扱う", async () => {
    stock = 8;
    const paid = await prepare(monthly.cookie);
    assert.equal((await (await pay(paid.id,monthly.cookie)).json() as any).state,"paid");
    assert.equal((await call(`/api/admin/shop/checkouts/${paid.id}/dispatch`,operator.cookie,{plannedDate:"2026-12-10",holdReason:"確認中"})).status,200);
    const body = {dispatched:true,trackingNumbers:"123456789012"};
    assert.equal((await call(`/api/admin/shop/checkouts/${paid.id}/shipment`,operator.cookie,body)).status,409);
    const portal = "https://shipping.byessen.com";
    env.ESSEN_BASE_URL=portal;
    const partner = (path:string,cookie="",data?:unknown) => worker.fetch(new Request(portal+path,{method:data?"POST":"GET",headers:{Cookie:cookie,Origin:portal,"Content-Type":"application/json"},...(data?{body:JSON.stringify(data)}:{})}),env);
    const email = "packer@byessen.com";
    assert.equal((await partner("/api/fulfillment/orders",operator.cookie)).status,401);
    await partner("/api/auth/email-otp/send-verification-otp","",{email,type:"sign-in"});
    assert.equal(codes.has(email),false);
    assert.equal((await call("/api/admin/shop/fulfillment-staff",operator.cookie,{email})).status,200);
    await partner("/api/auth/email-otp/send-verification-otp","",{email,type:"sign-in"});
    const signedIn = await partner("/api/auth/sign-in/email-otp","",{email,otp:codes.get(email)});
    assert.equal(signedIn.status,200,await signedIn.clone().text());
    const cookie = signedIn.headers.getSetCookie().map(v=>v.split(";")[0]).join("; ");
    assert.match(cookie,/hacksick-fulfillment/);
    assert.equal((await partner(`/api/fulfillment/orders/${paid.id}/shipment`,cookie,body)).status,404);
    assert.deepEqual((await (await partner("/api/fulfillment/orders",cookie)).json() as any).orders,[]);
    // 注文作成直後と同じデータ形の，発送担当が割り当て済みの架空注文．
    await db.prepare("UPDATE member_orders SET fulfillment_source='essen' WHERE id=?").bind(paid.id).run();
    const view=(await (await partner("/api/fulfillment/orders",cookie)).json() as any).orders;
    assert.equal(view.length,1);
    assert.equal(view[0].recipient.email_address,undefined);
    assert.equal(view[0].totalJpy,undefined);
    await partner(`/api/fulfillment/orders/${paid.id}/dispatch`,cookie,{holdReason:""});
    assert.equal((await partner(`/api/fulfillment/orders/${paid.id}/shipment`,cookie,{...body,carrier:"yamato"})).status,200);
    assert.equal((await (await partner("/api/fulfillment/orders",cookie)).json() as any).orders[0].recipient,null);
    await call("/api/admin/shop/fulfillment-staff",operator.cookie,{email,enabled:false});
    assert.equal((await partner("/api/fulfillment/orders",cookie)).status,403);
    assert.equal((await partner("/api/admin/members",cookie)).status,404);
  });
});
