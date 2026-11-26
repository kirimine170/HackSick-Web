import { MEMBER_PRICING } from "./member-pricing.ts";
import { COFFEE_SUBSCRIPTIONS } from "./coffee-subscriptions.ts";

/** 収益モデル案．割引率は共通設定を参照し，他の販売条件や既存契約は自動変更しない． */
export const BUSINESS_POLICY = {
  version: "2026-11-03",
  status: "draft",
  commerce: {
    memberDiscountPercent: MEMBER_PRICING.oneTimeDiscountPercent,
    recurringMemberDiscountPercent: MEMBER_PRICING.recurringDiscountPercent,
    discountCombination: "largest-saving-only",
    freeShippingThresholdJpy: 4000,
    freeShippingBasis: "goods-before-discount-including-tax",
    shippingFeeJpy: 500,
    trialSetMinimumPriceJpy: 980,
  },
  events: { monthlyLtWaiverLimit: 1, hsapAllocationPerWaiverJpy: 1000 },
  gifts: { stickerAtFirstJoin: true, stickerIntervalMonths: 6, speakerStickerPerEvent: 1, coffeeOnlyAtConfirmedFirstTalk: true },
  proposedPlans: {
    studentBundle: { priceJpy: 3280, enabled: false, requiresStudentVerification: true },
    coffeeSubscriptions: COFFEE_SUBSCRIPTIONS,
  },
  pending: {
    hsapFeesJpy: null,
    hsapServiceCostJpy: null,
    stickerUnitCostJpy: null,
    reportUnitCostJpy: null,
    speakersPerEvent: null,
    operatorDiscountForNewMembers: null,
  },
} as const;
