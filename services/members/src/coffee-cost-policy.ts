/** 2026年11月7日の原価訂正．税・付随費用は未確認なので，現金支払額を保守的に仮置きする． */
export const COFFEE_COST_POLICY = {
  version: "2026-11-07-retail-60-percent",
  retailUnitExTaxJpy: 400,
  purchasePercentOfRetail: 60,
  purchaseBasisJpy: 240,
  purchaseTaxTreatment: "unconfirmed",
  assumedPurchaseTaxPercent: 8,
  provisionalCashUnitCostJpy: 260,
  status: "conservative-estimate",
  excludes: ["仕入時の送料・手数料", "梱包費", "作業人件費", "その他経費"],
} as const;
