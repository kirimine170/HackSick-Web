import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createWorker } from "../src/worker.ts";
import type { Env } from "../src/types.ts";
import { addTokyoMonths } from "../src/benefits.ts";
import { issueMemberPass } from "../src/member-pass.ts";

test("実際のBetter AuthとローカルD1で会員管理を検証する", async (t) => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default { fetch() { return new Response('test'); } }", d1Databases: ["DB"], compatibilityDate: "2026-11-03" }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  for (const file of (await readdir("migrations")).filter(file => file.endsWith(".sql")).sort().map(file => `migrations/${file}`)) {
    const sql = (await readFile(file, "utf8")).replace(/^--.*$/gm, "");
    await db.batch(sql.split(";").map(statement => statement.trim()).filter(Boolean).map(statement => db.prepare(statement)));
  }
  const codes = new Map<string, string>();
  const worker = createWorker(async ({ email, otp }) => { codes.set(email, otp); });
  const origin = "http://localhost:8787";
  const env = { DB: db, AUTH_BASE_URL: origin, BETTER_AUTH_SECRET: "integration-test-only-not-for-any-deployment", GOOGLE_WORKSPACE_DOMAIN: "hacksick.com", ASSETS: { fetch: async () => new Response("test asset") } } as unknown as Env;
  let ip = 0;

  const call = (path: string, cookie = "", body?: unknown, source = origin) => worker.fetch(new Request(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Cookie: cookie, Origin: source, "Content-Type": "application/json", "cf-connecting-ip": `192.0.2.${ip}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
  async function signIn(email: string) {
    ip++;
    const sent = await call("/api/auth/email-otp/send-verification-otp", "", { email, type: "sign-in" });
    assert.equal(sent.status, 200, await sent.text());
    const response = await call("/api/auth/sign-in/email-otp", "", { email, otp: codes.get(email) });
    assert.equal(response.status, 200, await response.clone().text());
    const cookie = response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    assert.ok(cookie.includes("session_token="));
    const data = await response.json() as { user: { id: string } };
    return { cookie, id: data.user.id };
  }

  await t.test("未ログインの管理操作は拒否する", async () => {
    assert.equal((await call("/api/admin/members")).status, 401);
    assert.equal((await call("/api/admin/members", "", { displayName: "unauthorized" })).status, 401);
  });

  const manager = await signIn("operator@example.invalid");
  await db.prepare("INSERT INTO operators (auth_user_id, role, created_at) VALUES (?, 'manager', ?)").bind(manager.id, new Date().toISOString()).run();
  const regular = await signIn("member@example.invalid");

  await t.test("一般アカウントと異なるOriginからの管理操作は拒否する", async () => {
    assert.equal((await call("/api/admin/members", regular.cookie)).status, 403);
    assert.equal((await call("/api/admin/members", manager.cookie, { displayName: "forged" }, "https://attacker.invalid")).status, 403);
    assert.equal((await call("/api/me", regular.cookie)).headers.get("Cache-Control"), "no-store");
  });

  let memberId = "";
  await t.test("会員登録と，本人確認済みメールへの初回紐付け", async () => {
    const response = await call("/api/admin/members", manager.cookie, { displayName: "Integration Member", email: "MEMBER@example.invalid", hsapId: "HSAP-000001" });
    assert.equal(response.status, 201);
    memberId = ((await response.json()) as { id: string }).id;
    const me = await (await call("/api/me", regular.cookie)).json() as { member: { id: string }; benefit: { eligible: boolean } };
    assert.equal(me.member.id, memberId);
    assert.equal(me.benefit.eligible, false);
    assert.equal((await db.prepare("SELECT auth_user_id FROM members WHERE id = ?").bind(memberId).first<{ auth_user_id: string }>())?.auth_user_id, regular.id);
    assert.equal((await call("/api/admin/members", manager.cookie, { displayName: "duplicate", email: "member@example.invalid" })).status, 409);
    const untouched = await (await call("/api/me", manager.cookie)).json() as { member: unknown };
    assert.equal(untouched.member, null);
    const list = await (await call("/api/admin/members?q=Integration", manager.cookie)).json() as { members: { id: string }[] };
    assert.equal(list.members[0].id, memberId);
    const injection = await (await call("/api/admin/members?q=%25%27%20OR%201%3D1", manager.cookie)).json() as { members: unknown[] };
    assert.equal(injection.members.length, 0);
  });

  const start = new Date(Date.now() - 86400000).toISOString();
  const end = new Date(Date.now() + 86400000).toISOString();
  let monthly = "";
  let hsap = "";
  await t.test("契約紐付けだけでは資格を付けず，入金根拠と期間を確認して付ける", async () => {
    const billing = { customerId: "customer-checked", subscriptionId: "subscription-checked" };
    assert.equal((await call(`/api/admin/members/${memberId}/billing-links`, manager.cookie, billing)).status, 201);
    assert.equal((await call(`/api/admin/members/${memberId}/billing-links`, manager.cookie, billing)).status, 409);
    const before = await (await call("/api/me", regular.cookie)).json() as { benefit: { eligible: boolean } };
    assert.equal(before.benefit.eligible, false);
    const grant = { kind: "MONTHLY", validFrom: start, evidenceId: "payment-private", reason: "Squareの請求と入金を手動確認" };
    assert.equal((await call(`/api/admin/members/${memberId}/grants`, manager.cookie, grant)).status, 400);
    const response = await call(`/api/admin/members/${memberId}/grants`, manager.cookie, { ...grant, validUntil: end });
    assert.equal(response.status, 201);
    monthly = ((await response.json()) as { id: string }).id;
    const hsapResponse = await call(`/api/admin/members/${memberId}/grants`, manager.cookie, { kind: "HSAP", validFrom: start, validUntil: null, evidenceId: "HSAP-000001", reason: "台帳の在籍を確認" });
    assert.equal(hsapResponse.status, 201);
    hsap = ((await hsapResponse.json()) as { id: string }).id;
    const meResponse = await call("/api/me", regular.cookie);
    const text = await meResponse.text();
    assert.equal(text.includes("payment-private"), false);
    assert.equal(JSON.parse(text).benefit.discountPercent, 10);
    assert.equal(JSON.parse(text).checkoutAvailable, false);
  });

  await t.test("取消・利用停止を即時に資格判定へ反映し，変更履歴を残す", async () => {
    assert.equal((await call(`/api/admin/grants/${monthly}/revoke`, manager.cookie, { reason: "取消確認" })).status, 200);
    assert.equal((await call(`/api/admin/grants/${hsap}/revoke`, manager.cookie, { reason: "退会確認" })).status, 200);
    const me = await (await call("/api/me", regular.cookie)).json() as { benefit: { eligible: boolean } };
    assert.equal(me.benefit.eligible, false);
    assert.equal((await call(`/api/admin/members/${memberId}/status`, manager.cookie, { status: "blocked", reason: "本人依頼" })).status, 200);
    const history = await db.prepare("SELECT action FROM audit_log WHERE member_id = ?").bind(memberId).all<{ action: string }>();
    assert.ok(history.results.some(row => row.action === "member.claim"));
    assert.equal(history.results.filter(row => row.action === "grant.revoke").length, 2);
    assert.equal(history.results.filter(row => row.action === "member.claim").length, 1);
  });

  await t.test("閲覧担当は会員情報を見られるが変更できない", async () => {
    await db.prepare("INSERT INTO operators (auth_user_id, role, created_at) VALUES (?, 'viewer', ?)").bind(regular.id, new Date().toISOString()).run();
    assert.equal((await call(`/api/admin/members/${memberId}`, regular.cookie)).status, 200);
    assert.equal((await call(`/api/admin/members/${memberId}/status`, regular.cookie, { status: "active", reason: "not allowed" })).status, 403);
  });

  await t.test("確認コードと期限切れセッションでは認証できない", async () => {
    ip++;
    await call("/api/auth/email-otp/send-verification-otp", "", { email: "wrong-code@example.invalid", type: "sign-in" });
    const actual = codes.get("wrong-code@example.invalid");
    const stored = await db.prepare("SELECT value FROM verification WHERE identifier LIKE ?").bind("%wrong-code@example.invalid%").first<{ value: string }>();
    assert.ok(stored);
    assert.equal(stored.value.includes(actual!), false);
    const invalid = actual === "111111" ? "222222" : "111111";
    assert.notEqual((await call("/api/auth/sign-in/email-otp", "", { email: "wrong-code@example.invalid", otp: invalid })).status, 200);
    await db.prepare('UPDATE session SET "expiresAt" = 0 WHERE "userId" = ?').bind(regular.id).run();
    assert.equal((await call("/api/me", regular.cookie)).status, 401);
  });

  let benefitMember = "";
  await t.test("LT免除を月1回に制限し，HSAPへの配賦と提供履歴を保存する", async () => {
    const created = await call("/api/admin/members", manager.cookie, { displayName: "Benefits Member", email: "benefits@example.invalid", hsapId: "HSAP-000002" });
    benefitMember = ((await created.json()) as { id: string }).id;
    const from = new Date(Date.now() - 200 * 86400000).toISOString();
    assert.equal((await call(`/api/admin/members/${benefitMember}/grants`, manager.cookie, { kind: "HSAP", validFrom: from, evidenceId: "HSAP-000002", reason: "在籍確認" })).status, 201);
    const path = `/api/admin/members/${benefitMember}/benefit-redemptions`;
    const eventAt = new Date().toISOString();
    const first = await call(path, manager.cookie, { kind: "LT_WAIVER", eventId: "LT-A", eventAt, reason: "受付で本人と参加を確認" });
    assert.equal(first.status, 201, await first.clone().text());
    assert.equal(((await first.json()) as { internalAllocationJpy: number }).internalAllocationJpy, 1000);
    assert.equal((await call(`/api/admin/members/${benefitMember}/grants`, manager.cookie, { kind: "MONTHLY", validFrom: from, validUntil: new Date(Date.now() + 400 * 86400000).toISOString(), evidenceId: "payment-benefits", reason: "入金確認" })).status, 201);
    assert.equal((await call(path, manager.cookie, { kind: "LT_WAIVER", eventId: "LT-B", eventAt, reason: "同月2回目" })).status, 409);
    const nextMonth = addTokyoMonths(eventAt, 1);
    const concurrent = await Promise.all(["LT-C", "LT-D"].map(eventId => call(path, manager.cookie, { kind: "LT_WAIVER", eventId, eventAt: nextMonth, reason: "同時受付の検証" })));
    assert.deepEqual(concurrent.map(response => response.status).sort(), [201, 409]);
    const stored = await db.prepare("SELECT COUNT(*) AS count, SUM(internal_allocation_jpy) AS allocation FROM benefit_redemptions WHERE member_id = ? AND kind = 'LT_WAIVER'").bind(benefitMember).first<{ count: number; allocation: number }>();
    assert.equal(stored?.count, 2);
    assert.equal(stored?.allocation, 1000);
    const audit = await db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE member_id = ? AND action = 'benefit.redeem'").bind(benefitMember).first<{ count: number }>();
    assert.equal(audit?.count, 2);
  });

  await t.test("ステッカーと初登壇の提供を重複させず，初登壇は明示的に確認する", async () => {
    const path = `/api/admin/members/${benefitMember}/benefit-redemptions`;
    assert.equal((await call(path, manager.cookie, { kind: "JOIN_STICKER", reason: "初回受渡し" })).status, 201);
    assert.equal((await call(path, manager.cookie, { kind: "JOIN_STICKER", reason: "二重登録" })).status, 409);
    assert.equal((await call(path, manager.cookie, { kind: "LOYALTY_STICKER", reason: "継続特典受渡し" })).status, 201);
    assert.equal((await call(path, manager.cookie, { kind: "LOYALTY_STICKER", reason: "二重登録" })).status, 409);
    const speaker = { kind: "FIRST_TALK_COFFEE", eventId: "LT-A", eventAt: new Date().toISOString(), speakerConfirmed: true, reason: "登壇確認" };
    assert.equal((await call(path, manager.cookie, speaker)).status, 409);
    assert.equal((await call(path, manager.cookie, { ...speaker, firstTalkConfirmed: true })).status, 201);
    assert.equal((await call(path, manager.cookie, { ...speaker, eventId: "LT-E", firstTalkConfirmed: true })).status, 409);
    assert.equal((await call(path, manager.cookie, { ...speaker, kind: "SPEAKER_STICKER" })).status, 201);
    assert.equal((await call(path, manager.cookie, { ...speaker, kind: "SPEAKER_STICKER" })).status, 409);
  });

  await t.test("会員QRの照会とLT免除の記録を分け，改変・期限切れ・同月の重複を拒否する", async () => {
    const created = await call("/api/admin/members", manager.cookie, {
      displayName: "QR受付のテスト会員", email: "qr-member@example.invalid", hsapId: "HSAP-000003",
    });
    assert.equal(created.status, 201);
    const { id: qrMemberId } = await created.json() as { id: string };
    const validFrom = new Date(Date.now() - 86400000).toISOString();
    const validUntil = new Date(Date.now() + 86400000).toISOString();
    const grantsPath = `/api/admin/members/${qrMemberId}/grants`;
    assert.equal((await call(grantsPath, manager.cookie, { kind: "HSAP", validFrom, evidenceId: "HSAP-000003", reason: "試験用在籍" })).status, 201);
    assert.equal((await call(grantsPath, manager.cookie, { kind: "MONTHLY", validFrom, validUntil, evidenceId: "qr-test-payment", reason: "試験用入金" })).status, 201);
    const attendee = await signIn("qr-member@example.invalid");
    assert.equal((await call("/api/me", attendee.cookie)).status, 200);
    const passPath = "/api/member-pass";
    assert.equal((await call(passPath, "", {})).status, 401);
    assert.equal((await call(passPath, manager.cookie, {})).status, 403);
    const pass = await call(passPath, attendee.cookie, {});
    assert.equal(pass.status, 200);
    assert.equal(pass.headers.get("cache-control"), "no-store");
    const { token } = await pass.json() as { token: string };
    const path = "/api/admin/lt/check-in";
    const check = { token, eventId: "LT-QR" };
    assert.equal((await call(path, attendee.cookie, check)).status, 403);
    assert.equal((await call(path, manager.cookie, check, "https://invalid.example")).status, 403);
    const forged = token.slice(0, 20) + (token[20] === "A" ? "B" : "A") + token.slice(21);
    assert.equal((await call(path, manager.cookie, { ...check, token: forged })).status, 400);
    const expired = await issueMemberPass(env, qrMemberId, attendee.id, Date.now() - 121000);
    assert.equal((await call(path, manager.cookie, { ...check, token: expired.token })).status, 400);

    const preview = await call(path, manager.cookie, check);
    assert.equal(preview.status, 200);
    const eligible = await preview.json() as { displayName: string; allowed: boolean; month: string };
    assert.equal(eligible.displayName, "QR受付のテスト会員");
    assert.equal(eligible.allowed, true);
    const count = async () => (await db.prepare("SELECT count(*) AS total FROM benefit_redemptions WHERE member_id=?").bind(qrMemberId).first<{ total: number }>())?.total;
    assert.equal(await count(), 0);
    assert.equal((await call(path, manager.cookie, { ...check, record: true, month: "2020-01" })).status, 409);
    const record = { ...check, month: eligible.month, record: true };
    const responses = await Promise.all([call(path, manager.cookie, record), call(path, manager.cookie, record)]);
    assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
    assert.equal(await count(), 1);
    const saved = await db.prepare("SELECT event_id, funding, confirmed_by FROM benefit_redemptions WHERE member_id=?").bind(qrMemberId).first();
    assert.deepEqual(saved, { event_id: "LT-QR", funding: "MONTHLY", confirmed_by: manager.id });
    const used = await call(path, manager.cookie, { ...check, eventId: "LT-OTHER" });
    assert.equal(((await used.json()) as { allowed: boolean }).allowed, false);
  });

  await t.test("採算プレビューではサーバーの価格・資格を使い，本番決済や在庫引当をしない", async () => {
    const response = await call("/api/admin/simulations/order", manager.cookie, { memberId: benefitMember, items: [{ sku: "HS-COFFEE-MOCHA-5PACK", quantity: 2, unitPriceJpy: 1 }], couponPercent: 10 });
    assert.equal(response.status, 200, await response.clone().text());
    const data = await response.json() as { live: boolean; stockReserved: boolean; quote: { subtotalJpy: number; discountJpy: number; goodsTotalJpy: number; shippingJpy: number }; contribution: { assessment: string } };
    assert.equal(data.live, false); assert.equal(data.stockReserved, false);
    assert.equal(data.quote.subtotalJpy, 4104); assert.equal(data.quote.discountJpy, 410);
    assert.equal(data.quote.goodsTotalJpy, 3694); assert.equal(data.quote.shippingJpy, 0);
    assert.equal(data.contribution.assessment, "incomplete");
    const forged = await (await call("/api/admin/simulations/order", manager.cookie, { memberEligible: true, items: [{ sku: "HS-COFFEE-MOCHA-10G", quantity: 1 }] })).json() as { quote: { discountJpy: number } };
    assert.equal(forged.quote.discountJpy, 0);
    assert.equal((await call("/api/admin/simulations/order", "", { items: [] })).status, 401);
    const recurring = await call("/api/admin/simulations/order", manager.cookie, { memberId: benefitMember, recurring: true, priceBasis: "subscription-plan", items: [{ sku: "HS-COFFEE-MOCHA-10G", quantity: 30 }] });
    assert.equal(recurring.status, 400);
    assert.match(await recurring.text(), /定期便専用/);
    const policy = await (await call("/api/admin/policy", manager.cookie)).json() as { status: string; proposedPlans: { studentBundle: { enabled: boolean }; coffeeSubscriptions: { checkoutEnabled: boolean; taxTreatment: string; taxPercent: number; shippingPolicy: { shippingFeeJpy: number; freeShippingThresholdJpy: number }; plans: { basePriceExTaxJpy: number }[] } } };
    assert.equal(policy.status, "draft"); assert.equal(policy.proposedPlans.studentBundle.enabled, false);
    assert.equal(policy.proposedPlans.coffeeSubscriptions.checkoutEnabled, false);
    assert.equal(policy.proposedPlans.coffeeSubscriptions.taxTreatment, "exclusive");
    assert.equal(policy.proposedPlans.coffeeSubscriptions.taxPercent, 8);
    assert.deepEqual(policy.proposedPlans.coffeeSubscriptions.shippingPolicy, { shippingFeeJpy: 500, freeShippingThresholdJpy: 5000, freeShippingBasis: "goods-before-discount-including-tax" });
    assert.deepEqual(policy.proposedPlans.coffeeSubscriptions.plans.map(plan => plan.basePriceExTaxJpy), [10800, 7480, 2800]);
    const snapshot = await call(`/api/admin/members/${benefitMember}/benefits`, manager.cookie);
    assert.equal(snapshot.status, 200);
  });
  await t.test("クーポン案は実際の送料5,000円基準を使い，原価・資格を偽装せず試算だけ行う",async()=>{
    const path="/api/admin/simulations/coupon";
    const viewer=await signIn("member@example.invalid");
    const body={kind:"supporter",items:[{sku:"HS-COFFEE-MOCHA-5PACK",quantity:1,unitPriceJpy:1}],percent:100,memberEligible:true,parcels:1,packagingJpy:100,laborJpy:100,otherCostsJpy:0};
    assert.equal((await call(path,"",body)).status,401);
    assert.equal((await call(path,viewer.cookie,body)).status,403);
    assert.equal((await call(path,manager.cookie,body,"https://invalid.example")).status,403);
    const result=await call(path,manager.cookie,body);assert.equal(result.status,200,await result.clone().text());
    const value=await result.json() as any;
    assert.equal(value.quote.subtotalJpy,2052);assert.equal(value.quote.discountJpy,400);
    assert.equal(value.quote.shippingJpy,500);assert.equal(value.quote.totalJpy,2152);
    assert.equal(value.afterFeeBudgetJpy,334);assert.equal(value.couponIssued,false);
    assert.equal(value.contribution.coffeeCostAssumption.provisionalCashUnitCostJpy,260);
    const photography = await call(path, manager.cookie, { ...body, kind: "photographer", photoCount: 5, items: [{ sku: "HS-COFFEE-MOCHA-5PACK", quantity: 15 }], maxDiscountJpy: 100000 });
    assert.equal(photography.status, 200);
    const simulated = await photography.json() as any;
    assert.equal(simulated.quote.couponPercent, 50);
    assert.equal(simulated.quote.couponMaxDiscountJpy, 15000);
    assert.equal(simulated.quote.discountJpy, 15000);
    assert.equal(simulated.couponIssued, false);
    assert.equal((await call(path, manager.cookie, { ...body, kind: "photographer", photoCount: "5" })).status, 400);
    assert.equal((await call(path,manager.cookie,{...body,kind:"invalid"})).status,400);
  });
});
