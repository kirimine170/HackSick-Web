import { MEMBER_PRICING } from "./member-pricing.ts";
import { SHIPPING_POLICY } from "./shipping-policy.ts";

// 2026年11月6日，税別価格・通常購入と同じ送料で確認済み．
// 受付の有効化は環境設定と実際のSquare許可スコープで別途判定する．
export const COFFEE_SUBSCRIPTIONS = {
  version: "2026-11-07-coffee-recurring",
  status: "configured",
  pricingStatus: "confirmed",
  currency: "JPY",
  taxTreatment: "exclusive",
  shippingTreatment: "exclusive",
  totalCalculation: "per-charge",
  taxPercent: 8,
  rounding: "discount-nearest-yen-tax-floor",
  shippingPolicy: SHIPPING_POLICY,
  billingCadence: "MONTHLY",
  checkoutEnabled: MEMBER_PRICING.recurringCheckoutEnabled,
  operationsDraft: {
    status: "confirmed",
    timezone: "Asia/Tokyo",
    cutoff: "month-end",
    billingDayOfMonth: 1,
    shipmentAroundDayOfMonth: 10,
    prorate: false,
    midCycleTrial: { bags: 3, basePriceExTaxJpy: 980, shippingJpy: 500, memberDiscountPercent: 0 },
    pending: [],
  },
  plans: [
    { id: "coffee-daily-30", name: "毎日HackSickプラン", bags: 30, basePriceExTaxJpy: 10800 },
    { id: "coffee-weekday-20", name: "平日HackSickプラン", bags: 20, basePriceExTaxJpy: 7480 },
    { id: "coffee-weekend-8", name: "休日HackSickプラン", bags: 8, basePriceExTaxJpy: 2800 },
  ],
} as const;

export interface SubscriptionPricingContext {
  taxPercent: number;
  shippingPolicy: { shippingFeeJpy: number; freeShippingThresholdJpy: number };
}

/** 料金比較専用．その回の税率・送料・本人の会員資格をサーバーで確定して渡す．決済は実行しない． */
export function previewCoffeeSubscription(planId: string, memberEligible: boolean, pricing: SubscriptionPricingContext = { taxPercent: COFFEE_SUBSCRIPTIONS.taxPercent, shippingPolicy: SHIPPING_POLICY }) {
  const plan = COFFEE_SUBSCRIPTIONS.plans.find(candidate => candidate.id === planId);
  if (!plan) throw new RangeError("定期便のプランを確認してください．");
  const { taxPercent, shippingPolicy } = pricing;
  if (!Number.isSafeInteger(taxPercent) || taxPercent < 0 || taxPercent > 100 ||
      !Number.isSafeInteger(shippingPolicy.shippingFeeJpy) || shippingPolicy.shippingFeeJpy < 0 ||
      !Number.isSafeInteger(shippingPolicy.freeShippingThresholdJpy) || shippingPolicy.freeShippingThresholdJpy < 0) throw new RangeError("その回の税率・送料条件を確認してください．");
  const discountPercent = memberEligible ? MEMBER_PRICING.recurringDiscountPercent : 0;
  const discountExTaxJpy = Math.round(plan.basePriceExTaxJpy * discountPercent / 100);
  const goodsExTaxJpy = plan.basePriceExTaxJpy - discountExTaxJpy;
  const taxJpy = Math.floor(goodsExTaxJpy * taxPercent / 100);
  const goodsTotalJpy = goodsExTaxJpy + taxJpy;
  const subtotalJpy = plan.basePriceExTaxJpy + Math.floor(plan.basePriceExTaxJpy * taxPercent / 100);
  const shippingJpy = subtotalJpy >= shippingPolicy.freeShippingThresholdJpy ? 0 : shippingPolicy.shippingFeeJpy;
  return {
    ...plan,
    status: COFFEE_SUBSCRIPTIONS.status,
    live: false,
    priceBasis: MEMBER_PRICING.recurringPriceBasis,
    taxTreatment: COFFEE_SUBSCRIPTIONS.taxTreatment,
    shippingTreatment: COFFEE_SUBSCRIPTIONS.shippingTreatment,
    totalCalculation: COFFEE_SUBSCRIPTIONS.totalCalculation,
    taxPercent,
    subtotalJpy,
    discountPercent,
    discountExTaxJpy,
    discountJpy: subtotalJpy - goodsTotalJpy,
    goodsExTaxJpy,
    taxJpy,
    goodsTotalJpy,
    shippingJpy,
    totalJpy: goodsTotalJpy + shippingJpy,
  } as const;
}

export function trialPricing() {
  const trial = COFFEE_SUBSCRIPTIONS.operationsDraft.midCycleTrial;
  const taxJpy = Math.floor(trial.basePriceExTaxJpy * COFFEE_SUBSCRIPTIONS.taxPercent / 100);
  return { bags: trial.bags, basePriceExTaxJpy: trial.basePriceExTaxJpy, discountPercent: 0, discountExTaxJpy: 0, taxJpy, goodsTotalJpy: trial.basePriceExTaxJpy + taxJpy, shippingJpy: trial.shippingJpy, totalJpy: trial.basePriceExTaxJpy + taxJpy + trial.shippingJpy };
}
