import { CheckoutConflict } from "./checkout.ts";
import { InputError, normalizeEmail, requiredText } from "./eligibility.ts";
import { visibleShipment, type ShipmentRecord } from "./order-shipment.ts";
import { shopAudit } from "./shop-operations.ts";

export async function essenStaff(db: D1Database, email: string) {
  return email.toLowerCase().endsWith("@byessen.com") && Boolean(await db.prepare("SELECT email FROM shop_fulfillment_staff WHERE email=? AND enabled=1").bind(email).first());
}

export async function saveFulfillmentStaff(db: D1Database, actor: string, body: Record<string, unknown>) {
  const email = normalizeEmail(body.email);
  if (!email.endsWith("@byessen.com")) throw new InputError("ESSENの担当者メールを指定してください．");
  await db.batch([
    db.prepare("INSERT INTO shop_fulfillment_staff VALUES (?,?) ON CONFLICT(email) DO UPDATE SET enabled=excluded.enabled")
      .bind(email, body.enabled === false ? 0 : 1),
    shopAudit(db, actor, body.enabled === false ? "essen.staff.disable" : "essen.staff.enable", email),
  ]);
}

export async function fulfillmentOrders(db: D1Database, partner: boolean) {
  if (partner) {
    const rows = (await db.prepare(`SELECT o.id,o.quote_json,o.recipient_json,o.state,s.tracking_numbers_json,s.shipped_at,s.carrier,d.hold_reason,d.planned_date
      FROM member_orders o LEFT JOIN order_shipments s ON s.order_id=o.id LEFT JOIN shop_dispatch d ON d.order_id=o.id
      WHERE o.fulfillment_source='essen' AND o.state='paid' ORDER BY s.shipped_at IS NOT NULL,o.created_at DESC LIMIT 100`)
      .all<ShipmentRecord & {id:string;quote_json:string;recipient_json:string;hold_reason:string|null;planned_date:string|null}>()).results;
    return rows.map(row => {
      const quote = JSON.parse(row.quote_json) as {lines:{name:string;quantity:number}[]};
      const { display_name, phone_number, address } = JSON.parse(row.recipient_json);
      return { id: row.id, lines: quote.lines.map(({name,quantity}) => ({name,quantity})),
        recipient: row.shipped_at ? null : {display_name,phone_number,address}, planned_date: row.planned_date, hold_reason: row.hold_reason,
        shipment: row.shipped_at ? visibleShipment(row) : null };
    });
  }
  const rows = (await db.prepare(`SELECT o.id,o.member_id,o.state,o.square_order_id,o.square_payment_id,
    o.review_reason,o.quote_json,o.created_at,o.purchase_kind,o.fulfillment_source,o.order_channel,
    s.tracking_numbers_json,s.shipped_at,s.carrier,d.hold_reason,d.planned_date,
    n.state AS shipping_notice_state,r.state AS receipt_notice_state
    FROM member_orders o LEFT JOIN order_shipments s ON s.order_id=o.id
    LEFT JOIN shop_dispatch d ON d.order_id=o.id
    LEFT JOIN order_notifications n ON n.order_id=o.id AND n.kind='buyer-shipped'
    LEFT JOIN order_notifications r ON r.order_id=o.id AND r.kind='buyer-paid'
    ORDER BY (o.state='paid' AND s.shipped_at IS NULL) DESC, o.created_at DESC LIMIT 100`).all<ShipmentRecord & {id:string}>()).results;
  return rows.map(({ tracking_numbers_json, shipped_at, carrier, ...row }) => ({
    ...row, shipment: shipped_at ? visibleShipment({ tracking_numbers_json, shipped_at, carrier }) : null,
  }));
}

export async function saveDispatch(db: D1Database, orderId: string, actor: string, body: Record<string, unknown>, source?: "essen") {
  const plannedDate = body.plannedDate ? requiredText(body.plannedDate, "発送予定日", 10) : null;
  if (plannedDate && (!/^\d{4}-\d{2}-\d{2}$/.test(plannedDate) || !Number.isFinite(Date.parse(plannedDate)) ||
    new Date(plannedDate).toISOString().slice(0, 10) !== plannedDate)) throw new InputError("有効な発送予定日を指定してください．");
  const holdReason = body.holdReason ? requiredText(body.holdReason, "保留理由", 240) : null;
  const timestamp = new Date().toISOString();
  const [change] = await db.batch([db.prepare(`INSERT INTO shop_dispatch (order_id,planned_date,hold_reason)
    SELECT id,?,? FROM member_orders WHERE id=? AND state='paid' AND (? IS NULL OR fulfillment_source=?)
    AND NOT EXISTS (SELECT 1 FROM order_shipments WHERE order_id=member_orders.id)
    AND (? IS NULL OR EXISTS (SELECT 1 FROM user u JOIN shop_fulfillment_staff s ON s.email=u.email COLLATE NOCASE
      WHERE u.id=? AND u.emailVerified=1 AND s.enabled=1))
    ON CONFLICT(order_id) DO UPDATE SET planned_date=excluded.planned_date,hold_reason=excluded.hold_reason`)
    .bind(plannedDate,holdReason,orderId,source??null,source??null,source??null,actor),
    db.prepare("INSERT INTO shop_operations_log SELECT ?,?,?,?,? WHERE changes()=1")
      .bind(crypto.randomUUID(),actor,"dispatch.update",orderId,timestamp)]);
  if (!change.meta.changes) throw new CheckoutConflict("支払済みで発送前の担当注文を確認してください．");
  return {plannedDate,holdReason};
}
