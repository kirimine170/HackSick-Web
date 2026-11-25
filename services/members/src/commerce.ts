import { BUSINESS_POLICY } from "./business-policy.ts";
import { InputError } from "./eligibility.ts";
import { MEMBER_PRICING } from "./member-pricing.ts";
import { COFFEE_COST_POLICY } from "./coffee-cost-policy.ts";

export interface PriceLine {
  sku: string;
  unitPriceJpy: number;
  quantity: number;
  isTrialSet?: boolean;
}
export interface DiscountOffer { id: string; percent: number; skus?: readonly string[] }

export function integer(value: number, name: string, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) throw new InputError(`${name}を確認してください．`);
  return value;
}

/** サーバーが確定した税込価格・会員資格・クーポンだけを渡す．決済の作成は行わない． */
export function quoteOrder(input: { lines: PriceLine[]; memberEligible: boolean; recurring?: boolean; priceBasis?: "retail" | "subscription-plan"; coupon?: DiscountOffer }) {
  // 定期便は専用プランの料金を入力する．通常商品価格をそのまま使う呼び出しは止める．
  if (input.recurring && input.priceBasis !== MEMBER_PRICING.recurringPriceBasis) throw new InputError("定期便専用の基本料金を設定してから試算してください．");
  if (!input.lines.length) throw new InputError("商品を指定してください．");
  const lines = input.lines.map(line => {
    integer(line.unitPriceJpy, "価格"); integer(line.quantity, "数量", 1);
    if (line.isTrialSet && line.unitPriceJpy < BUSINESS_POLICY.commerce.trialSetMinimumPriceJpy) throw new InputError("お試しセットの表示価格は980円以上にしてください．");
    return { ...line, subtotalJpy: integer(line.unitPriceJpy * line.quantity, "商品代金") };
  });
  const subtotalJpy = integer(lines.reduce((sum, line) => sum + line.subtotalJpy, 0), "商品代金合計");
  const offers: DiscountOffer[] = [];
  if (input.memberEligible) offers.push({ id: "membership", percent: input.recurring ? BUSINESS_POLICY.commerce.recurringMemberDiscountPercent : BUSINESS_POLICY.commerce.memberDiscountPercent });
  if (input.coupon) offers.push(input.coupon);
  let selected: { id: string; percent: number; amountJpy: number } | null = null;
  for (const offer of offers) {
    integer(offer.percent, "割引率");
    if (offer.percent > 100 || !offer.id) throw new InputError("割引条件を確認してください．");
    const saving = lines.filter(line => !offer.skus || offer.skus.includes(line.sku)).reduce((sum, line) => {
      const floor = line.isTrialSet ? BUSINESS_POLICY.commerce.trialSetMinimumPriceJpy * line.quantity : 0;
      return sum + Math.min(line.subtotalJpy * offer.percent / 100, line.subtotalJpy - floor);
    }, 0);
    const amountJpy = Math.round(saving);
    // 同額なら会員特典を優先し，クーポンを消費しない．対象商品が違う場合も割引額で比較する．
    if (amountJpy > (selected?.amountJpy ?? 0)) selected = { id: offer.id, percent: offer.percent, amountJpy };
  }
  const discountJpy = selected?.amountJpy ?? 0;
  const goodsTotalJpy = subtotalJpy - discountJpy;
  const shippingJpy = subtotalJpy >= BUSINESS_POLICY.commerce.freeShippingThresholdJpy ? 0 : BUSINESS_POLICY.commerce.shippingFeeJpy;
  return { policyVersion: BUSINESS_POLICY.version, live: false, priceBasis: input.recurring ? MEMBER_PRICING.recurringPriceBasis : "retail", subtotalJpy, discountJpy, selectedDiscount: selected, goodsTotalJpy, shippingJpy, totalJpy: integer(goodsTotalJpy + shippingJpy, "注文合計") };
}

export interface CostLine { name: string; amountJpy: number | null; kind?: "cash" | "opportunity" | "internal-allocation" }

/** 未確定原価を0円に置き換えない．内部配賦は団体全体の利益に加減しない． */
export function estimateContribution(input: { revenueJpy: number; feeBasisPoints: number | null; costs: CostLine[] }) {
  integer(input.revenueJpy, "売上");
  if (input.feeBasisPoints !== null) { integer(input.feeBasisPoints, "決済手数料率"); if (input.feeBasisPoints > 10000) throw new InputError("決済手数料率を確認してください．"); }
  const missing = input.feeBasisPoints === null ? ["決済手数料率"] : [];
  const paymentFeeJpy = input.feeBasisPoints === null ? null : Math.round(input.revenueJpy * input.feeBasisPoints / 10000);
  let knownCostsJpy = paymentFeeJpy ?? 0;
  let knownCashCostsJpy = paymentFeeJpy ?? 0;
  let knownOpportunityCostsJpy = 0;
  const missingCashCosts = input.feeBasisPoints === null ? ["決済手数料率"] : [];
  let internalAllocationJpy: number | null = 0;
  for (const cost of input.costs) {
    if (cost.amountJpy !== null) integer(cost.amountJpy, cost.name);
    if (cost.kind === "internal-allocation") { internalAllocationJpy = cost.amountJpy === null || internalAllocationJpy === null ? null : internalAllocationJpy + cost.amountJpy; continue; }
    if (cost.amountJpy === null) {
      missing.push(cost.name);
      if (cost.kind !== "opportunity") missingCashCosts.push(cost.name);
    } else {
      knownCostsJpy += cost.amountJpy;
      if (cost.kind === "opportunity") knownOpportunityCostsJpy += cost.amountJpy; else knownCashCostsJpy += cost.amountJpy;
    }
  }
  const upperBoundContributionJpy = input.revenueJpy - knownCostsJpy;
  return {
    paymentFeeJpy, knownCostsJpy, knownCashCostsJpy, knownOpportunityCostsJpy, internalAllocationJpy, missingCosts: missing,
    cashContributionJpy: missingCashCosts.length ? null : input.revenueJpy - knownCashCostsJpy,
    contributionJpy: missing.length ? null : upperBoundContributionJpy,
    upperBoundContributionJpy,
    assessment: upperBoundContributionJpy < 0 ? "loss" : missing.length ? "incomplete" : upperBoundContributionJpy === 0 ? "break-even" : "positive-contribution",
  };
}

export function estimateCoffeeOrder(input: { revenueJpy: number; coffeeBags: number; parcels: number | null; packagingJpy: number | null; laborJpy: number | null; otherCostsJpy: number | null; feeBasisPoints: number | null }) {
  integer(input.coffeeBags, "珈琲の袋数");
  if (input.parcels !== null) integer(input.parcels, "梱包数");
  const result = estimateContribution({
    revenueJpy: input.revenueJpy,
    feeBasisPoints: input.feeBasisPoints,
    costs: [
      { name: "珈琲仕入（保守的な仮置き）", amountJpy: COFFEE_COST_POLICY.provisionalCashUnitCostJpy * input.coffeeBags },
      { name: "発送費", amountJpy: input.parcels === null ? null : 240 * input.parcels },
      { name: "梱包費", amountJpy: input.packagingJpy },
      { name: "作業人件費", amountJpy: input.laborJpy },
      { name: "その他配賦原価", amountJpy: input.otherCostsJpy },
    ],
  });
  return { ...result, coffeeCostAssumption: COFFEE_COST_POLICY };
}
