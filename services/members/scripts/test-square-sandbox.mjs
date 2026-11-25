// 専用アプリのSandboxだけで実API決済と在庫減算を検証する．本番トークンは使用しない．
import assert from "node:assert/strict";
import { readFile,readdir,mkdir,writeFile } from "node:fs/promises";
import { Miniflare,convertV4MiniflareOptions } from "miniflare";
import { squareGateway } from "../src/square.ts";
import { prepareSharedOrder,paySharedOrder,sharedInventory } from "../src/shared-checkout.ts";
const secrets=JSON.parse(await readFile(".credentials/production-secrets.json","utf8"));
const token=secrets.SQUARE_SANDBOX_ACCESS_TOKEN;
const storefront = process.argv.includes("--storefront");
if(!token)throw new Error("Sandbox token has not been configured");
async function api(path,body){
  const response=await fetch(`https://connect.squareupsandbox.com/v2${path}`,{method:body?"POST":"GET",headers:{Authorization:`Bearer ${token}`,"Square-Version":"2026-09-16","Content-Type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});
  const result=await response.json();if(!response.ok)throw new Error(`Sandbox ${response.status}: ${(result.errors??[]).map(e=>e.code).join(",")}`);return result;
}
const {locations}=await api("/locations");
const location=locations.find(l=>l.id===secrets.SQUARE_SANDBOX_LOCATION_ID)??locations.find(l=>l.currency==="JPY"&&l.country==="JP"&&l.status==="ACTIVE");
assert.ok(location&&location.currency==="JPY"&&location.country==="JP","日本のSandbox店舗を選択してください");
const prefix=`members-test-${crypto.randomUUID()}`;
const skus=["HS-COFFEE-MOCHA-10G","HS-COFFEE-MOCHA-5PACK"];
if (storefront) skus.push("HS-BOOK-ANOKOTO-A5");
const prices = [432, 2052, 1500];
const names = ["単品", "5袋", "書籍"];
const catalog=await api("/catalog/batch-upsert",{idempotency_key:crypto.randomUUID(),batches:[{objects:skus.map((sku,i)=>({
  id:`#${prefix}-${i}`,type:"ITEM",present_at_all_locations:true,item_data:{name:`HackSickショップ合成試験 ${names[i]}`,variations:[{
    id:`#${prefix}-variation-${i}`,type:"ITEM_VARIATION",present_at_all_locations:true,item_variation_data:{item_id:`#${prefix}-${i}`,name:"Regular",sku,pricing_type:"FIXED_PRICING",price_money:{amount:prices[i],currency:"JPY"},track_inventory:true,sellable:true,stockable:true},
  }]},
}))}]});
const items=skus.map((_,i)=>catalog.id_mappings.find(m=>m.client_object_id===`#${prefix}-${i}`).object_id);
const variations=skus.map((_,i)=>catalog.id_mappings.find(m=>m.client_object_id===`#${prefix}-variation-${i}`).object_id);
await api("/inventory/changes/batch-create",{idempotency_key:crypto.randomUUID(),changes:variations.map(id=>({type:"PHYSICAL_COUNT",physical_count:{catalog_object_id:id,location_id:location.id,state:"IN_STOCK",quantity:"10",occurred_at:new Date().toISOString()}}))});
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:"export default {fetch(){return new Response('sandbox')}}",d1Databases:["DB"],compatibilityDate:"2026-11-03"}));
try{
  const db=await mf.getD1Database("DB");
  for(const file of(await readdir("migrations")).filter(f=>f.endsWith(".sql")).sort()){const sql=(await readFile(`migrations/${file}`,"utf8")).replace(/^--.*$/gm,"");await db.batch(sql.split(";").map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));}
  const time=new Date().toISOString();
  await db.prepare('INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,?,?)').bind("sandbox-user","合成試験","sandbox@example.invalid",time,time).run();
  await db.prepare("INSERT INTO members (id,display_name,claim_email,auth_user_id,status,created_at,updated_at) VALUES ('sandbox-member','合成試験','sandbox@example.invalid','sandbox-user','active',?,?)").bind(time,time).run();
  if (!storefront) await db.prepare("INSERT INTO membership_grants (id,member_id,kind,valid_from,evidence_id,confirmed_by,reason,created_at) VALUES ('sandbox-grant','sandbox-member','HSAP',?,'synthetic','sandbox-user','Sandbox合成試験',?)").bind(time,time).run();
  const env={DB:db,AUTH_BASE_URL:"http://localhost:8787",CHECKOUT_ENABLED:"true",SQUARE_ENVIRONMENT:"sandbox",SQUARE_ACCESS_TOKEN:token,SQUARE_CLIENT_ID:secrets.SQUARE_SANDBOX_APPLICATION_ID,SQUARE_LOCATION_ID:location.id,SQUARE_SANDBOX_ITEM_IDS:items.join(","),SQUARE_WEBHOOK_SIGNATURE_KEY:"synthetic-test-key",SQUARE_WEBHOOK_URL:"http://localhost:8787/api/square/webhook"};
  const gateway=squareGateway(env);const reports=[];const orderRecords=[];
  await mkdir(".local-test",{recursive:true});
  const reportFile = storefront ? "storefront-sandbox" : "sandbox";
  const checkpoint=()=>writeFile(`.local-test/${reportFile}-current-run.json`,JSON.stringify({applicationId:secrets.SQUARE_SANDBOX_APPLICATION_ID,locationId:location.id,itemIds:items,variationIds:variations,orders:orderRecords,reports},null,2),{mode:0o600});await checkpoint();
  for(const sku of skus){
    const key=crypto.randomUUID();const before=await sharedInventory(env,gateway,"",storefront);
    const response=await prepareSharedOrder(env,{id:"sandbox-user",email:"sandbox@example.invalid"},{requestId:key,items:[{sku,quantity:1}],acceptedTerms:true,shipping:{country:"JP",name:"Sandbox試験用",phone:"09000000000",postalCode:"1000001",prefecture:"東京都",city:"試験用",addressLine1:"試験用住所"}},gateway,storefront);
    assert.equal(response.status,200);const order=await response.json();assert.equal(order.state,"ready");
    const pay=await paySharedOrder(env,"sandbox-user",key,{sourceId:"cnon:card-nonce-ok",confirmedTotalJpy:order.quote.totalJpy},gateway,undefined,storefront);
    const paid=await pay.json();orderRecords.push(await db.prepare("SELECT id,square_order_id,square_payment_id,state FROM member_orders WHERE id=?").bind(key).first());await checkpoint();assert.equal(pay.status,200,JSON.stringify(paid));assert.equal(paid.state,"paid",JSON.stringify(paid));
    const retry=await(await paySharedOrder(env,"sandbox-user",key,{sourceId:"cnon:card-nonce-ok",confirmedTotalJpy:order.quote.totalJpy},gateway,undefined,storefront)).json();assert.equal(retry.state,"paid");
    let after=await sharedInventory(env,gateway,"",storefront);const expected=before.find(p=>p.sku===sku).rawAvailable-1;
    assert.ok(after.find(p=>p.sku===sku).available<=expected,"反映前の在庫を再販売しない");
    for(let attempt=0;attempt<12&&after.find(p=>p.sku===sku).rawAvailable!==expected;attempt++){await new Promise(resolve=>setTimeout(resolve,1000));after=await sharedInventory(env,gateway,"",storefront);}
    assert.equal(after.find(p=>p.sku===sku).rawAvailable,expected);
    const ack=await db.prepare("SELECT inventory_synced FROM member_orders WHERE id=?").bind(key).first();assert.equal(ack.inventory_synced,1,"Squareの売却記録と集計済み在庫を照合する");
    const latestOrder=await gateway.getOrder(orderRecords.at(-1).square_order_id);assert.equal(latestOrder.tenders.filter(t=>t.payment_id).length,1);
    reports.push({sku,totalJpy:order.quote.totalJpy,state:paid.state,stockBefore:before.find(p=>p.sku===sku).rawAvailable,stockAfter:after.find(p=>p.sku===sku).rawAvailable,duplicateRetry:retry.state,paymentCount:latestOrder.tenders.filter(t=>t.payment_id).length});await checkpoint();
  }
  await writeFile(`.local-test/${reportFile}-result.json`,JSON.stringify({applicationId:secrets.SQUARE_SANDBOX_APPLICATION_ID,locationId:location.id,itemIds:items,reports},null,2),{mode:0o600});
  console.log(JSON.stringify({sandboxOnly:true,locationCurrency:location.currency,reports},null,2));
}finally{await mf.dispose();}
