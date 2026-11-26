import { test } from "node:test";
import assert from "node:assert/strict";
import { COFFEE_SUBSCRIPTIONS, previewCoffeeSubscription } from "../src/coffee-subscriptions.ts";
import { memberQuote } from "../src/checkout.ts";

test("税別の定期便料金から会員5％引き，食品8％と共通の送料を計算する", () => {
  const expected = [
    { exTax: 10260, grossBeforeDiscount: 11664, gross: 11080, shipping: 0, total: 11080 },
    { exTax: 7106, grossBeforeDiscount: 8078, gross: 7674, shipping: 0, total: 7674 },
    { exTax: 2660, grossBeforeDiscount: 3024, gross: 2872, shipping: 500, total: 3372 },
  ];
  for (const [index, plan] of COFFEE_SUBSCRIPTIONS.plans.entries()) {
    const member = previewCoffeeSubscription(plan.id, true);
    const regular = previewCoffeeSubscription(plan.id, false);
    assert.equal(member.discountPercent, 5);
    assert.equal(member.goodsExTaxJpy, expected[index].exTax);
    assert.equal(member.subtotalJpy, expected[index].grossBeforeDiscount);
    assert.equal(member.goodsTotalJpy, expected[index].gross);
    assert.equal(member.taxJpy + member.goodsExTaxJpy, member.goodsTotalJpy);
    assert.equal(member.discountJpy, member.subtotalJpy - member.goodsTotalJpy);
    assert.equal(member.priceBasis, "subscription-plan");
    assert.equal(regular.discountJpy, 0);
    assert.equal(regular.goodsExTaxJpy, plan.basePriceExTaxJpy);
    assert.equal(regular.goodsTotalJpy, expected[index].grossBeforeDiscount);
    assert.equal(member.totalJpy, expected[index].total);
    assert.equal(member.shippingJpy, expected[index].shipping);
    assert.equal(regular.shippingJpy, expected[index].shipping);
    assert.equal(member.live, false);
  }
  assert.equal(COFFEE_SUBSCRIPTIONS.checkoutEnabled, false);
  assert.throws(() => previewCoffeeSubscription("unknown", true), /プラン/);
});

test("休日8袋2,800円は，会員単発購入5袋セット＋単品3袋より税込141円安い", () => {
  const oneTime = memberQuote([{ sku: "HS-COFFEE-MOCHA-5PACK", quantity: 1 }, { sku: "HS-COFFEE-MOCHA-10G", quantity: 3 }]);
  const recurring = previewCoffeeSubscription("coffee-weekend-8", true);
  assert.equal(oneTime.subtotalJpy - oneTime.discountJpy, 3013);
  assert.equal((oneTime.subtotalJpy - oneTime.discountJpy) - recurring.goodsTotalJpy, 141);
  assert.equal(oneTime.totalJpy - recurring.totalJpy, 141);
});

test("プランの税別料金は保ち，会員資格・税率・送料が変わった回は支払総額を再計算する", () => {
  const planId = "coffee-weekend-8";
  const member = previewCoffeeSubscription(planId, true);
  const regular = previewCoffeeSubscription(planId, false);
  assert.equal(member.totalJpy, 3372);
  assert.equal(regular.totalJpy, 3524);
  const changedPolicy = { taxPercent: 1, shippingPolicy: { shippingFeeJpy: 600, freeShippingThresholdJpy: 5000 } };
  const nextCycle = previewCoffeeSubscription(planId, true, changedPolicy);
  assert.equal(nextCycle.basePriceExTaxJpy, member.basePriceExTaxJpy);
  assert.equal(nextCycle.goodsExTaxJpy, 2660);
  assert.equal(nextCycle.taxJpy, 26);
  assert.equal(nextCycle.shippingJpy, 600);
  assert.equal(nextCycle.totalJpy, 3286);
  assert.equal(previewCoffeeSubscription(planId, true).totalJpy, 3372);
  assert.throws(() => previewCoffeeSubscription(planId, true, { ...changedPolicy, taxPercent: -1 }), /税率・送料/);
  assert.throws(() => previewCoffeeSubscription(planId, true, { ...changedPolicy, shippingPolicy: { ...changedPolicy.shippingPolicy, shippingFeeJpy: -1 } }), /税率・送料/);
});
