import { mkdir, cp, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { COFFEE_SUBSCRIPTIONS, previewCoffeeSubscription, trialPricing } from "../src/coffee-subscriptions.ts";
import { memberQuote, SHOP_PRODUCTS } from "../src/checkout.ts";
import { MEMBER_PRICING } from "../src/member-pricing.ts";

const yen = amount => `${amount.toLocaleString("ja-JP")}円`;
const trial = trialPricing();
const rows = COFFEE_SUBSCRIPTIONS.plans.map(plan => {
  const standard = previewCoffeeSubscription(plan.id, false);
  const member = previewCoffeeSubscription(plan.id, true);
  const [single, pack] = SHOP_PRODUCTS;
  const items = [pack, single].map(product => ({
    sku: product.sku,
    quantity: product === pack ? Math.floor(plan.bags / pack.bags) : plan.bags % pack.bags,
  })).filter(item => item.quantity > 0);
  return { plan, standard, member, oneTime: memberQuote(items) };
});
const weekday = rows.find(row => row.plan.id === "coffee-weekday-20");
const comparison = `<table class="coffee-comparison">
  <caption>通常便の月額（税込・送料込み）</caption>
  <thead><tr><th scope="col">プラン</th><th scope="col">通常</th><th scope="col">会員</th></tr></thead>
  <tbody>
    ${rows.map(({plan, standard, member}) => `<tr><th scope="row">${plan.name.replace("HackSickプラン", "")}<br><small>月${plan.bags}袋</small></th><td>${yen(standard.totalJpy)}<br><small>約${yen(Math.round(standard.totalJpy / plan.bags))}／袋</small></td><td>${yen(member.totalJpy)}<br><small>約${yen(Math.round(member.totalJpy / plan.bags))}／袋</small></td></tr>`).join("\n    ")}
  </tbody>
</table>
<p class="small">HSAP・HackSick月額会員は，珈琲の単発購入が${MEMBER_PRICING.oneTimeDiscountPercent}％引き，通常便の基本料金が${MEMBER_PRICING.recurringDiscountPercent}％引きです．会員が20袋を1回だけ買う場合，5袋セット4つで${yen(weekday.oneTime.totalJpy)}です．</p>
<dl id="coffee-public-timeline" class="coffee-timeline">
  <div><dt>申込時</dt><dd>お試し${trial.bags}袋・${yen(trial.totalJpy)}（税込・送料込み）を決済し，5日以内を目安に出荷します．お試し便は会員割引の対象外です．</dd></div>
  <div><dt>翌月から</dt><dd>毎月1日に通常便の料金を自動決済し，10日ごろに出荷します．</dd></div>
</dl>`;

await mkdir("dist", { recursive: true });
await cp("public", "dist", { recursive: true });
const html = await readFile("public/index.html", "utf8");
await writeFile("dist/index.html", html.replace("<!-- coffee-plan-comparison -->", comparison));
await cp("../../public/images/works/anokoto-no-kankeisei-ni-tsuite-640.webp", "dist/images/anokoto-cover.webp");
await build({ entryPoints: { app: "src/client.ts", shipping: "src/shipping-client.ts" }, outdir: "dist", bundle: true, format: "esm", target: "es2022", minify: true });
