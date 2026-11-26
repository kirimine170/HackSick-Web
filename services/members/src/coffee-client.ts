const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const money = (value: number) => `${value.toLocaleString("ja-JP")}円`;
const text = (tag: string, value: string, className = "") => { const node=document.createElement(tag);node.textContent=value;node.className=className;return node; };
interface Price { basePriceExTaxJpy:number; discountExTaxJpy?:number; discountPercent:number; goodsTotalJpy:number; taxJpy:number; shippingJpy:number; totalJpy:number }
interface CoffeeConfig { enabled:boolean;needsAuthorization:boolean;termsVersion:string;eligible:boolean;plans:{id:string;name:string;bags:number;basePriceExTaxJpy:number;quote:Price}[];trial:Price;nextBillingDate:string;applicationId:string;locationId:string;environment:string;buyerEmail:string }
interface Recipient { display_name:string;phone_number:string;email_address:string;address:{country:string;postal_code:string;administrative_district_level_1:string;locality:string;address_line_1:string;address_line_2?:string} }
interface Enrollment { id:string;planId:string;state:string;nextBillingDate:string;shipping:Recipient;card:{brand:string;last4:string}|null;trial:Price;nextQuote:Price;orders:{id:string;state:string;kind:string;quote:Price&{fulfillmentHint?:string}}[] }
type Card = { attach(selector:string):Promise<void>;tokenize(details:Record<string,unknown>):Promise<{status:string;token?:string}>;destroy():Promise<void> };
let config:CoffeeConfig;
let initialized=false;
let card:Card|null=null;
let rootRequestId=crypto.randomUUID();
let busy=false;
let action:{enrollment:Enrollment;mode:"pay"|"card";amount:number;requestId:string}|null=null;
const message=(value:string)=>{el("coffee-message").textContent=value;};
async function api<T>(path:string,body?:unknown):Promise<T>{const response=await fetch(path,body===undefined?{cache:"no-store"}:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});const value=await response.json() as T&{error?:string};if(!response.ok)throw Error(value.error??"処理を完了できませんでした．");return value;}
function priceList(price:Price){
  const list=document.createElement("dl");list.className="price-summary";
  const rows:[string,number][]=[["基本料金（税別）",price.basePriceExTaxJpy]];
  if(price.discountPercent>0)rows.push([`会員特典${price.discountPercent}％`,-(price.discountExTaxJpy??0)]);
  rows.push(["商品にかかる税",price.taxJpy],["送料",price.shippingJpy],["支払総額（税込）",price.totalJpy]);
  for(const[label,value]of rows)list.append(text("dt",label),text("dd",money(value)));
  return list;
}
function showPlan() {
  const plan = config.plans.find(item => item.id === el<HTMLSelectElement>("coffee-plan").value);
  if (!plan) return;
  const timeline = text("dl", "", "coffee-timeline");
  for (const [label, description] of [
    ["申込時のお支払い", `${money(config.trial.totalJpy)}（税込・送料込み）．お試し便は決済後5日以内を目安に出荷します．`],
    ["通常便のお支払い", `月${money(plan.quote.totalJpy)}（税込・送料込み）．初回は${config.nextBillingDate}に決済し，10日ごろ出荷します．`],
  ]) {
    const step = document.createElement("div");
    step.append(text("dt", label), text("dd", description));
    timeline.append(step);
  }
  const details = document.createElement("details");
  details.append(text("summary", "通常便の料金内訳"), priceList(plan.quote));
  el("coffee-price").replaceChildren(timeline, details);
}
async function loadCard(){
  if(card)return;
  if(!window.Square)await new Promise<void>((resolve,reject)=>{const script=document.createElement("script");script.src=config.environment==="production"?"https://web.squarecdn.com/v1/square.js":"https://sandbox.web.squarecdn.com/v1/square.js";script.onload=()=>resolve();script.onerror=()=>reject(Error("カード入力欄を読み込めませんでした．再読み込みしてください．"));document.head.append(script);});
  if(!window.Square)throw Error("カード入力欄を読み込めませんでした．");
  const candidate=await window.Square.payments(config.applicationId,config.locationId).card();
  try{await candidate.attach("#coffee-card");card=candidate;}
  catch{await candidate.destroy().catch(()=>{});throw Error("カード入力欄を読み込めませんでした．接続を確認して再読み込みしてください．");}
}
function updatePayButton(){el<HTMLButtonElement>("coffee-pay").disabled=busy||!card||!action||!config.enabled||!el<HTMLInputElement>("coffee-pay-confirm").checked;}
async function beginPayment(enrollment:Enrollment,mode:"pay"|"card"){
  const trialPaid=enrollment.orders.some(order=>order.kind==="coffee-trial"&&order.state==="paid");
  const price=mode==="card"?null:trialPaid?enrollment.nextQuote:enrollment.trial;
  action={enrollment,mode,amount:price?.totalJpy??0,requestId:crypto.randomUUID()};
  el("coffee-payment").hidden=false;el<HTMLInputElement>("coffee-pay-confirm").checked=false;
  el("coffee-payment-title").textContent=mode==="card"?"定期便のカード登録・変更":trialPaid?"通常便のお支払いを確認":"お試し便のお支払いと定期便のお申込み";
  const summary=el("coffee-payment-summary");summary.replaceChildren();
  const plan=config.plans.find(plan=>plan.id===enrollment.planId);
  summary.append(text("h4",`${plan?.name??"珈琲定期便"}／通常便は毎月${plan?.bags??""}袋`));
  if(price)summary.append(text("h4",trialPaid?"今回の通常便":"今回のお試し便・3袋"),priceList(price));
  else summary.append(text("p","この操作で商品代金は請求しません．Squareでカードの有効性を確認し，次回以降のお支払いに使うカードを保存します．"));
  if(!trialPaid||mode==="card")summary.append(text("h4","次回以降の通常便（現時点の試算）"),priceList(enrollment.nextQuote));
  summary.append(text("p",`通常便は${enrollment.nextBillingDate}から毎月1日に自動決済し，10日ごろ発送します．日割りはありません．初回のお試し便は決済後5日以内を目安に出荷します．`));
  summary.append(text("p","継続回数の縛りはなく，次回の請求処理開始までに定期便の管理欄から解約できます．会員資格を失った回は通常料金です．基本料金・送料条件の変更時，在庫不足時，決済結果不明時は自動請求を止めます．","small"));
  summary.append(text("p","食品のためお客様都合の返品・交換はお受けできません．不良品・誤配送はHackSick負担で対応します．支払済み注文の取消・返金はshop@hacksick.comへご相談ください．","small"));
  const address=enrollment.shipping.address;
  summary.append(text("p",`お届け先：${enrollment.shipping.display_name}／〒${address.postal_code} ${address.administrative_district_level_1}${address.locality}${address.address_line_1} ${address.address_line_2??""}`,"small"));
  el("coffee-pay").textContent=mode==="card"?"Squareにカードを保存する":`${money(action.amount)}を支払い，カードを保存する`;
  await loadCard();updatePayButton();el("coffee-payment").scrollIntoView({behavior:"smooth",block:"start"});
}
async function refreshEnrollments(){
  const result=await api<{enrollments:Enrollment[]}>("/api/coffee/enrollments");const box=el("coffee-enrollments");box.replaceChildren();
  const current=result.enrollments.find(enrollment=>enrollment.state!=="canceled");
  el("coffee-form").hidden=Boolean(current);
  const states:Record<string,string>={ready:"お支払い前",activating:"お支払い・カード登録を確認中",active:"お申込み済み",card_required:"お試し便の支払済み・カード登録待ち",action_required:"お支払い・在庫の確認が必要です",review:"決済結果を運営で確認中",canceled:"解約済み"};
  for(const enrollment of result.enrollments){
    const panel=text("article","","panel order-row");const plan=config.plans.find(plan=>plan.id===enrollment.planId);
    panel.append(text("h3",`${plan?.name??"珈琲定期便"}／${states[enrollment.state]??"確認中"}`),text("p",`受付番号 ${enrollment.id}`,"small"));
    if(enrollment.state!=="canceled")panel.append(text("p",`通常便の次回決済予定：${enrollment.nextBillingDate}／10日ごろ発送．現時点の試算 ${money(enrollment.nextQuote.totalJpy)}（税込・送料込み）`));
    if(enrollment.card)panel.append(text("p",`定期便のお支払い：${enrollment.card.brand} 末尾${enrollment.card.last4}`,"small"));
    for(const order of enrollment.orders)panel.append(text("p",`${order.kind==="coffee-trial"?"お試し便":"通常便"}／${money(order.quote.totalJpy)}／${({paid:"支払済み",ready:"支払前",paying:"結果確認中",review:"運営確認中",failed:"支払未完了",canceled:"請求なし"} as Record<string,string>)[order.state]??"確認中"}${order.state==="paid"?`／${order.quote.fulfillmentHint??"出荷準備中"}`:""}`,"small"));
    if(["ready","action_required"].includes(enrollment.state)){const retry=text("button","カードを入力して支払いへ進む") as HTMLButtonElement;retry.type="button";retry.disabled=!config.enabled;retry.addEventListener("click",()=>void beginPayment(enrollment,"pay").catch(error=>message(error.message)));panel.append(retry);}
    if(["card_required","active"].includes(enrollment.state)){const change=text("button",enrollment.state==="card_required"?"定期便のカードを登録する":"次回以降のお支払いカードを変更する") as HTMLButtonElement;change.type="button";change.disabled=!config.enabled;change.addEventListener("click",()=>void beginPayment(enrollment,"card").catch(error=>message(error.message)));panel.append(change);}
    if(enrollment.state==="review")panel.append(text("p","再度支払わず，shop@hacksick.comへお問い合わせください．","small"));
    if(enrollment.state!=="canceled"){const cancel=text("button",enrollment.state==="ready"?"この申込を取り消す":"今後の定期便を解約する","danger") as HTMLButtonElement;cancel.type="button";cancel.addEventListener("click",async()=>{if(!window.confirm("今後の定期便の自動請求を停止します．支払済みの注文の取消はメールでご相談ください．解約しますか．"))return;cancel.disabled=true;try{await api(`/api/coffee/enrollments/${enrollment.id}/cancel`,{});action=null;el("coffee-payment").hidden=true;rootRequestId=crypto.randomUUID();await refreshEnrollments();message("解約しました．今後の自動請求を停止しました．");}catch(error){message((error as Error).message);cancel.disabled=false;}});panel.append(cancel);}
    box.append(panel);
  }
  if(!result.enrollments.length)box.append(text("p","定期便のお申込みはまだありません．","small"));
}
export async function loadCoffee(){
  config=await api<CoffeeConfig>("/api/coffee");el("coffee-member").hidden=false;
  el("coffee-public-timeline").hidden = true;
  el("coffee-status").textContent=config.enabled?config.environment==="sandbox"?"テスト環境です．実際のカードではお支払いしないでください．":"定期便をお申し込みいただけます．":"定期便の受付は準備中です．料金と発送条件をご確認いただけます．";
  const select = el<HTMLSelectElement>("coffee-plan");
  const selected = select.value;
  select.replaceChildren(...config.plans.map(plan => new Option(`${plan.name}・${plan.bags}袋`, plan.id)));
  if(config.plans.some(plan=>plan.id===selected))select.value=selected;
  el<HTMLButtonElement>("coffee-prepare").disabled=!config.enabled;showPlan();
  if(!initialized){initialized=true;
    select.addEventListener("change",()=>{rootRequestId=crypto.randomUUID();showPlan();});
    el("coffee-form").addEventListener("submit",async event=>{event.preventDefault();const button=el<HTMLButtonElement>("coffee-prepare");button.disabled=true;try{const fields=Object.fromEntries(new FormData(event.currentTarget as HTMLFormElement).entries());const enrollment=await api<Enrollment>("/api/coffee/enrollments",{requestId:rootRequestId,planId:fields.planId,shipping:{...fields,country:"JP"},termsVersion:config.termsVersion,acceptedTerms:el<HTMLInputElement>("coffee-terms").checked,acceptedCardStorage:el<HTMLInputElement>("coffee-storage").checked});await refreshEnrollments();await beginPayment(enrollment,"pay");message("内容を確認し，カード入力後にお支払いください．");}catch(error){message((error as Error).message);}finally{button.disabled=!config.enabled;}});
    el("coffee-pay-confirm").addEventListener("change",updatePayButton);
    el("coffee-pay").addEventListener("click",async()=>{if(!action||!card||busy||!el<HTMLInputElement>("coffee-pay-confirm").checked)return;busy=true;updatePayButton();const pending=action;
      try{const r=pending.enrollment.shipping;const tokenized=await card.tokenize({amount:String(pending.amount),currencyCode:"JPY",intent:pending.mode==="card"?"STORE":"CHARGE_AND_STORE",customerInitiated:true,sellerKeyedIn:false,billingContact:{givenName:r.display_name,email:config.buyerEmail,phone:r.phone_number,countryCode:"JP",postalCode:r.address.postal_code,state:r.address.administrative_district_level_1,city:r.address.locality,addressLines:[r.address.address_line_1,...(r.address.address_line_2?[r.address.address_line_2]:[])]}});
        if(tokenized.status!=="OK"||!tokenized.token)throw Error("カードの入力と本人認証をご確認ください．");
        const result=await api<Enrollment>(`/api/coffee/enrollments/${pending.enrollment.id}/${pending.mode}`,{requestId:pending.requestId,sourceId:tokenized.token,confirmedTotalJpy:pending.amount,acceptedCardStorage:true});
        action=null;el("coffee-payment").hidden=true;await refreshEnrollments();message(result.state==="active"?"定期便のお申込みを受け付けました．通常便の初回決済予定日をご確認ください．":result.state==="card_required"?"お試し便のお支払いは完了しました．通常便に使うカードの登録をお願いします．":"申込・支払状況をご確認ください．確認中の支払いは重ねてお支払いしないでください．");
      }catch(error){action=null;el("coffee-payment").hidden=true;message((error as Error).message);await refreshEnrollments().catch(()=>{});}finally{busy=false;updatePayButton();}});
    el("coffee-refresh").addEventListener("click",async()=>{try{const result=await api<{enrollments:Enrollment[]}>("/api/coffee/enrollments");for(const enrollment of result.enrollments.filter(enrollment=>["review","activating"].includes(enrollment.state)))await api(`/api/coffee/enrollments/${enrollment.id}`);await refreshEnrollments();message("申込・支払状況を更新しました．");}catch(error){message((error as Error).message);}});
  }
  await refreshEnrollments();
}
