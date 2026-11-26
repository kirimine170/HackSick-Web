import { test } from "node:test";
import assert from "node:assert/strict";
import { quotePromotion, simulatePromotion, PROMOTION_POLICY } from "../src/promotion-policy.ts";
import { COFFEE_COST_POLICY } from "../src/coffee-cost-policy.ts";
import { estimateCoffeeOrder } from "../src/commerce.ts";

const single = "HS-COFFEE-MOCHA-10G", pack = "HS-COFFEE-MOCHA-5PACK";
const items = (singles:number,packs:number) => [
  ...(singles?[{sku:single,quantity:singles}]:[]), ...(packs?[{sku:pack,quantity:packs}]:[]),
];
test("原価は旧180円でなく，400円の60％を基準に税を保守的に仮置きする",()=>{
  assert.equal(COFFEE_COST_POLICY.purchaseBasisJpy,240);
  assert.equal(COFFEE_COST_POLICY.purchaseTaxTreatment,"unconfirmed");
  assert.equal(COFFEE_COST_POLICY.provisionalCashUnitCostJpy,260);
  const quote=quotePromotion(items(1,0),"supporter",false);
  assert.equal(quote.subtotalJpy,432);assert.equal(quote.discountJpy,86);
  assert.equal(quote.shippingJpy,500);assert.equal(quote.totalJpy,846);
  assert.equal(PROMOTION_POLICY.status,"draft");assert.equal(PROMOTION_POLICY.validityDaysFromIssue,30);
});
test("協力者20％案は値引き400円で止め，会員特典の方が大きければクーポンを消費しない",()=>{
  const set=quotePromotion(items(0,1),"supporter",false);
  assert.equal(set.discountJpy,400);assert.equal(set.totalJpy,2152);
  const same=quotePromotion(items(1,0),"lt",true);
  assert.equal(same.discountSource,"membership");assert.equal(same.couponWouldBeUsed,false);
  const member=quotePromotion(items(0,3),"supporter",true);
  assert.equal(member.discountSource,"membership");assert.equal(member.discountJpy,616);
  assert.equal(member.couponConsumed,false);
  assert.throws(()=>quotePromotion(items(1,0),"__proto__" as never,false),/種類/);
});
test("撮影協力者は送料を除く商品代金を35％引きし，撮影枚数に応じた枠で止める", () => {
  const pack = quotePromotion(items(0, 1), "photographer", true);
  assert.equal(pack.discountSource, "coupon");
  assert.equal(pack.discountJpy, 718);
  assert.equal(pack.totalJpy, 1834);

  const onePhoto = quotePromotion(items(0, 5), "photographer", false, 1);
  assert.equal(onePhoto.discountJpy, 3000);
  assert.equal(onePhoto.totalJpy, 7260);

  const fivePhotos = quotePromotion(items(0, 22), "photographer", false, 5);
  assert.equal(fivePhotos.photoCreditJpy, 15000);
  assert.equal(fivePhotos.discountJpy, 15000);
  assert.equal(fivePhotos.totalJpy, 30144);
  assert.equal(fivePhotos.couponConsumed, false);

  assert.throws(() => quotePromotion(items(0, 1), "photographer", false, 0), /撮影枚数/);
  assert.throws(() => quotePromotion(items(0, 1), "lt", false, 5), /撮影枚数/);
});
test("送料無料境界で，上限なし20％の赤字と，上限400円案の差を検証する",()=>{
  const cart=items(1,3),quote=quotePromotion(cart,"supporter",false);
  assert.equal(quote.shippingJpy,0);
  const costs={coffeeBags:16,parcels:4,packagingJpy:400,laborJpy:100,otherCostsJpy:0,feeBasisPoints:360};
  const uncapped=estimateCoffeeOrder({...costs,revenueJpy:quote.subtotalJpy-Math.round(quote.subtotalJpy*.2)});
  assert.ok(uncapped.contributionJpy!<0);
  const capped=simulatePromotion({...costs,items:cart,kind:"supporter",memberEligible:false});
  assert.equal(capped.afterFeeBudgetJpy,345);assert.equal(capped.couponIssued,false);assert.equal(capped.stockReserved,false);
});
test("未確認の梱包費・作業費を0円として採算を確定しない",()=>{
  const result=simulatePromotion({items:items(0,1),kind:"supporter",memberEligible:false,parcels:null,packagingJpy:null,laborJpy:null,otherCostsJpy:null,feeBasisPoints:360});
  assert.equal(result.afterFeeBudgetJpy,null);assert.equal(result.assessment,"incomplete");
  assert.ok(result.contribution.missingCosts.includes("梱包費"));assert.equal(result.live,false);
});
test("LTとイベント協力者の案は，指定した原価・梱包条件で全数量の採算を確かめる",()=>{
  // 5袋/梱包・梱包100円/個・作業100円/注文という仮定を変えれば，結論も再計算する．
  let minimum=Infinity;
  for(let singles=0;singles<=100;singles++)for(let packs=0;packs<=100;packs++){
    if(!singles&&!packs)continue;
    const parcels=Math.ceil((singles+packs*5)/5);
    for(const kind of ["lt","supporter"] as const)for(const memberEligible of [true,false]){
      const result=simulatePromotion({items:items(singles,packs),kind,memberEligible,parcels,packagingJpy:parcels*100,laborJpy:100,otherCostsJpy:0,feeBasisPoints:360});
      minimum=Math.min(minimum,result.afterFeeBudgetJpy!);
    }
  }
  assert.equal(minimum,95);
});
