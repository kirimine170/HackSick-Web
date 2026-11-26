// Sandboxの架空商品・購入者・テストカードだけを使う．本番キー・実メール・実カードは使わない．
import assert from 'node:assert/strict';
import {readFile,readdir,writeFile,mkdir} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {squareGateway} from '../src/square.ts';
import {sharedInventory} from '../src/shared-checkout.ts';
import {prepareCoffeeEnrollment,payCoffeeEnrollment,billCoffeeSubscriptions,cancelCoffeeEnrollment,COFFEE_TERMS_VERSION} from '../src/coffee-recurring.ts';
const secrets=JSON.parse(await readFile('.credentials/production-secrets.json','utf8'));
const token=secrets.SQUARE_SANDBOX_ACCESS_TOKEN;
if(!token||!secrets.SQUARE_SANDBOX_APPLICATION_ID)throw Error('Dedicated Sandbox credentials are required');
async function api(path,body){const r=await fetch('https://connect.squareupsandbox.com/v2'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Square-Version':'2026-09-16','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const value=await r.json();if(!r.ok)throw Error('Sandbox '+r.status+': '+(value.errors??[]).map(e=>e.code).join(','));return value;}
const {locations}=await api('/locations');const location=locations.find(location=>location.currency==='JPY'&&location.country==='JP'&&location.status==='ACTIVE');assert.ok(location);
const prefix='coffee-sandbox-'+crypto.randomUUID();
const catalog=await api('/catalog/batch-upsert',{idempotency_key:crypto.randomUUID(),batches:[{objects:[0,1].map(i=>({type:'ITEM',id:'#'+prefix+'-item-'+i,present_at_all_locations:true,item_data:{name:'珈琲定期便の合成試験 '+(i?'5袋':'単品'),variations:[{type:'ITEM_VARIATION',id:'#'+prefix+'-variation-'+i,present_at_all_locations:true,item_variation_data:{item_id:'#'+prefix+'-item-'+i,name:'Regular',sku:i?'HS-COFFEE-MOCHA-5PACK':'HS-COFFEE-MOCHA-10G',pricing_type:'FIXED_PRICING',price_money:{amount:i?2052:432,currency:'JPY'},track_inventory:true,sellable:true,stockable:true}}]}}))}]});
const itemIds=[0,1].map(i=>catalog.id_mappings.find(m=>m.client_object_id==='#'+prefix+'-item-'+i).object_id);
const variationIds=[0,1].map(i=>catalog.id_mappings.find(m=>m.client_object_id==='#'+prefix+'-variation-'+i).object_id);
await api('/inventory/changes/batch-create',{idempotency_key:crypto.randomUUID(),changes:variationIds.map((id,i)=>({type:'PHYSICAL_COUNT',physical_count:{catalog_object_id:id,location_id:location.id,state:'IN_STOCK',quantity:i?'20':'100',occurred_at:new Date().toISOString()}}))});
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:"export default {fetch(){return new Response('test')}}",d1Databases:['DB'],compatibilityDate:'2026-11-03'}));
try{
 const db=await mf.getD1Database('DB');
 for(const file of(await readdir('migrations')).filter(file=>file.endsWith('.sql')).sort()){const sql=(await readFile('migrations/'+file,'utf8')).replace(/^--.*$/gm,'');await db.batch(sql.split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));}
 const stamp=new Date().toISOString();const user={id:'coffee-sandbox-'+crypto.randomUUID(),email:'coffee-sandbox@example.invalid',name:'合成試験購入者'};
 await db.prepare('INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,?,?)').bind(user.id,user.name,user.email,stamp,stamp).run();
 const origin='http://localhost:8787';const env={DB:db,AUTH_BASE_URL:origin,BETTER_AUTH_SECRET:'local-test-only',CHECKOUT_ENABLED:'true',COFFEE_RECURRING_ENABLED:'true',SQUARE_ENVIRONMENT:'sandbox',SQUARE_ACCESS_TOKEN:token,SQUARE_CLIENT_ID:secrets.SQUARE_SANDBOX_APPLICATION_ID,SQUARE_LOCATION_ID:location.id,SQUARE_SANDBOX_ITEM_IDS:itemIds.join(','),SQUARE_WEBHOOK_SIGNATURE_KEY:'synthetic',SQUARE_WEBHOOK_URL:origin+'/api/square/webhook'};
 const gateway=squareGateway(env);const enrollmentId=crypto.randomUUID();const reports=[];
 await mkdir('.local-test',{recursive:true});
 const checkpoint=async()=>{const records=(await db.prepare('SELECT id,state,square_order_id,square_payment_id,coffee_cycle,quote_json FROM member_orders').all()).results;await writeFile('.local-test/coffee-sandbox-current.json',JSON.stringify({sandboxOnly:true,locationId:location.id,itemIds,variationIds,enrollmentId,reports,records},null,2),{mode:0o600});};
 const prepared=await prepareCoffeeEnrollment(env,user,{requestId:enrollmentId,planId:'coffee-weekend-8',termsVersion:COFFEE_TERMS_VERSION,acceptedTerms:true,acceptedCardStorage:true,shipping:{country:'JP',name:'Sandbox合成試験',phone:'09012345678',postalCode:'1000001',prefecture:'東京都',city:'試験用',addressLine1:'試験住所'}},gateway);
 assert.equal(prepared.trial.totalJpy,1558);await checkpoint();
 const paymentRequest={requestId:crypto.randomUUID(),sourceId:'cnon:card-nonce-ok',confirmedTotalJpy:1558};
 const activation=await payCoffeeEnrollment(env,user,enrollmentId,paymentRequest,gateway);const active=await activation.json();await checkpoint();assert.equal(activation.status,200,JSON.stringify(active));assert.equal(active.state,'active',JSON.stringify(active));assert.ok(active.card.last4);
 reports.push({phase:'trial',amountJpy:1558,state:active.orders[0].state,cardStored:true,nextBillingDate:active.nextBillingDate});
 assert.equal((await payCoffeeEnrollment(env,user,enrollmentId,paymentRequest,gateway)).status,200);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM member_orders').first()).n,1);
 const next=(await db.prepare('SELECT next_billing_date FROM coffee_enrollments WHERE id=?').bind(enrollmentId).first()).next_billing_date;
 let result=await billCoffeeSubscriptions(env,gateway,new Date(next+'T01:00:00+09:00'));await checkpoint();assert.equal(result.processed,1,JSON.stringify(result));
 assert.equal((await billCoffeeSubscriptions(env,gateway,new Date(next+'T01:00:00+09:00'))).processed,0);
 reports.push({phase:'regular-nonmember',amountJpy:3524,state:'paid',duplicateBillingProcessed:0});
 const root=await db.prepare('SELECT * FROM coffee_enrollments WHERE id=?').bind(enrollmentId).first();
 await db.prepare("INSERT INTO membership_grants (id,member_id,kind,valid_from,evidence_id,confirmed_by,reason,created_at) VALUES ('sandbox-coffee-member',?,'HSAP','2020-01-01T00:00:00Z','synthetic',?,'Sandbox only',?)").bind(root.member_id,user.id,stamp).run();
 result=await billCoffeeSubscriptions(env,gateway,new Date(root.next_billing_date+'T01:00:00+09:00'));await checkpoint();assert.equal(result.processed,1);
 reports.push({phase:'regular-member',amountJpy:3372,state:'paid'});
 let inventory=await sharedInventory(env,gateway);
 for(let attempt=0;attempt<15&&inventory.some(product=>product.rawAvailable!==(product.sku.endsWith('5PACK')?18:91));attempt++){await new Promise(resolve=>setTimeout(resolve,1000));inventory=await sharedInventory(env,gateway);}
 assert.equal(inventory.find(product=>product.sku.endsWith('5PACK')).rawAvailable,18);assert.equal(inventory.find(product=>product.sku.endsWith('10G')).rawAvailable,91);
 const records=(await db.prepare('SELECT * FROM member_orders ORDER BY created_at').all()).results;assert.equal(records.length,3);
 for(const record of records){const order=await gateway.getOrder(record.square_order_id);assert.equal(order.tenders.filter(t=>t.payment_id).length,1);assert.equal(order.total_money.amount,JSON.parse(record.quote_json).totalJpy);const {order:full}=await api('/orders/'+record.square_order_id);assert.equal(full.total_tax_money?.amount,JSON.parse(record.quote_json).taxJpy);reports.push({phase:'order-verification',cycle:record.coffee_cycle,amountJpy:full.total_money.amount,taxJpy:full.total_tax_money?.amount,paymentCount:full.tenders.length});}
 await cancelCoffeeEnrollment(env,user.id,enrollmentId,gateway);const after=await db.prepare('SELECT next_billing_date FROM coffee_enrollments WHERE id=?').bind(enrollmentId).first();assert.equal((await billCoffeeSubscriptions(env,gateway,new Date(after.next_billing_date+'T01:00:00+09:00'))).processed,0);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM coffee_notices').first()).n,0);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM order_notifications').first()).n,0);
 await checkpoint();await writeFile('.local-test/coffee-sandbox-result.json',JSON.stringify({verifiedAt:new Date().toISOString(),sandboxOnly:true,reports,stock:inventory.map(p=>({sku:p.sku,available:p.rawAvailable})),canceled:true,realEmailsSent:false},null,2),{mode:0o600});
 console.log(JSON.stringify({sandboxOnly:true,reports,canceled:true,realEmailsSent:false},null,2));
}finally{await mf.dispose();}
