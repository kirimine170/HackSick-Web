import type { Env } from "./types.ts";
import { normalizeEmail } from "./eligibility.ts";
import type { SquareGateway } from "./square.ts";

interface Subscription {
  id: string; location_id: string; customer_id: string; plan_variation_id: string; status: string;
  invoice_ids?: string[]; start_date: string; charged_through_date?: string; canceled_date?: string; timezone?: string;
}
interface Invoice {
  id: string; status: string; location_id: string; order_id: string; primary_recipient?: { customer_id?: string };
  payment_requests?: { due_date: string; computed_amount_money?: { amount: number; currency: string }; total_completed_amount_money?: { amount: number; currency: string } }[];
}
async function call<T>(gateway: SquareGateway, path: string, method = "GET", body?: unknown): Promise<T> {
  if (!gateway.request) throw new Error("BILLING_GATEWAY_UNAVAILABLE");
  return gateway.request<T>(path, method, body);
}
const dateOnly = (s: string | undefined): s is string => Boolean(s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)));
const midnight = (date: string) => new Date(`${date}T00:00:00+09:00`).toISOString();
export function nextMonthlyAnchor(date: string, anchor: number) {
  if (!dateOnly(date) || !Number.isInteger(anchor) || anchor < 1 || anchor > 31) throw new Error("BILLING_PERIOD_INVALID");
  const [year, month] = date.split("-").map(Number);
  const target = (y: number, m: number) => `${y}-${String(m).padStart(2,"0")}-${String(Math.min(anchor, new Date(Date.UTC(y,m,0)).getUTCDate())).padStart(2,"0")}`;
  const same = target(year, month); return same > date ? same : target(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1);
}
async function approvedPlan(env: Env, sub: Subscription, gateway: SquareGateway) {
  const allowed = (env.SQUARE_MONTHLY_PLAN_IDS ?? "").split(",").filter(Boolean);
  if (!allowed.includes(sub.plan_variation_id) || sub.location_id !== env.SQUARE_LOCATION_ID) return null;
  const data = await call<{ object?: { subscription_plan_variation_data?: { monthly_billing_anchor_date?: number; phases?: { cadence: string }[] } } }>(gateway, `/catalog/object/${encodeURIComponent(sub.plan_variation_id)}`);
  const plan = data.object?.subscription_plan_variation_data;
  if (!plan?.phases?.length || plan.phases.some(p => p.cadence !== "MONTHLY") || !dateOnly(sub.start_date) || sub.timezone !== "Asia/Tokyo") throw new Error("MONTHLY_PLAN_CONFIG_MISMATCH");
  return { anchor: plan.monthly_billing_anchor_date ?? Number(sub.start_date.slice(-2)) };
}
async function paidPeriod(env: Env, sub: Subscription, gateway: SquareGateway, anchor: number) {
  const invoices: Invoice[] = [];
  for (const invoiceId of (sub.invoice_ids ?? []).slice(0,24)) {
    const { invoice } = await call<{ invoice: Invoice }>(gateway, `/invoices/${encodeURIComponent(invoiceId)}`);
    if (invoice.id !== invoiceId || invoice.location_id !== env.SQUARE_LOCATION_ID || invoice.primary_recipient?.customer_id !== sub.customer_id) throw new Error("BILLING_INVOICE_MISMATCH");
    invoices.push(invoice);
  }
  if (!["ACTIVE", "CANCELED", "COMPLETED"].includes(sub.status)) return null;
  const candidates = invoices.flatMap(invoice => {
    const requests = invoice.payment_requests;
    if (invoice.status !== "PAID" || !requests?.length || requests.some(p => !dateOnly(p.due_date) || p.computed_amount_money?.currency !== "JPY" || p.total_completed_amount_money?.currency !== "JPY" || !(p.computed_amount_money.amount > 0) || p.total_completed_amount_money.amount !== p.computed_amount_money.amount)) return [];
    // 複数の支払い予定日がある請求から，月額期間を推測しない．
    const dates = [...new Set(requests.map(p => p.due_date))]; if (dates.length !== 1) return [];
    const start = dates[0]; let end = nextMonthlyAnchor(start, anchor);
    for (const cap of [sub.charged_through_date, sub.canceled_date]) if (dateOnly(cap) && cap > start && cap < end) end = cap;
    const from = midnight(start); const until = midnight(end);
    return Date.parse(from) <= Date.now() && Date.parse(until) > Date.now() ? [{ invoice, from, until }] : [];
  }).sort((a,b) => b.from.localeCompare(a.from));
  for (const candidate of candidates) {
    const order = await gateway.getOrder(candidate.invoice.order_id);
    const ids = [...new Set((order.tenders ?? []).flatMap(t => t.payment_id ? [t.payment_id] : []))];
    const payments = await Promise.all(ids.map(id => gateway.getPayment(id)));
    const amount = candidate.invoice.payment_requests!.reduce((sum,p) => sum + p.total_completed_amount_money!.amount,0);
    if (order.id !== candidate.invoice.order_id || order.location_id !== env.SQUARE_LOCATION_ID || order.total_money?.currency !== "JPY" || order.total_money.amount !== amount) throw new Error("BILLING_ORDER_MISMATCH");
    if (!payments.length || payments.some(p => p.status !== "COMPLETED" || p.order_id !== order.id || p.location_id !== env.SQUARE_LOCATION_ID || p.total_money?.currency !== "JPY" || p.refunded_money?.amount) || payments.reduce((sum,p) => sum + p.total_money!.amount,0) !== amount) continue;
    return { ...candidate, paymentIds: ids };
  }
  return null;
}
async function syncSubscription(env: Env, sub: Subscription, gateway: SquareGateway, actor: string, create: boolean) {
  const plan = await approvedPlan(env, sub, gateway); if (!plan) return null;
  const customerData = await call<{ customer?: { id: string; email_address?: string; given_name?: string; family_name?: string } }>(gateway, `/customers/${encodeURIComponent(sub.customer_id)}`);
  const customer = customerData.customer;
  if (!customer?.email_address || customer.id !== sub.customer_id) throw new Error("BILLING_CUSTOMER_MISSING");
  const email = normalizeEmail(customer.email_address); const db = env.DB; const time = new Date().toISOString();
  let link = await db.prepare("SELECT member_id,square_customer_id FROM billing_links WHERE square_subscription_id=?").bind(sub.id).first<{ member_id: string; square_customer_id: string }>();
  let member = link ? await db.prepare("SELECT id,status FROM members WHERE id=?").bind(link.member_id).first<{ id: string; status: string }>() : null;
  if (link && link.square_customer_id !== sub.customer_id) throw new Error("BILLING_IDENTITY_CHANGED");
  if (!link) {
    if (!create) return null;
    const matches = (await db.prepare("SELECT DISTINCT m.id,m.status FROM members m LEFT JOIN member_emails e ON e.member_id=m.id WHERE m.claim_email=? COLLATE NOCASE OR e.email=? COLLATE NOCASE").bind(email,email).all<{ id: string; status: string }>()).results;
    if (matches.length > 1) throw new Error("BILLING_EMAIL_COLLISION");
    member = matches[0] ?? null;
    if (!member) {
      const memberId = `HS-${crypto.randomUUID()}`;
      const display = [customer.family_name,customer.given_name].filter(Boolean).join(" ").trim() || "HackSick月額会員";
      await db.batch([
        db.prepare("INSERT INTO members (id,display_name,claim_email,status,created_at,updated_at) VALUES (?,?,?,'active',?,?)").bind(memberId,display.slice(0,100),email,time,time),
        db.prepare("INSERT INTO member_emails VALUES (?,?,'square-confirmed-billing',?)").bind(email,memberId,time),
        db.prepare("INSERT INTO audit_log VALUES (?,?, 'member.billing-import', ?, ?, ?)").bind(crypto.randomUUID(),actor,memberId,JSON.stringify({ customerId:sub.customer_id, subscriptionId:sub.id }),time),
      ]);
      member = { id:memberId,status:"active" };
    }
    await db.prepare("INSERT INTO billing_links VALUES (?,?,?,?,?,?)").bind(crypto.randomUUID(),member.id,sub.customer_id,sub.id,actor,time).run();
    link = { member_id:member.id, square_customer_id:sub.customer_id };
  }
  if (!member) throw new Error("BILLING_MEMBER_MISSING");
  const period = await paidPeriod(env, sub, gateway, plan.anchor);
  const prefix = `square-invoice:${sub.id}:`;
  const evidence = period ? `${prefix}${period.invoice.id}` : "";
  const previous = await db.prepare("SELECT status,paid_until,invoice_id FROM billing_sync_state WHERE square_subscription_id=?").bind(sub.id).first<{status:string;paid_until:string|null;invoice_id:string|null}>();
  const statements = [
    db.prepare("UPDATE membership_grants SET revoked_at=?,revocation_source='square-sync' WHERE member_id=? AND kind='MONTHLY' AND evidence_id LIKE ? AND evidence_id<>? AND revoked_at IS NULL").bind(time,member.id,`${prefix}%`,evidence),
    db.prepare("INSERT INTO billing_sync_state VALUES (?,?,?,?,?) ON CONFLICT(square_subscription_id) DO UPDATE SET status=excluded.status,checked_at=excluded.checked_at,paid_until=excluded.paid_until,invoice_id=excluded.invoice_id").bind(sub.id,sub.status,time,period?.until ?? null,period?.invoice.id ?? null),
  ];
  if (period) statements.push(db.prepare(`INSERT INTO membership_grants (id,member_id,kind,valid_from,valid_until,evidence_id,confirmed_by,reason,created_at)
    VALUES (?,?,'MONTHLY',?,?,?,?,?,?) ON CONFLICT(member_id,kind,evidence_id,valid_from) DO UPDATE SET valid_until=excluded.valid_until,
    revoked_at=CASE WHEN membership_grants.revocation_source='square-sync' THEN NULL ELSE membership_grants.revoked_at END,
    revocation_source=CASE WHEN membership_grants.revocation_source='square-sync' THEN NULL ELSE membership_grants.revocation_source END`)
    .bind(crypto.randomUUID(),member.id,period.from,period.until,evidence,actor,JSON.stringify({ source:"Square API", subscriptionId:sub.id,invoiceId:period.invoice.id,paymentIds:period.paymentIds }),time));
  if (!previous || previous.status !== sub.status || previous.paid_until !== (period?.until ?? null) || previous.invoice_id !== (period?.invoice.id ?? null)) statements.push(db.prepare("INSERT INTO audit_log VALUES (?,?,'billing.sync',?,?,?)").bind(crypto.randomUUID(),actor,member.id,JSON.stringify({subscriptionId:sub.id,status:sub.status,paidUntil:period?.until ?? null,invoiceId:period?.invoice.id ?? null}),time));
  await db.batch(statements);
  return { memberId:member.id, subscriptionId:sub.id, paidUntil:period?.until ?? null, eligible:member.status === "active" && Boolean(period) };
}
export async function syncMonthlySubscriptions(env: Env, gateway: SquareGateway, force = false) {
  if (!env.SQUARE_MONTHLY_PLAN_IDS) return [];
  const actor = await env.DB.prepare("SELECT connected_by FROM square_connections WHERE environment=? AND client_id=?").bind(env.SQUARE_ENVIRONMENT!,env.SQUARE_CLIENT_ID!).first<{ connected_by:string }>();
  if (!actor) return [];
  if (!force) {
    const last = await env.DB.prepare("SELECT MIN(checked_at) AS checked FROM billing_sync_state").first<{ checked:string | null }>();
    if (last?.checked && Date.now() - Date.parse(last.checked) < 5 * 60000) return [];
  }
  const subs: Subscription[] = []; let cursor: string | undefined;
  do { const page = await call<{ subscriptions?: Subscription[]; cursor?: string }>(gateway,"/subscriptions/search","POST",{ query:{filter:{location_ids:[env.SQUARE_LOCATION_ID]}}, limit:100, ...(cursor?{cursor}:{}) }); subs.push(...(page.subscriptions ?? []));cursor=page.cursor;if(subs.length>1000)throw new Error("BILLING_PAGINATION_LIMIT"); } while(cursor);
  const result = [];
  for (const sub of subs) { const synced = await syncSubscription(env,sub,gateway,actor.connected_by,true);if(synced)result.push(synced); }
  return result;
}
export async function refreshBillingForUser(env: Env, userId: string, gateway: SquareGateway) {
  if (!env.SQUARE_MONTHLY_PLAN_IDS) return;
  const links = (await env.DB.prepare("SELECT b.square_subscription_id,b.confirmed_by FROM billing_links b JOIN members m ON m.id=b.member_id WHERE m.auth_user_id=?").bind(userId).all<{ square_subscription_id:string; confirmed_by:string }>()).results;
  for (const link of links) {
    const { subscription } = await call<{ subscription:Subscription }>(gateway,`/subscriptions/${encodeURIComponent(link.square_subscription_id)}`);
    if (subscription.id !== link.square_subscription_id) throw new Error("BILLING_SUBSCRIPTION_MISMATCH");
    await syncSubscription(env,subscription,gateway,link.confirmed_by,false);
  }
}
