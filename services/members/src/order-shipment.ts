import { CheckoutConflict } from "./checkout.ts";
import { InputError } from "./eligibility.ts";
import { reconcileSharedOrder, type SharedOrder } from "./shared-checkout.ts";
import { JAPAN_POST_TRACKING_URL } from "./shipping-policy.ts";
import type { SquareGateway } from "./square.ts";
import type { Env } from "./types.ts";

export function trackingNumbers(input: unknown): string[] {
  if (typeof input !== "string" || input.length > 400) throw new InputError("クリックポストのお問い合わせ番号を入力してください．");
  const numbers = input.trim().split(/[\s,、，]+/u).map(number => number.replaceAll("-", ""));
  if (numbers.length > 20 || numbers.some(number => !/^\d{11,13}$/.test(number)) || new Set(numbers).size !== numbers.length) {
    throw new InputError("11〜13桁のお問い合わせ番号を，重複なしで1件ずつ入力してください．");
  }
  return numbers.sort();
}

export const SHIPPING_CARRIERS = {
  clickpost: { label: "日本郵便 クリックポスト", trackingUrl: JAPAN_POST_TRACKING_URL },
  japanpost: { label: "日本郵便", trackingUrl: JAPAN_POST_TRACKING_URL },
  yamato: { label: "ヤマト運輸", trackingUrl: "https://toi.kuronekoyamato.co.jp/cgi-bin/tneko" },
  sagawa: { label: "佐川急便", trackingUrl: "https://k2k.sagawa-exp.co.jp/p/sagawa/web/okurijoinput.jsp" },
} as const;

export function carrierDetails(carrier?: string) {
  return carrier && Object.hasOwn(SHIPPING_CARRIERS, carrier)
    ? SHIPPING_CARRIERS[carrier as keyof typeof SHIPPING_CARRIERS] : SHIPPING_CARRIERS.clickpost;
}

export interface ShipmentRecord {
  tracking_numbers_json: string;
  shipped_at: string;
  carrier?: string;
}

export function visibleShipment(row: ShipmentRecord) {
  return {
    trackingNumbers: JSON.parse(row.tracking_numbers_json) as string[],
    shippedAt: row.shipped_at,
    ...carrierDetails(row.carrier),
  };
}

export function readShipment(db: D1Database, orderId: string) {
  return db.prepare("SELECT tracking_numbers_json, shipped_at, carrier FROM order_shipments WHERE order_id=?")
    .bind(orderId).first<ShipmentRecord>();
}

export async function recordShipment(env: Env, order: SharedOrder, actorId: string, body: Record<string, unknown>, gateway: SquareGateway, partnerEmail?: string) {
  if (env.SQUARE_ENVIRONMENT === "production" && !env.RESEND_API_KEY) throw new CheckoutConflict("発送通知の送信設定を確認してください．");
  if (body.dispatched !== true) throw new InputError("配送業者への引き渡しを確認してください．");
  if (partnerEmail && order.fulfillment_source !== "essen") throw new CheckoutConflict("担当注文を確認してください．");
  const carrier = body.carrier ?? "clickpost";
  if (typeof carrier !== "string" || !Object.hasOwn(SHIPPING_CARRIERS, carrier) || (order.fulfillment_source !== "essen" && carrier !== "clickpost")) throw new InputError("配送業者を確認してください．");
  const numbers = JSON.stringify(trackingNumbers(body.trackingNumbers));
  const previous = await readShipment(env.DB, order.id);
  if (previous) {
    if (previous.tracking_numbers_json !== numbers || previous.carrier !== carrier) throw new CheckoutConflict("この注文は別のお問い合わせ番号で発送を記録済みです．");
    return visibleShipment(previous);
  }
  if (order.state !== "paid" || !order.square_order_id) throw new CheckoutConflict("支払いを確認できる注文を選んでください．");
  const squareOrder = await gateway.getOrder(order.square_order_id);
  const verified = await reconcileSharedOrder(env, order, gateway, squareOrder);
  if (verified.state !== "paid") throw new CheckoutConflict("支払い状況を確認してから発送を記録してください．");
  if (squareOrder.fulfillments?.some(fulfillment => fulfillment.type === "SHIPMENT" &&
    (fulfillment.state === "COMPLETED" || fulfillment.shipment_details?.shipped_at))) {
    throw new CheckoutConflict("Squareで発送済みの注文です．Squareの発送通知を確認してください．");
  }
  if (await env.DB.prepare("SELECT order_id FROM shop_dispatch WHERE order_id=? AND hold_reason IS NOT NULL").bind(order.id).first()) throw new CheckoutConflict("発送保留を解除してから発送を記録してください．");
  const now = new Date().toISOString();
  const statements = [env.DB.prepare(`INSERT OR IGNORE INTO order_shipments (order_id,tracking_numbers_json,shipped_at,recorded_by,carrier)
    SELECT id,?,?,?,? FROM member_orders WHERE id=? AND state='paid'
    AND NOT EXISTS (SELECT 1 FROM shop_dispatch d WHERE d.order_id=member_orders.id AND d.hold_reason IS NOT NULL)
    AND (? IS NULL OR (fulfillment_source='essen' AND EXISTS (SELECT 1 FROM shop_fulfillment_staff WHERE email=? AND enabled=1)))`)
    .bind(numbers, now, actorId, carrier, order.id, partnerEmail ?? null, partnerEmail ?? null),
    env.DB.prepare("INSERT INTO shop_operations_log SELECT ?,?,?,?,? WHERE changes()=1").bind(crypto.randomUUID(), actorId, "shipment.record", order.id, now)];
  if (env.SQUARE_ENVIRONMENT === "production") {
    const sendAt = new Date(Date.now() + 90000).toISOString();
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO order_notifications
      (id,order_id,kind,state,next_attempt_at,created_at,updated_at)
      SELECT ?,order_id,'buyer-shipped','pending',?,?,? FROM order_shipments
      WHERE order_id=? AND tracking_numbers_json=? AND carrier=?`).bind(`${order.id}:buyer-shipped`, sendAt, now, now, order.id, numbers, carrier));
  }
  await env.DB.batch(statements);
  const shipment = await readShipment(env.DB, order.id);
  if (!shipment || shipment.tracking_numbers_json !== numbers || shipment.carrier !== carrier) {
    throw new CheckoutConflict("発送状況が変更されました．注文を読み直してください．");
  }
  return visibleShipment(shipment);
}
