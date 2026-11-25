import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile,readdir} from "node:fs/promises";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";
import {createWorker} from "../src/worker.ts";
import {billCoffeeSubscriptions,nextCoffeeBillingDate,COFFEE_TERMS_VERSION,trialPricing} from "../src/coffee-recurring.ts";
import {SquareRequestError,type SquareGateway} from "../src/square.ts";
import type {Env} from "../src/types.ts";

test("翌月1日と年跨ぎを日本時間で計算し，お試しは3袋・会員割引なし",()=>{
  assert.equal(nextCoffeeBillingDate(new Date("2026-11-30T14:59:59Z")),"2026-12-01");
  assert.equal(nextCoffeeBillingDate(new Date("2026-11-30T15:00:00Z")),"2027-01-01");
  assert.equal(nextCoffeeBillingDate(new Date("2026-12-31T03:00:00Z")),"2027-01-01");
  assert.equal(trialPricing().totalJpy,1558);assert.equal(trialPricing().discountPercent,0);
});

test("Better Auth・D1・Square注文を使う定期便の申込，月次決済，資格変更，解約を検証する",async t=>{
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:"export default {fetch(){return new Response('test')}}",d1Databases:["DB"],compatibilityDate:"2026-11-03"}));t.after(()=>mf.dispose());const db=await mf.getD1Database("DB");
  for(const file of(await readdir("migrations")).filter(file=>file.endsWith(".sql")).sort()){const sql=(await readFile(`migrations/${file}`,"utf8")).replace(/^--.*$/gm,"");await db.batch(sql.split(";").map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));}
  const singles="single",packs="packs";const stock=new Map([[singles,100],[packs,20]]);const adjustments:any[]=[];
  const orders=new Map<string,any>(),payments=new Map<string,any>(),customers=new Map<string,any>(),cards=new Map<string,any>();
  const orderKeys=new Map<string,string>(),paymentKeys=new Map<string,string>(),cardKeys=new Map<string,string>();
  let customerCreates=0,paymentCreates=0,cardCreates=0,failAfterPayment=false,declineNext=false,failCardNext=false;
  const paymentRequests:any[]=[];
  const catalog=[{id:"parent-single",type:"ITEM",present_at_all_locations:true,item_data:{variations:[{id:singles,type:"ITEM_VARIATION",present_at_all_locations:true,item_variation_data:{item_id:"parent-single",sku:"HS-COFFEE-MOCHA-10G",price_money:{amount:432,currency:"JPY"},track_inventory:true}}]}},{id:"parent-packs",type:"ITEM",present_at_all_locations:true,item_data:{variations:[{id:packs,type:"ITEM_VARIATION",present_at_all_locations:true,item_variation_data:{item_id:"parent-packs",sku:"HS-COFFEE-MOCHA-5PACK",price_money:{amount:2052,currency:"JPY"},track_inventory:true}}]}}];
  const gateway:SquareGateway={
    async request<T>(path:string,method="GET",body:any):Promise<T>{
      let result:any;
      if(path==="/catalog/batch-retrieve")result={objects:catalog};
      else if(path==="/inventory/counts/batch-retrieve")result={counts:[...stock].map(([id,quantity])=>({catalog_object_id:id,location_id:"location",state:"IN_STOCK",quantity:String(quantity),calculated_at:new Date().toISOString()}))};
      else if(path==="/inventory/changes/batch-retrieve")result={changes:adjustments.map(adjustment=>({type:"ADJUSTMENT",adjustment}))};
      else if(path==="/customers"){
        assert.equal(method,"POST");let customer=customers.get(body.idempotency_key);if(!customer){customer={id:`coffee-customer-${++customerCreates}`,reference_id:body.reference_id};customers.set(body.idempotency_key,customer);}result={customer};
      }else if(path==="/orders"){
        let id=orderKeys.get(body.idempotency_key);if(!id){id=`order-${orders.size+1}`;orderKeys.set(body.idempotency_key,id);const total=body.order.line_items.reduce((n:number,line:any)=>n+line.base_price_money.amount*Number(line.quantity),0)-body.order.discounts.reduce((n:number,discount:any)=>n+discount.amount_money.amount,0)+(body.order.service_charges??[]).reduce((n:number,fee:any)=>n+fee.amount_money.amount,0);orders.set(id,{...body.order,id,state:"OPEN",total_money:{amount:total,currency:"JPY"},total_tax_money:{amount:Math.floor((total-(body.order.service_charges??[]).reduce((n:number,fee:any)=>n+fee.amount_money.amount,0))*8/108),currency:"JPY"},tenders:[]});}result={order:orders.get(id)};
      }else if(path==="/payments"){
        let id=paymentKeys.get(body.idempotency_key);
        if(!id){
          if(declineNext){declineNext=false;throw new SquareRequestError(400,["CARD_DECLINED"]);}
          id=`payment-${++paymentCreates}`;paymentKeys.set(body.idempotency_key,id);paymentRequests.push(body);
          const order=orders.get(body.order_id);assert.equal(order.customer_id,body.customer_id);assert.equal(order.total_money.amount,body.amount_money.amount);
          const payment={id,order_id:order.id,location_id:"location",status:"COMPLETED",total_money:body.amount_money,customer_id:body.customer_id};payments.set(id,payment);order.state="COMPLETED";order.tenders=[{payment_id:id}];
          for(const line of order.line_items){stock.set(line.catalog_object_id,stock.get(line.catalog_object_id)!-Number(line.quantity));adjustments.push({transaction_id:order.id,catalog_object_id:line.catalog_object_id,from_state:"IN_STOCK",to_state:"SOLD",from_location_id:"location",to_location_id:"location",quantity:line.quantity,created_at:new Date().toISOString()});}
          if(failAfterPayment){failAfterPayment=false;throw Error("Synthetic timeout after committed payment");}
        }
        result={payment:payments.get(id)};
      }else if(path==="/cards"){
        if(failCardNext){failCardNext=false;throw Error("Synthetic card storage failure");}
        let id=cardKeys.get(body.idempotency_key);if(!id){const payment=payments.get(body.source_id);if(payment)assert.equal(payment.customer_id,body.card.customer_id);id=`ccof:synthetic-card-${++cardCreates}`;cardKeys.set(body.idempotency_key,id);cards.set(id,{id,customer_id:body.card.customer_id,enabled:true,card_brand:"VISA",last_4:"1111"});}result={card:cards.get(id)};
      }else throw Error(`Unexpected Square endpoint ${path}`);
      return structuredClone(result) as T;
    },
    async getOrder(id){const value=orders.get(id);assert.ok(value);return structuredClone(value);},
    async getPayment(id){const value=payments.get(id);assert.ok(value);return structuredClone(value);},
  };
  const origin="http://localhost:8787", shopOrigin="https://shop.example.invalid";const codes=new Map<string,string>();
  const worker=createWorker(async({email,otp})=>{codes.set(email,otp);},()=>gateway);
  const env={DB:db,ASSETS:{fetch:async()=>new Response("test")},AUTH_BASE_URL:origin,BETTER_AUTH_SECRET:"coffee-test-secret-not-for-real-environments",CHECKOUT_ENABLED:"true",COFFEE_RECURRING_ENABLED:"true",SQUARE_ENVIRONMENT:"sandbox",SQUARE_ACCESS_TOKEN:"synthetic-only",SQUARE_CLIENT_ID:"shop-app",SQUARE_LOCATION_ID:"location",SQUARE_SANDBOX_ITEM_IDS:"parent-single,parent-packs",SQUARE_WEBHOOK_SIGNATURE_KEY:"synthetic",SQUARE_WEBHOOK_URL:origin+"/api/square/webhook"} as unknown as Env;
  env.SHOP_BASE_URL=shopOrigin;
  let ip=0;
  const call=(path:string,cookie="",body?:unknown,source=origin,host=origin)=>worker.fetch(new Request(host+path,{method:body===undefined?"GET":"POST",headers:{Cookie:cookie,Origin:source,"Content-Type":"application/json","cf-connecting-ip":`192.0.2.${ip}`},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);
  async function login(email:string,host=origin){ip++;assert.equal((await call("/api/auth/email-otp/send-verification-otp","",{email,type:"sign-in"},host,host)).status,200);const response=await call("/api/auth/sign-in/email-otp","",{email,otp:codes.get(email)},host,host);assert.equal(response.status,200);const data=await response.json() as any;return{cookie:response.headers.getSetCookie().map(c=>c.split(";")[0]).join("; "),id:data.user.id};}
  const buyer=await login("coffee-buyer@example.invalid"),other=await login("other-buyer@example.invalid");
  const shipping={country:"JP",name:"試験購入者",phone:"09000000000",postalCode:"1000001",prefecture:"東京都",city:"試験市",addressLine1:"試験住所"};
  const rootId=crypto.randomUUID();const input={requestId:rootId,planId:"coffee-weekend-8",shipping,termsVersion:COFFEE_TERMS_VERSION,acceptedTerms:true,acceptedCardStorage:true,basePriceExTaxJpy:1,discountPercent:100};
  let first:any;
  await t.test("未ログイン，異なるOrigin，同意不足を拒否する",async()=>{
    assert.equal((await call("/api/coffee")).status,401);
    assert.equal((await call("/api/coffee/enrollments",buyer.cookie,input,"https://invalid.example")).status,403);
    assert.equal((await call("/api/coffee/enrollments",buyer.cookie,{...input,acceptedCardStorage:false})).status,400);
    assert.equal(paymentCreates,0);assert.equal(cardCreates,0);
  });
  await t.test("税別プラン料金をサーバーで決め，非会員に資格を付与せず申込む",async()=>{
    const response=await call("/api/coffee/enrollments",buyer.cookie,input);assert.equal(response.status,200,await response.clone().text());first=await response.json();assert.equal(first.trial.totalJpy,1558);assert.equal(first.nextQuote.basePriceExTaxJpy,2800);assert.equal(first.nextQuote.totalJpy,3524);
    assert.equal((await call("/api/coffee/enrollments",buyer.cookie,input)).status,200);assert.equal((await call(`/api/coffee/enrollments/${rootId}`,other.cookie)).status,404);
    const me=await(await call("/api/me",buyer.cookie)).json() as any;assert.equal(me.benefit.eligible,false);assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM membership_grants").first<any>()).n,0);
  });
  await t.test("お試し便を一度だけ請求し，専用顧客へカードを保存して翌月課金を予約する",async()=>{
    const body={requestId:crypto.randomUUID(),sourceId:"cnon:card-nonce-ok",confirmedTotalJpy:1558};const response=await call(`/api/coffee/enrollments/${rootId}/pay`,buyer.cookie,body);assert.equal(response.status,200,await response.clone().text());const value=await response.json() as any;assert.equal(value.state,"active");assert.equal(value.card.last4,"1111");
    assert.equal(paymentCreates,1);assert.equal(customerCreates,1);assert.equal(cardCreates,1);assert.equal(stock.get(singles),97);assert.equal(paymentRequests[0].customer_details.customer_initiated,true);
    assert.equal((await call(`/api/coffee/enrollments/${rootId}/pay`,buyer.cookie,body)).status,200);assert.equal(paymentCreates,1);assert.equal(cardCreates,1);
    const trial=await db.prepare("SELECT id FROM member_orders WHERE coffee_enrollment_id=? AND coffee_cycle='trial'").bind(rootId).first<any>();assert.equal((await call(`/api/shop/checkouts/${trial.id}/pay`,buyer.cookie,{sourceId:"cnon:card-nonce-ok",confirmedTotalJpy:1558})).status,400);
  });
  await t.test("月初は同意済みの保存カードで一回だけ請求し，一般ストアと共通の在庫を減らす",async()=>{
    const clock=new Date(first.nextBillingDate+"T01:00:00+09:00");const concurrent=await Promise.all([billCoffeeSubscriptions(env,gateway,clock),billCoffeeSubscriptions(env,gateway,clock)]);assert.equal(concurrent.reduce((n,result)=>n+result.processed,0),1);assert.equal(paymentCreates,2);assert.equal(paymentRequests[1].amount_money.amount,3524);assert.equal(paymentRequests[1].source_id,[...cards.keys()][0]);assert.equal(paymentRequests[1].customer_details.customer_initiated,false);assert.equal(stock.get(singles),94);assert.equal(stock.get(packs),19);
    assert.equal((await billCoffeeSubscriptions(env,gateway,clock)).processed,0);assert.equal(paymentCreates,2);
  });
  await t.test("次の請求では会員資格を取り直して5％引きにする",async()=>{
    const member=(await db.prepare("SELECT member_id FROM coffee_enrollments WHERE id=?").bind(rootId).first<any>()).member_id;
    await db.prepare("INSERT INTO membership_grants (id,member_id,kind,valid_from,evidence_id,confirmed_by,reason,created_at) VALUES ('coffee-test-grant',?,'HSAP','2020-01-01T00:00:00Z','test',?,'test',?)").bind(member,buyer.id,new Date().toISOString()).run();
    const next=(await db.prepare("SELECT next_billing_date FROM coffee_enrollments WHERE id=?").bind(rootId).first<any>()).next_billing_date;
    assert.equal((await billCoffeeSubscriptions(env,gateway,new Date(next+"T01:00:00+09:00"))).processed,1);assert.equal(paymentRequests.at(-1).amount_money.amount,3372);assert.equal(paymentCreates,3);
  });
  await t.test("在庫不足では一円も請求せず，確認が必要な状態へ止める",async()=>{
    stock.set(singles,0);stock.set(packs,0);const next=(await db.prepare("SELECT next_billing_date FROM coffee_enrollments WHERE id=?").bind(rootId).first<any>()).next_billing_date;
    assert.equal((await billCoffeeSubscriptions(env,gateway,new Date(next+"T01:00:00+09:00"))).processed,0);assert.equal(paymentCreates,3);assert.equal((await db.prepare("SELECT state FROM coffee_enrollments WHERE id=?").bind(rootId).first<any>()).state,"action_required");
  });
  await t.test("解約は本人だけが行え，解約後に請求しない",async()=>{
    assert.equal((await call(`/api/coffee/enrollments/${rootId}/cancel`,other.cookie,{})).status,404);assert.equal((await call(`/api/coffee/enrollments/${rootId}/cancel`,buyer.cookie,{})).status,200);stock.set(singles,100);stock.set(packs,20);
    const next=(await db.prepare("SELECT next_billing_date FROM coffee_enrollments WHERE id=?").bind(rootId).first<any>()).next_billing_date;assert.equal((await billCoffeeSubscriptions(env,gateway,new Date(next+"T01:00:00+09:00"))).processed,0);assert.equal(paymentCreates,3);
  });
  await t.test("Squareで支払完了した後の通信断を照合し，二重請求せずカード登録を回復する",async()=>{
    const id=crypto.randomUUID();assert.equal((await call("/api/coffee/enrollments",other.cookie,{...input,requestId:id})).status,200);failAfterPayment=true;
    const body={requestId:crypto.randomUUID(),sourceId:"cnon:card-nonce-ok",confirmedTotalJpy:1558};assert.equal((await call(`/api/coffee/enrollments/${id}/pay`,other.cookie,body)).status,409);assert.equal(paymentCreates,4);
    const check=await call(`/api/coffee/enrollments/${id}`,other.cookie);assert.equal(check.status,200);const result=await check.json() as any;assert.equal(result.state,"active");assert.equal(result.orders[0].state,"paid");
    assert.equal((await call(`/api/coffee/enrollments/${id}/pay`,other.cookie,body)).status,200);assert.equal(paymentCreates,4);
  });
  await t.test("既存HSAPのカードIDを入力値として渡しても保存・請求しない",async()=>{
    const id=(await db.prepare("SELECT id FROM coffee_enrollments WHERE auth_user_id=? AND state='active'").bind(other.id).first<any>()).id;
    assert.equal((await call(`/api/coffee/enrollments/${id}/card`,other.cookie,{requestId:crypto.randomUUID(),acceptedCardStorage:true,sourceId:"ccof:existing-hsap-card"})).status,400);assert.equal(paymentCreates,4);
  });
  await t.test("明示的なカード否承認の後は，新しい支払操作だけを受け付け，二重請求しない",async()=>{
    const third=await login("declined-coffee@example.invalid",shopOrigin);const id=crypto.randomUUID();
    const shopCall=(path:string,body:unknown)=>call(path,third.cookie,body,shopOrigin,shopOrigin);
    assert.equal((await shopCall("/api/coffee/enrollments",{...input,requestId:id})).status,200);
    declineNext=true;const request={requestId:crypto.randomUUID(),sourceId:"cnon:card-nonce-ok",confirmedTotalJpy:1558};
    const failure=await shopCall(`/api/coffee/enrollments/${id}/pay`,request);assert.equal(failure.status,200);assert.equal((await failure.json() as any).state,"action_required");assert.equal(paymentCreates,4);
    const retry=await shopCall(`/api/coffee/enrollments/${id}/pay`,{...request,requestId:crypto.randomUUID()});assert.equal(retry.status,200,await retry.clone().text());assert.equal((await retry.json() as any).state,"active");assert.equal(paymentCreates,5);
    assert.equal((await db.prepare("SELECT order_channel FROM coffee_enrollments WHERE id=?").bind(id).first<any>()).order_channel,"shop");
    const paid=(await db.prepare("SELECT order_channel FROM member_orders WHERE coffee_enrollment_id=? AND state='paid'").bind(id).all()).results;
    assert.deepEqual(paid,[{order_channel:"shop"}]);
  });
  await t.test("支払後のカード保存失敗は，お試しを再請求せずカードだけ登録し直せる",async()=>{
    const buyer=await login("card-store-coffee@example.invalid"),id=crypto.randomUUID();
    assert.equal((await call("/api/coffee/enrollments",buyer.cookie,{...input,requestId:id})).status,200);failCardNext=true;
    const result=await call(`/api/coffee/enrollments/${id}/pay`,buyer.cookie,{requestId:crypto.randomUUID(),sourceId:"cnon:card-nonce-ok",confirmedTotalJpy:1558});
    assert.equal(result.status,200);const root=await result.json() as any;assert.equal(root.state,"card_required");assert.equal(root.orders[0].state,"paid");assert.equal(paymentCreates,6);
    const stored=await call(`/api/coffee/enrollments/${id}/card`,buyer.cookie,{requestId:crypto.randomUUID(),sourceId:"cnon:store-only",acceptedCardStorage:true});
    assert.equal(stored.status,200);assert.equal((await stored.json() as any).state,"active");assert.equal(paymentCreates,6);
    const cardCount=cardCreates;await db.prepare("UPDATE coffee_enrollments SET state='review' WHERE id=?").bind(id).run();
    assert.equal((await(await call(`/api/coffee/enrollments/${id}`,buyer.cookie)).json() as any).state,"review");
    assert.equal(cardCreates,cardCount); // 古いお試し決済からカードを自動で復元しない．
  });
  await t.test("月をまたいだ申込は，通常便の初回決済日を再確認するまで初回も請求しない",async()=>{
    const buyer=await login("month-boundary-coffee@example.invalid"),id=crypto.randomUUID();
    assert.equal((await call("/api/coffee/enrollments",buyer.cookie,{...input,requestId:id})).status,200);
    await db.prepare("UPDATE coffee_enrollments SET next_billing_date='2020-01-01' WHERE id=?").bind(id).run();
    const result=await call(`/api/coffee/enrollments/${id}/pay`,buyer.cookie,{requestId:crypto.randomUUID(),sourceId:"cnon:card-nonce-ok",confirmedTotalJpy:1558});
    assert.equal(result.status,409);assert.equal(paymentCreates,6);
    assert.equal((await db.prepare("SELECT next_billing_date FROM coffee_enrollments WHERE id=?").bind(id).first<any>()).next_billing_date,nextCoffeeBillingDate());
  });

});
