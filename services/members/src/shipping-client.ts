const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const say = (message: string) => { get("shipping-message").textContent = message; };
const node = (tag: string, text: string) => { const element = document.createElement(tag); element.textContent = text; return element; };
let email = "";
interface Order {
  id:string; lines:{name:string;quantity:number}[];
  recipient:{display_name:string;phone_number:string;address:{postal_code:string;administrative_district_level_1:string;locality:string;address_line_1:string;address_line_2?:string}}|null;
  planned_date:string|null;hold_reason:string|null;
  shipment:{trackingNumbers:string[];shippedAt:string;label:string}|null;
}
async function request<T>(path: string, body?: unknown) {
  const response = await fetch(path, body === undefined ? {cache:"no-store"} :
    {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const result = await response.json() as T & {error?:string;message?:string};
  if (!response.ok) throw new Error(result.error ?? result.message ?? "操作を完了できませんでした．");
  return result;
}
function labeled(label: string, control: HTMLElement) { const row = node("label",label); row.append(control); return row; }
function actionForm(label:string, children:HTMLElement[], submit:()=>Promise<void>) {
  const form = document.createElement("form"); const button = node("button",label) as HTMLButtonElement;
  form.append(...children,button);
  form.onsubmit = async event => {
    event.preventDefault(); button.disabled = true;
    try { await submit(); await refresh(); say("保存しました．"); }
    catch(error) { say((error as Error).message); }
    finally { button.disabled = false; }
  };
  return form;
}
function orderCard(order: Order) {
  const result = node("article",""); result.className = "panel";
  result.append(node("h2",order.shipment ? "発送済み" : order.hold_reason ? "保留" : "未発送"),node("p",`受付番号 ${order.id}`),
    ...order.lines.map(line=>node("p",`${line.name} × ${line.quantity}`)));
  if (order.shipment) {
    result.append(node("p",`${order.shipment.label} ／ ${order.shipment.trackingNumbers.join("，")}`));
    return result;
  }
  if (!order.recipient) return result;
  const {display_name,phone_number,address} = order.recipient;
  result.append(node("p",`${display_name} 様`),node("p",`〒${address.postal_code} ${address.administrative_district_level_1}${address.locality}${address.address_line_1} ${address.address_line_2 ?? ""}`),node("p",phone_number));
  const date = document.createElement("input"); date.type = "date"; date.value = order.planned_date ?? "";
  const hold = document.createElement("input"); hold.maxLength = 240; hold.value = order.hold_reason ?? "";
  const base = `/api/fulfillment/orders/${order.id}`;
  result.append(actionForm("発送予定・保留を保存", [labeled("発送予定日",date),labeled("保留理由（空欄で解除）",hold)],
    () => request(`${base}/dispatch`,{plannedDate:date.value,holdReason:hold.value})));
  if (!order.hold_reason) {
    const carrier = document.createElement("select");
    for (const [value,label] of [["clickpost","クリックポスト"],["japanpost","日本郵便"],["yamato","ヤマト運輸"],["sagawa","佐川急便"]]) carrier.add(new Option(label,value));
    const tracking = document.createElement("textarea"); tracking.required = true; tracking.maxLength=400;
    const checked = document.createElement("input"); checked.type = "checkbox"; checked.required = true;
    result.append(actionForm("発送を記録して購入者へ通知", [labeled("配送業者",carrier),labeled("追跡番号（1行に1つ）",tracking),labeled("配送業者へ引き渡しました",checked)],
      () => request(`${base}/shipment`,{carrier:carrier.value,trackingNumbers:tracking.value,dispatched:checked.checked})));
  }
  return result;
}
async function refresh() {
  const panel = get("shipping-panel"); const login = get("shipping-login");
  try {
    const data = await request<{orders:Order[]}>("/api/fulfillment/orders");
    get("shipping-orders").replaceChildren(...(data.orders.length ? data.orders.map(orderCard) : [node("p","担当の注文はありません．")]));
    panel.hidden=false; login.hidden=true;
  } catch (error) {
    panel.hidden=true; login.hidden=false; get("shipping-orders").replaceChildren();
    throw error;
  }
}
get<HTMLFormElement>("shipping-email").onsubmit = async event => {
  event.preventDefault();
  email = String(new FormData(get<HTMLFormElement>("shipping-email")).get("email"));
  try {
    await request("/api/auth/email-otp/send-verification-otp",{email,type:"sign-in"});
    get("shipping-otp").hidden=false; say("登録済みのメールに確認コードを送信します．");
  } catch(error) { say((error as Error).message); }
};
get<HTMLFormElement>("shipping-otp").onsubmit = async event => {
  event.preventDefault();
  const otp = new FormData(get<HTMLFormElement>("shipping-otp")).get("otp");
  try { await request("/api/auth/sign-in/email-otp",{email,otp}); await refresh(); say(""); }
  catch(error) { say((error as Error).message); }
};
get("shipping-refresh").onclick = () => void refresh().catch(error=>say(error.message));
get("shipping-logout").onclick = async () => {
  try {
    await request("/api/auth/sign-out",{});
    get("shipping-panel").hidden=true; get("shipping-login").hidden=false;
    get("shipping-otp").hidden=true; get("shipping-orders").replaceChildren();
    say("ログアウトしました．");
  } catch(error) { say((error as Error).message); }
};
void refresh().catch(error => { if (error.message !== "ログインしてください．") say(error.message); });
export {};
