import { test } from "node:test";
import assert from "node:assert/strict";
import { BUSINESS_POLICY } from "../src/business-policy.ts";
import { quoteOrder, estimateContribution, estimateCoffeeOrder } from "../src/commerce.ts";
import { decideBenefit, continuousMembershipStart, addTokyoMonths, tokyoMonth, type Redemption } from "../src/benefits.ts";
import { eligibility } from "../src/eligibility.ts";
import type { Grant } from "../src/types.ts";

const now = new Date("2026-11-03T12:00:00Z");
const hsap: Grant = { id: "hsap", kind: "HSAP", valid_from: "2026-01-31T15:00:00.000Z", valid_until: null, revoked_at: null, evidence_id: "HSAP-000001" };
const monthly: Grant = { ...hsap, id: "monthly", kind: "MONTHLY", valid_until: "2026-12-01T00:00:00.000Z" };
const context = { eventId: "LT-11", eventAt: now.toISOString() };

test("会員10％とクーポン10％は重ねず，同額なら会員枠を使う", () => {
  const quote = quoteOrder({ lines: [{ sku: "coffee", unitPriceJpy: 432, quantity: 1 }], memberEligible: true, coupon: { id: "LT11", percent: 10 } });
  assert.equal(quote.discountJpy, 43);
  assert.equal(quote.goodsTotalJpy, 389);
  assert.equal(quote.selectedDiscount?.id, "membership");
});

test("割引率が大きくても対象商品の割引額が小さければ採用しない", () => {
  const quote = quoteOrder({ lines: [{ sku: "a", unitPriceJpy: 100, quantity: 1 }, { sku: "b", unitPriceJpy: 1900, quantity: 1 }], memberEligible: true, coupon: { id: "limited", percent: 20, skus: ["a"] } });
  assert.equal(quote.discountJpy, 200);
  assert.equal(quote.selectedDiscount?.id, "membership");
});

test("定期便の会員枠は5％．より大きい有効クーポンがあれば1つだけ採用する", () => {
  const input = { lines: [{ sku: "coffee", unitPriceJpy: 2000, quantity: 1 }], memberEligible: true, recurring: true, priceBasis: "subscription-plan" as const };
  assert.equal(quoteOrder({ ...input, recurring: false }).discountJpy, 200);
  assert.equal(quoteOrder(input).discountJpy, 100);
  const coupon = quoteOrder({ ...input, coupon: { id: "campaign", percent: 10 } });
  assert.equal(coupon.discountJpy, 200);
  assert.equal(coupon.selectedDiscount?.id, "campaign");
});

test("定期便は専用料金から会員5％を引き，通常価格を代用しない", () => {
  const retail = { lines: [{ sku: "coffee", unitPriceJpy: 2000, quantity: 1 }], memberEligible: true };
  assert.equal(quoteOrder(retail).goodsTotalJpy, 1800);
  assert.throws(() => quoteOrder({ ...retail, recurring: true }), /定期便専用/);
  const plan = quoteOrder({ ...retail, lines: [{ sku: "coffee", unitPriceJpy: 1800, quantity: 1 }], recurring: true, priceBasis: "subscription-plan" });
  assert.equal(plan.discountJpy, 90);
  assert.equal(plan.goodsTotalJpy, 1710);
  assert.equal(plan.priceBasis, "subscription-plan");
  assert.equal(quoteOrder({ ...retail, lines: [{ sku: "coffee", unitPriceJpy: 1800, quantity: 1 }], memberEligible: false, recurring: true, priceBasis: "subscription-plan" }).goodsTotalJpy, 1800);
});

test("送料無料4,000円は税込商品代金の割引前で判定する", () => {
  const quote = quoteOrder({ lines: [{ sku: "5pack", unitPriceJpy: 2052, quantity: 2 }], memberEligible: true });
  assert.equal(quote.subtotalJpy, 4104);
  assert.equal(quote.goodsTotalJpy, 3694);
  assert.equal(quote.shippingJpy, 0);
  assert.equal(quote.live, false);
  const boundary = (value: number) => quoteOrder({ lines: [{ sku: "test", unitPriceJpy: value, quantity: 1 }], memberEligible: true });
  assert.equal(boundary(3999).shippingJpy, 500);
  assert.equal(boundary(4000).shippingJpy, 0);
});

test("お試しセットは無料にせず，割引後も1セット980円を下回らない", () => {
  assert.throws(() => quoteOrder({ lines: [{ sku: "trial", unitPriceJpy: 0, quantity: 1, isTrialSet: true }], memberEligible: false }));
  const quote = quoteOrder({ lines: [{ sku: "trial", unitPriceJpy: 980, quantity: 2, isTrialSet: true }, { sku: "coffee", unitPriceJpy: 432, quantity: 1 }], memberEligible: true });
  assert.equal(quote.discountJpy, 43);
  assert.equal(quote.goodsTotalJpy, 2349);
  const coupon = quoteOrder({ lines: [{ sku: "trial", unitPriceJpy: 1200, quantity: 1, isTrialSet: true }], memberEligible: true, coupon: { id: "free", percent: 100 } });
  assert.equal(coupon.goodsTotalJpy, 980);
});

test("粗利には送料の売上も含め，手数料も送料込みで見積もる．未知原価は黒字にしない", () => {
  const result = estimateCoffeeOrder({ revenueJpy: 889, coffeeBags: 1, parcels: 1, packagingJpy: 40, laborJpy: 100, otherCostsJpy: 0, feeBasisPoints: 360 });
  assert.equal(result.paymentFeeJpy, 32);
  assert.equal(result.contributionJpy, 217);
  const unknown = estimateCoffeeOrder({ revenueJpy: 3694, coffeeBags: 10, parcels: null, packagingJpy: null, laborJpy: null, otherCostsJpy: null, feeBasisPoints: 360 });
  assert.equal(unknown.assessment, "incomplete");
  assert.equal(unknown.contributionJpy, null);
  assert.ok(unknown.missingCosts.includes("発送費"));
});

test("手数料3.6％，免除1回あたり機会費用1,000円という試算の赤字を再現する", () => {
  const margin = (revenue: number, waived: number) => estimateContribution({ revenueJpy: revenue, feeBasisPoints: 360, costs: [{ name: "LT参加費の機会費用", amountJpy: waived * 1000, kind: "opportunity" }] }).contributionJpy;
  assert.equal(margin(1500, 2), -554);
  assert.equal(margin(1500, 4), -2554);
  assert.equal(margin(3000, 4), -1108);
  const waived = estimateContribution({ revenueJpy: 1500, feeBasisPoints: 360, costs: [{ name: "免除の機会費用", amountJpy: 2000, kind: "opportunity" }] });
  assert.equal(waived.cashContributionJpy, 1446);
  assert.equal(waived.knownOpportunityCostsJpy, 2000);
  const free = estimateCoffeeOrder({ revenueJpy: 0, coffeeBags: 3, parcels: 1, packagingJpy: null, laborJpy: null, otherCostsJpy: null, feeBasisPoints: 360 });
  assert.equal(free.upperBoundContributionJpy, -1020);
  assert.equal(free.assessment, "loss");
});

test("HSAP配賦は団体全体の負担を消さず，学生セットも原価未確定なら判定しない", () => {
  const allocated = estimateContribution({ revenueJpy: 0, feeBasisPoints: 0, costs: [{ name: "実費", amountJpy: 1000 }, { name: "HSAP配賦", amountJpy: 1000, kind: "internal-allocation" }] });
  assert.equal(allocated.contributionJpy, -1000);
  assert.equal(allocated.internalAllocationJpy, 1000);
  assert.equal(BUSINESS_POLICY.proposedPlans.studentBundle.enabled, false);
  const student = estimateContribution({ revenueJpy: BUSINESS_POLICY.proposedPlans.studentBundle.priceJpy, feeBasisPoints: 360, costs: [{ name: "参加費免除", amountJpy: 1000, kind: "opportunity" }, { name: "HSAPの実原価", amountJpy: BUSINESS_POLICY.pending.hsapServiceCostJpy }, { name: "ステッカー", amountJpy: BUSINESS_POLICY.pending.stickerUnitCostJpy }] });
  assert.equal(student.assessment, "incomplete");
  assert.equal(student.contributionJpy, null);
});

test("LT免除は資格を横断して日本時間の月1回，HSAP分だけ内部配賦する", () => {
  const input = { kind: "LT_WAIVER" as const, memberStatus: "active", grants: [hsap], redemptions: [] as Redemption[], context };
  const first = decideBenefit(input, now);
  assert.equal(first.allowed, true);
  if (!first.allowed) return;
  assert.equal(first.internalAllocationJpy, 1000);
  const used: Redemption[] = [{ kind: "LT_WAIVER", benefit_key: first.key, event_id: "LT-11" }];
  assert.equal(decideBenefit({ ...input, grants: [monthly, hsap], redemptions: used, context: { ...context, eventId: "LT-12" } }, now).allowed, false);
  const both = decideBenefit({ ...input, grants: [monthly, hsap] }, now);
  assert.equal(both.allowed && both.funding, "MONTHLY");
  assert.equal(both.allowed && both.internalAllocationJpy, 0);
  assert.equal(tokyoMonth(new Date("2026-11-30T14:59:59Z")), "2026-11");
  assert.equal(tokyoMonth(new Date("2026-11-30T15:00:00Z")), "2026-12");
});

test("継続月数は資格の重複で増えず，中断があれば再開時から数える", () => {
  const jan = { ...monthly, valid_from: "2026-01-01T00:00:00.000Z", valid_until: "2026-02-01T00:00:00.000Z" };
  const feb = { ...monthly, valid_from: jan.valid_until, valid_until: "2026-12-01T00:00:00.000Z" };
  assert.equal(continuousMembershipStart([jan, feb, feb], now), jan.valid_from);
  const gap = { ...feb, valid_from: "2026-02-01T00:00:01.000Z" };
  assert.equal(continuousMembershipStart([jan, gap], now), gap.valid_from);
  assert.equal(addTokyoMonths("2026-08-30T15:00:00.000Z", 6), "2027-02-27T15:00:00.000Z");
  assert.equal(addTokyoMonths("2023-08-30T15:00:00.000Z", 6), "2024-02-28T15:00:00.000Z");
});

test("入会ステッカーは本人ごと1回，継続ステッカーは6か月ごとに重複防止する", () => {
  const input = { memberStatus: "active", grants: [hsap], redemptions: [] as Redemption[] };
  assert.equal(decideBenefit({ ...input, kind: "JOIN_STICKER" }, now).allowed, true);
  assert.equal(decideBenefit({ ...input, kind: "JOIN_STICKER", redemptions: [{ kind: "JOIN_STICKER", benefit_key: "first-join", event_id: null }] }, now).allowed, false);
  const loyalty = decideBenefit({ ...input, kind: "LOYALTY_STICKER" }, now);
  assert.equal(loyalty.allowed, true);
  if (!loyalty.allowed) return;
  assert.equal(loyalty.key, "2026-07-31T15:00:00.000Z");
  assert.equal(decideBenefit({ ...input, kind: "LOYALTY_STICKER", redemptions: [{ kind: "LOYALTY_STICKER", benefit_key: loyalty.key, event_id: null }] }, now).allowed, false);
});

test("登壇者の珈琲は初登壇の明示確認が必要で，1人1回だけ", () => {
  const input = { kind: "FIRST_TALK_COFFEE" as const, memberStatus: "active", grants: [], redemptions: [] as Redemption[], context: { ...context, speakerConfirmed: true } };
  assert.equal(decideBenefit(input, now).allowed, false);
  assert.equal(decideBenefit({ ...input, context: { ...input.context, firstTalkConfirmed: true } }, now).allowed, true);
  assert.equal(decideBenefit({ ...input, context: { ...input.context, firstTalkConfirmed: true }, redemptions: [{ kind: "FIRST_TALK_COFFEE", benefit_key: "first-talk", event_id: "LT-10" }] }, now).allowed, false);
});

test("開催時点の資格判定は，後日の退会によって過去の在籍を消さない", () => {
  const revoked = { ...hsap, revoked_at: "2026-11-02T00:00:00.000Z" };
  assert.equal(eligibility("active", [revoked], new Date("2026-11-01T00:00:00Z")).eligible, true);
  assert.equal(eligibility("active", [revoked], now).eligible, false);
});
