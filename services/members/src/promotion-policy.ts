import { InputError } from "./eligibility.ts";
import { memberQuote } from "./checkout.ts";
import { estimateCoffeeOrder, integer } from "./commerce.ts";

/** 発行前の条件案．Square・会員サイトの有効なクーポンを作成するものではない． */
export const PROMOTION_POLICY = {
  version: "2026-11-07-photography-coupon-draft",
  status: "draft",
  purchaseKind: "one-time",
  validityDaysFromIssue: 30,
  perAccountLimit: 1,
  discountCombination: "largest-saving-only",
  shippingDiscount: false,
  recurringEligible: false,
  trialEligible: false,
  offers: {
    lt: { label: "LT参加者向け", percent: 10, maxDiscountJpy: null },
    supporter: { label: "イベント協力者向け", percent: 20, maxDiscountJpy: 400 },
    photographer: { label: "撮影協力者向け", percent: 50, creditPerPhotoJpy: 3000, validityDaysFromIssue: null, perAccountLimit: null },
  },
} as const;

type PromotionKind = keyof typeof PROMOTION_POLICY.offers;

export function isPromotionKind(kind: unknown): kind is PromotionKind {
  return typeof kind === "string" && Object.hasOwn(PROMOTION_POLICY.offers, kind);
}

export function quotePromotion(items: unknown, kind: PromotionKind, memberEligible: boolean, photoCount?: number) {
  if (!isPromotionKind(kind)) throw new InputError("クーポンの種類を確認してください．");
  if (kind !== "photographer" && photoCount !== undefined) throw new InputError("撮影枚数は撮影協力者向けの試算で指定してください．");
  const offer = PROMOTION_POLICY.offers[kind];
  const base = memberQuote(items);
  const photoCreditJpy = "creditPerPhotoJpy" in offer
    ? integer(offer.creditPerPhotoJpy * integer(photoCount === undefined ? 1 : photoCount, "撮影枚数", 1), "撮影のお礼枠") : null;
  const couponMaxDiscountJpy = "maxDiscountJpy" in offer ? offer.maxDiscountJpy : photoCreditJpy;
  const couponDiscountJpy = Math.min(Math.round(base.subtotalJpy * offer.percent / 100), couponMaxDiscountJpy ?? Infinity);
  const memberDiscountJpy = memberEligible ? base.discountJpy : 0;
  const source = memberDiscountJpy >= couponDiscountJpy ? "membership" : "coupon";
  const discountJpy = Math.max(memberDiscountJpy, couponDiscountJpy);
  return {
    ...base, policyVersion: PROMOTION_POLICY.version, live: false,
    discountPercent: source === "membership" ? base.discountPercent : offer.percent,
    couponKind: kind, couponPercent: offer.percent, couponMaxDiscountJpy,
    photoCreditJpy,
    discountSource: source, couponConsumed: false, couponWouldBeUsed: source === "coupon",
    discountJpy, totalJpy: base.subtotalJpy - discountJpy + base.shippingJpy,
  };
}

export function simulatePromotion(input: {
  items: unknown; kind: PromotionKind; memberEligible: boolean; photoCount?: number;
  parcels: number | null; packagingJpy: number | null; laborJpy: number | null;
  otherCostsJpy: number | null; feeBasisPoints: number | null;
}) {
  const quote = quotePromotion(input.items, input.kind, input.memberEligible, input.photoCount);
  const contribution = estimateCoffeeOrder({
    revenueJpy: quote.totalJpy, coffeeBags: quote.bags, parcels: input.parcels,
    packagingJpy: input.packagingJpy, laborJpy: input.laborJpy, otherCostsJpy: input.otherCostsJpy,
    feeBasisPoints: input.feeBasisPoints,
  });
  // 採算チェックは，概算の四捨五入より1円厳しく，手数料を切り上げて予算化する．
  const feeBudgetJpy = input.feeBasisPoints === null ? null : Math.ceil(quote.totalJpy * input.feeBasisPoints / 10000);
  const feeAllowanceJpy = feeBudgetJpy === null || contribution.paymentFeeJpy === null ? null : feeBudgetJpy - contribution.paymentFeeJpy;
  const afterFeeBudgetJpy = contribution.contributionJpy === null || feeAllowanceJpy === null ? null : contribution.contributionJpy - feeAllowanceJpy;
  return {
    live: false, couponIssued: false, stockReserved: false, quote, contribution,
    feeBudgetJpy, afterFeeBudgetJpy,
    assessment: afterFeeBudgetJpy === null ? contribution.assessment : afterFeeBudgetJpy < 0 ? "loss" : afterFeeBudgetJpy === 0 ? "break-even" : "positive-under-supplied-assumptions",
  };
}
