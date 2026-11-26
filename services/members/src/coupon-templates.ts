export const COUPON_TEMPLATES = {
  lt: { label: "LT参加者向け", percent: 10, maxDiscountJpy: null },
  supporter: { label: "イベント協力者向け", percent: 20, maxDiscountJpy: 400 },
  photographer: { label: "撮影協力者向け", percent: 35, creditPerPhotoJpy: 3000, validityDaysFromIssue: null, perAccountLimit: null },
} as const;

export type PromotionKind = keyof typeof COUPON_TEMPLATES;

export function isPromotionKind(kind: unknown): kind is PromotionKind {
  return typeof kind === "string" && Object.hasOwn(COUPON_TEMPLATES, kind);
}
