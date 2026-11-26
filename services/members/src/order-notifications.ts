import type { Env } from "./types.ts";
import { carrierDetails, type ShipmentRecord } from "./order-shipment.ts";
interface Order {id:string;state:string;quote_json:string;recipient_json:string;square_order_id:string|null;order_channel?:string}
interface Notice {id:string;order_id:string;kind:"buyer-paid"|"operator-paid"|"operator-review"|"buyer-shipped";attempts:number;created_at:string}
export async function queueOrderNotifications(env:Env,order:Order){
  if(env.SQUARE_ENVIRONMENT!=="production")return;
  const kinds=order.state==="paid"?["buyer-paid","operator-paid"]:order.state==="review"?["operator-review"]:[];
  const time=new Date().toISOString();const deliveryTime=new Date(Date.now()+90000).toISOString();
  for(const kind of kinds)await env.DB.prepare(`INSERT INTO order_notifications (id,order_id,kind,state,next_attempt_at,created_at,updated_at) VALUES (?,?,?,'pending',?,?,?)
    ON CONFLICT(order_id,kind) DO UPDATE SET state=CASE WHEN order_notifications.state='canceled' THEN 'pending' ELSE order_notifications.state END`)
    .bind(`${order.id}:${kind}`,order.id,kind,deliveryTime,time,time).run();
}
/** 購入者の注文を契機とする取引メールだけを送信する．Sandboxでは送信しない． */
export async function deliverOrderNotifications(env:Env,transport:typeof fetch=fetch){
  if(env.SQUARE_ENVIRONMENT!=="production"||!env.RESEND_API_KEY)return;
  const time=new Date().toISOString();
  const pending=(await env.DB.prepare("SELECT id,order_id,kind,attempts,created_at FROM order_notifications WHERE state IN ('pending','sending') AND next_attempt_at<=? ORDER BY created_at LIMIT 10").bind(time).all<Notice>()).results;
  for(const notice of pending){
    // Resendが同じ送信を重複として扱う期間内にだけ再試行する．
    if (notice.attempts > 0 && Date.now() - Date.parse(notice.created_at) >= 23 * 3600000) {
      await env.DB.prepare("UPDATE order_notifications SET state='failed',updated_at=? WHERE id=? AND state IN ('pending','sending') AND next_attempt_at<=?")
        .bind(time, notice.id, time).run();
      continue;
    }
    const claimed=await env.DB.prepare("UPDATE order_notifications SET state='sending',attempts=attempts+1,next_attempt_at=?,updated_at=? WHERE id=? AND state IN ('pending','sending') AND next_attempt_at<=?").bind(new Date(Date.now()+120000).toISOString(),time,notice.id,time).run();
    if(!claimed.meta.changes)continue;
    const order=await env.DB.prepare("SELECT id,state,quote_json,recipient_json,square_order_id,order_channel FROM member_orders WHERE id=?").bind(notice.order_id).first<Order>();
    const expected=notice.kind==="operator-review"?"review":"paid";
    if(!order||order.state!==expected){await env.DB.prepare("UPDATE order_notifications SET state='canceled',updated_at=? WHERE id=?").bind(time,notice.id).run();continue;}
    const quote=JSON.parse(order.quote_json) as {totalJpy:number;discountJpy:number;shippingJpy:number;discountLabel?:string;memberDiscountJpy?:number;fulfillmentHint?:string;lines:{name:string;quantity:number;bags?:number}[]};
    const recipient=JSON.parse(order.recipient_json) as {email_address:string};
    const shipped = notice.kind === "buyer-shipped";
    const buyer = notice.kind === "buyer-paid" || shipped;
    const to=buyer?recipient.email_address:env.ORDER_NOTIFICATION_EMAIL;
    if(!to){await env.DB.prepare("UPDATE order_notifications SET state='failed',updated_at=? WHERE id=?").bind(time,notice.id).run();continue;}
    const items=quote.lines.map(line=>`${line.name} × ${line.quantity}`).join("\n");
    const memberDiscount = quote.memberDiscountJpy ?? 0;
    const otherDiscount = quote.discountJpy - memberDiscount;
    const discount = [
      memberDiscount ? `会員割引：${memberDiscount}円\n` : "",
      otherDiscount ? `${quote.discountLabel ?? "会員割引"}：${otherDiscount}円\n` : "",
    ].join("");
    const coffeeReturns = quote.lines.some(line => line.bags !== 0) ? "食品のお客様都合による返品・交換はお受けできません．" : "";
    const purchaseUrl = order.order_channel === "shop" && env.SHOP_BASE_URL
      ? new URL(`/orders?receipt=${encodeURIComponent(order.id)}`, env.SHOP_BASE_URL).href
      : env.AUTH_BASE_URL ?? "https://members.hacksick.com/";
    const body=buyer?`HackSickストアでのご注文を受け付けました．\n\n受付番号：${order.id}\n${items}\n${discount}送料：${quote.shippingJpy}円\nお支払い合計：${quote.totalJpy}円（税込）\n\n${quote.fulfillmentHint??"決済完了後5日以内を目安に出荷します"}．\n購入状況：${purchaseUrl}\n\n${coffeeReturns}不良品・誤配送はHackSick負担で対応します．到着後7日以内を目安にご連絡ください．\nお問い合わせ：shop@hacksick.com`:
      `会員ショップの${order.state==="review"?"確認が必要な購入":"新規注文"}があります．\n受付番号：${order.id}\nSquare注文ID：${order.square_order_id??"未作成"}\n${items}\n合計：${quote.totalJpy}円\n\n運営画面：https://members.hacksick.com/\nSquareの注文・決済記録を確認してください．`;
    let subject = buyer ? "HackSick ご注文を受け付けました" : `HackSick会員ショップ ${order.state === "review" ? "確認待ち" : "新規注文"}`;
    let text = body;
    if (shipped) {
      const shipment = await env.DB.prepare("SELECT tracking_numbers_json, shipped_at, carrier FROM order_shipments WHERE order_id=?")
        .bind(order.id).first<ShipmentRecord>();
      if (!shipment) {
        await env.DB.prepare("UPDATE order_notifications SET state='failed',updated_at=? WHERE id=?").bind(time, notice.id).run();
        continue;
      }
      const numbers = JSON.parse(shipment.tracking_numbers_json) as string[];
      const date = new Intl.DateTimeFormat("ja-JP", { dateStyle: "long", timeZone: "Asia/Tokyo" }).format(new Date(shipment.shipped_at));
      const carrier = carrierDetails(shipment.carrier);
      subject = "HackSick ご注文の商品を発送しました";
      text = `ご注文の商品を発送しました．\n\n受付番号：${order.id}\n${items}\n\n発送確認日：${date}\n配送方法：${carrier.label}\nお問い合わせ番号：\n${numbers.join("\n")}\n配送状況：${carrier.trackingUrl}\n\n購入状況：${purchaseUrl}\nお問い合わせ：shop@hacksick.com`;
    }
    try{
      const response=await transport("https://api.resend.com/emails",{method:"POST",headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,"Content-Type":"application/json","Idempotency-Key":`members-${notice.id}`},body:JSON.stringify({from:env.MAIL_FROM,to:[to],reply_to:"shop@hacksick.com",subject,text}),signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw new Error("MAIL_FAILED");
      const result=await response.json() as {id?:string};if(!result.id)throw new Error("MAIL_FAILED");
      await env.DB.prepare("UPDATE order_notifications SET state='sent',provider_id=?,updated_at=? WHERE id=?").bind(result.id,new Date().toISOString(),notice.id).run();
    }catch{
      const attempts=notice.attempts+1;const failed=attempts>=10||Date.now()-Date.parse(notice.created_at)>23*3600000;
      await env.DB.prepare("UPDATE order_notifications SET state=?,next_attempt_at=?,updated_at=? WHERE id=?").bind(failed?"failed":"pending",new Date(Date.now()+Math.min(60,2**attempts)*60000).toISOString(),new Date().toISOString(),notice.id).run();
    }
  }
}
