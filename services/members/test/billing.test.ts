import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { nextMonthlyAnchor, syncMonthlySubscriptions } from "../src/billing.ts";
import { eligibility } from "../src/eligibility.ts";
import type { SquareGateway } from "../src/square.ts";
import type { Env, Grant } from "../src/types.ts";

test("31日締めと初回の端数期間を，日本時間の月境界で扱う",()=>{
  assert.equal(nextMonthlyAnchor("2026-10-31",31),"2026-11-30");
  assert.equal(nextMonthlyAnchor("2026-07-26",31),"2026-07-31");
  assert.equal(nextMonthlyAnchor("2027-01-31",31),"2027-02-28");
  assert.equal(nextMonthlyAnchor("2028-01-31",31),"2028-02-29");
});
test("Squareの支払証明から月額会員を取り込み，未払・返金で自動資格を失効する",async t=>{
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:"export default {fetch(){return new Response('test')}}",d1Databases:["DB"],compatibilityDate:"2026-11-03"}));t.after(()=>mf.dispose());const db=await mf.getD1Database("DB");
  for(const file of (await readdir("migrations")).filter(f=>f.endsWith(".sql")).sort()){const sql=(await readFile(`migrations/${file}`,"utf8")).replace(/^--.*$/gm,"");await db.batch(sql.split(";").map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));}
  const time=new Date().toISOString();await db.prepare('INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,?,?)').bind("operator","Test operator","operator@example.invalid",time,time).run();
  await db.prepare("INSERT INTO operators VALUES ('operator','manager',?)").bind(time).run();
  await db.prepare("INSERT INTO square_connections (environment,merchant_id,client_id,encrypted_tokens,access_expires_at,refreshed_at,connected_by) VALUES ('sandbox','merchant','app','unused',?,?, 'operator')").bind(new Date(Date.now()+3600000).toISOString(),time).run();
  const day=new Date(Date.now()+9*3600000).toISOString().slice(0,7)+"-01";const end=nextMonthlyAnchor(day,1);
  let refunded=false,invoiceStatus="PAID",subscriptionStatus="ACTIVE";
  const gateway={async request<T>(path:string):Promise<T>{let result:any;
    if(path==="/subscriptions/search")result={subscriptions:[{id:"sub",location_id:"location",customer_id:"customer",plan_variation_id:"monthly-plan",status:subscriptionStatus,start_date:day,charged_through_date:end,timezone:"Asia/Tokyo",invoice_ids:["invoice"]},{id:"test-sub",location_id:"location",plan_variation_id:"excluded-test-plan"}]};
    else if(path==="/catalog/object/monthly-plan")result={object:{subscription_plan_variation_data:{monthly_billing_anchor_date:1,phases:[{cadence:"MONTHLY"}]}}};
    else if(path==="/customers/customer")result={customer:{id:"customer",email_address:"member@example.invalid",given_name:"Synthetic member"}};
    else if(path==="/invoices/invoice")result={invoice:{id:"invoice",status:invoiceStatus,location_id:"location",order_id:"order",primary_recipient:{customer_id:"customer"},payment_requests:[{due_date:day,computed_amount_money:{amount:1500,currency:"JPY"},total_completed_amount_money:{amount:1500,currency:"JPY"}}]}};
    else throw new Error("Unexpected API");return result as T;
  },async getOrder(){return{id:"order",location_id:"location",state:"COMPLETED",total_money:{amount:1500,currency:"JPY"},tenders:[{payment_id:"payment"}]}},async getPayment(){return{id:"payment",order_id:"order",location_id:"location",status:"COMPLETED",total_money:{amount:1500,currency:"JPY"},...(refunded?{refunded_money:{amount:1500,currency:"JPY"}}:{})}}} as unknown as SquareGateway;
  const env={DB:db,SQUARE_ENVIRONMENT:"sandbox",SQUARE_CLIENT_ID:"app",SQUARE_LOCATION_ID:"location",SQUARE_MONTHLY_PLAN_IDS:"monthly-plan"} as Env;
  const result=await syncMonthlySubscriptions(env,gateway,true);assert.equal(result.length,1);assert.equal(result[0].eligible,true);
  const memberId=result[0].memberId;const benefit=async()=>eligibility("active",(await db.prepare("SELECT * FROM membership_grants WHERE member_id=?").bind(memberId).all<Grant>()).results);
  assert.equal((await benefit()).discountPercent,10);await syncMonthlySubscriptions(env,gateway,true);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM members").first<any>()).n,1);assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM membership_grants").first<any>()).n,1);
  refunded=true;await syncMonthlySubscriptions(env,gateway,true);assert.equal((await benefit()).eligible,false);
  refunded=false;invoiceStatus="UNPAID";await syncMonthlySubscriptions(env,gateway,true);assert.equal((await benefit()).eligible,false);
  invoiceStatus="PAID";subscriptionStatus="PAUSED";await syncMonthlySubscriptions(env,gateway,true);assert.equal((await benefit()).eligible,false);
  subscriptionStatus="ACTIVE";await syncMonthlySubscriptions(env,gateway,true);assert.equal((await benefit()).eligible,true);
  await db.prepare("UPDATE membership_grants SET revoked_at=?,revocation_source='operator' WHERE member_id=?").bind(new Date().toISOString(),memberId).run();
  await syncMonthlySubscriptions(env,gateway,true);assert.equal((await benefit()).eligible,false,"運営による取消を自動同期で戻さない");
});
