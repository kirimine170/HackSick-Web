// 割引率は購入方式で決める．HSAP／月額会員という資格の種類では変えない．
export const MEMBER_PRICING = {
  oneTimeDiscountPercent: 10,
  recurringDiscountPercent: 5,
  recurringPriceBasis: "subscription-plan",
  recurringCheckoutEnabled: false,
} as const;
