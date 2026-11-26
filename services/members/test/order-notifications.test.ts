import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile,readdir} from "node:fs/promises";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";
import {queueOrderNotifications,deliverOrderNotifications} from "../src/order-notifications.ts";
import {recordShipment} from "../src/order-shipment.ts";
import {memberQuote,shippingRecipient} from "../src/checkout.ts";
import type {SharedOrder} from "../src/shared-checkout.ts";
import type {Env} from "../src/types.ts";

test("注文通知を重複送信せず，Sandbox・確認待ちの購入者へ支払完了メールを送らない",async t=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:"export default{fetch(){return new Response('test')}}",d1Databases:["DB"],compatibilityDate:"2026-11-03"}));t.after(()=>mf.dispose());const db=await mf.getD1Database("DB");
 for(const file of(await readdir("migrations")).filter(f=>f.endsWith(".sql")).sort()){const sql=(await readFile(`migrations/${file}`,"utf8")).replace(/^--.*$/gm,"");await db.batch(sql.split(";").map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));}
 const time=new Date().toISOString();await db.prepare('INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,?,?)').bind("user","合成会員","buyer@example.invalid",time,time).run();await db.prepare("INSERT INTO members (id,display_name,claim_email,auth_user_id,status,created_at,updated_at) VALUES ('member','合成会員','buyer@example.invalid','user','active',?,?)").bind(time,time).run();
 const quote=memberQuote([{sku:"HS-COFFEE-MOCHA-10G",quantity:1}]);const recipient=shippingRecipient({country:"JP",name:"合成受取人",phone:"09000000000",postalCode:"1000001",prefecture:"東京都",city:"試験市",addressLine1:"個人住所は運営メールに含めない"},"buyer@example.invalid");
 const order={id:"order",state:"paid",quote_json:JSON.stringify(quote),recipient_json:JSON.stringify(recipient),square_order_id:"square-order"};
 await db.prepare("INSERT INTO member_orders (id,auth_user_id,member_id,fingerprint,quote_json,recipient_json,catalog_json,state,square_order_id,created_at,expires_at,updated_at) VALUES ('order','user','member','test',?,?,'[]','paid','square-order',?,?,?)").bind(order.quote_json,order.recipient_json,time,time,time).run();
 const env={DB:db,SQUARE_ENVIRONMENT:"production",RESEND_API_KEY:"synthetic-test-key",MAIL_FROM:"test@example.invalid",ORDER_NOTIFICATION_EMAIL:"operator@example.invalid"} as Env;const sent:{to:string[];text:string}[]=[];
 const transport=(async(_url:unknown,init:RequestInit)=>{sent.push(JSON.parse(String(init.body)));return Response.json({id:`message-${sent.length}`});}) as typeof fetch;
 await queueOrderNotifications(env,order);await queueOrderNotifications(env,order);assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM order_notifications").first<any>()).n,2);
 await db.prepare("UPDATE order_notifications SET next_attempt_at='1970-01-01'").run();await deliverOrderNotifications(env,transport);await deliverOrderNotifications(env,transport);assert.equal(sent.length,2);assert.ok(sent.find(m=>m.to[0]==="buyer@example.invalid")!.text.includes("889円"));assert.ok(!sent.find(m=>m.to[0]==="operator@example.invalid")!.text.includes("個人住所"));
 env.SQUARE_ENVIRONMENT="sandbox";await queueOrderNotifications(env,{...order,id:"sandbox-order"});await deliverOrderNotifications(env,transport);assert.equal(sent.length,2);
 env.SQUARE_ENVIRONMENT="production";await db.prepare("UPDATE member_orders SET state='review' WHERE id='order'").run();await db.prepare("UPDATE order_notifications SET state='pending',next_attempt_at='1970-01-01'").run();await deliverOrderNotifications(env,transport);assert.equal(sent.length,2);
 await queueOrderNotifications(env,{...order,state:"review"});await db.prepare("UPDATE order_notifications SET next_attempt_at='1970-01-01' WHERE state='pending'").run();await deliverOrderNotifications(env,transport);assert.equal(sent.length,3);assert.equal(sent[2].to[0],"operator@example.invalid");

 await db.prepare("UPDATE member_orders SET state='paid' WHERE id='order'").run();
 const paid = (await db.prepare("SELECT * FROM member_orders WHERE id='order'").first<SharedOrder>())!;
 env.SQUARE_LOCATION_ID = "shipping-test";
 const gateway = {
   async getOrder() {
     return { id: "square-order", reference_id: "order", location_id: "shipping-test", state: "OPEN", total_money: { currency: "JPY", amount: 889 },
       fulfillments: [{ type: "SHIPMENT", state: "PROPOSED", shipment_details: { recipient: { address: { country: "JP" } } } }], tenders: [{ payment_id: "square-payment" }] };
   },
   async getPayment() {
     return { id: "square-payment", order_id: "square-order", location_id: "shipping-test", status: "COMPLETED", total_money: { currency: "JPY", amount: 889 } };
   },
 };
 const shipping = { dispatched: true, trackingNumbers: "1234-5678-9012\n987654321098" };
 await assert.rejects(() => recordShipment(env, paid, "user", { ...shipping, dispatched: false }, gateway), /引き渡し/);
 const [firstShipment, duplicate] = await Promise.all([
   recordShipment(env, paid, "user", shipping, gateway), recordShipment(env, paid, "user", shipping, gateway),
 ]);
 assert.deepEqual(firstShipment, duplicate);
 assert.deepEqual(firstShipment.trackingNumbers, ["123456789012", "987654321098"]);
 await assert.rejects(() => recordShipment(env, paid, "user", { ...shipping, trackingNumbers: "111122223333" }, gateway), /記録済み/);
 assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM order_notifications WHERE kind='buyer-shipped'").first<any>()).n, 1);
 await db.prepare("UPDATE order_notifications SET next_attempt_at='1970-01-01' WHERE kind='buyer-shipped'").run();
 const attempts: { key: string | null; body: string }[] = [];
 const retryTransport = (async (_url: unknown, init: RequestInit) => {
   attempts.push({ key: new Headers(init.headers).get("Idempotency-Key"), body: String(init.body) });
   return attempts.length === 1 ? new Response(null, { status: 429 }) : Response.json({ id: "shipment-message" });
 }) as typeof fetch;
 await deliverOrderNotifications(env, retryTransport);
 await db.prepare("UPDATE order_notifications SET next_attempt_at='1970-01-01' WHERE kind='buyer-shipped'").run();
 await deliverOrderNotifications(env, retryTransport);
 await deliverOrderNotifications(env, retryTransport);
 assert.equal(attempts.length, 2);
 assert.deepEqual(attempts[0], attempts[1]);
 const mail = JSON.parse(attempts[0].body);
 assert.deepEqual(mail.to, ["buyer@example.invalid"]);
 assert.equal(mail.reply_to, "shop@hacksick.com");
 assert.match(mail.subject, /発送しました/);
 assert.match(mail.text, /123456789012[\s\S]*987654321098/);
 assert.match(mail.text, /trackings\.post\.japanpost\.jp/);
 assert.doesNotMatch(mail.text, /個人住所/);
 assert.equal((await db.prepare("SELECT state FROM order_notifications WHERE kind='buyer-shipped'").first<any>()).state, "sent");
});
