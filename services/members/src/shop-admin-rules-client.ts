const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
interface ProductRow { sku:string; square_item_id:string; name:string; description:string; unitPriceJpy:number; bags:number; required_status:string|null; fulfillment_source:string; enabled:number }
interface CouponRow { id:string; code:string; label:string; percent:number; expires_at:string; held_or_used:number; spent_jpy:number; revoked_at:string|null }
interface Roles { products:ProductRow[]; coupons:CouponRow[]; statuses:{member_id:string;status_key:string;expires_at:string|null}[];staff:{email:string;enabled:number}[] }
async function request<T>(path: string, body?: unknown) {
  const response = await fetch(`/api/admin/shop/${path}`, body ? { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) } : {cache:"no-store"});
  const data = await response.json() as T & {error?:string};
  if (!response.ok) throw new Error(data.error ?? "保存できませんでした．");
  return data;
}
const tell = (message: string) => { byId("shop-rules-message").textContent = message; };
function line(value: string, button?: {label:string;run:()=>void}) {
  const row = document.createElement("p");
  row.textContent = value;
  if (button) {
    const action = document.createElement("button");
    action.type = "button"; action.textContent = button.label; action.onclick = button.run; row.append(" ", action);
  }
  return row;
}
function loadProduct(row: ProductRow) {
  const form = byId<HTMLFormElement>("shop-product-form");
  const values = {sku:row.sku,squareItemId:row.square_item_id,name:row.name,description:row.description,
    unitPriceJpy:row.unitPriceJpy,bags:row.bags,requiredStatus:row.required_status ?? "",fulfillmentSource:row.fulfillment_source};
  for (const [key, value] of Object.entries(values)) (form.elements.namedItem(key) as HTMLInputElement).value = String(value);
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}
async function refresh() {
  const data = await request<Roles>("settings");
  byId("shop-status-list").replaceChildren(...data.statuses.map(row => line(`${row.member_id} ／ ${row.status_key}${row.expires_at ? ` ／ ${new Date(row.expires_at).toLocaleString("ja-JP", {timeZone:"Asia/Tokyo"})}まで` : ""}`, {
    label:"解除", run:()=>void save("status",{memberId:row.member_id,status:row.status_key,enabled:false}),
  })));
  byId("shop-product-list").replaceChildren(...data.products.map(row => {
    const result = line(`${row.name} ／ ${row.sku} ／ ${row.enabled ? "有効" : "停止中"}`, {label:"設定を編集",run:()=>loadProduct(row)});
    if (row.enabled) result.append(line("", {label:"販売停止",run:()=>void save("product",{sku:row.sku,enabled:false})}));
    return result;
  }));
  byId("shop-coupon-list").replaceChildren(...data.coupons.map(row => line(`${row.code} ／ ${row.label} ${row.percent}％ ／ ${row.held_or_used}件確保・利用 ／ 累計${row.spent_jpy}円 ／ ${row.revoked_at ? "停止済み" : new Date(row.expires_at).toLocaleString("ja-JP", {timeZone:"Asia/Tokyo"}) + "まで"}`,
    row.revoked_at ? undefined : {label:"停止",run:()=>void save("coupon",{revokeId:row.id})})));
  byId("shop-staff-list").replaceChildren(...data.staff.map(row => line(`${row.email} ／ ${row.enabled ? "有効" : "停止中"}`)));
}
async function save(path: string, body: Record<string, unknown>) {
  try {
    const result = await request<{code?:string}>(path,body);
    await refresh();
    tell(result.code ? `発行したコード：${result.code}` : "保存しました．");
  } catch (error) { tell((error as Error).message); }
}
let configured = false;
export function initializeShopRules() {
  if (configured) return;
  configured = true;
  byId<HTMLDetailsElement>("shop-rules").addEventListener("toggle", () => {
    if (byId<HTMLDetailsElement>("shop-rules").open) void refresh().catch(error => tell(error.message));
  });
  for (const [name,path] of [["status","status"],["product","product"],["coupon","coupon"],["staff","fulfillment-staff"]]) {
    const form = byId<HTMLFormElement>(`shop-${name}-form`);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const button = (event as SubmitEvent).submitter as HTMLButtonElement | null;
      if (button) button.disabled = true;
      try {
        const values = Object.fromEntries(new FormData(form));
        const body: Record<string, unknown> = {...values};
        if (body.expiresAt) body.expiresAt = new Date(String(body.expiresAt)).toISOString();
        if (name === "status" || name === "staff") body.enabled = button?.value !== "remove";
        if (name === "product") {
          const file = values.photo;
          body.photo = undefined;
          if (file instanceof File && file.size > 0) {
            if (file.size > 500000) throw new Error("写真は500KB以内にしてください．");
            body.photo = await new Promise<string>((resolve,reject) => { const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); });
          }
        }
        if (name === "coupon") {
          body.skus = String(values.skus).trim().split(/\s+/);
          body.costConfirmed = values.costConfirmed === "on";
        }
        for (const field of ["unitPriceJpy","bags","percent","useLimit","accountLimit","budgetJpy","photos"]) {
          if (field in values) body[field] = values[field] === "" ? undefined : Number(values[field]);
        }
        await save(path,body);
      } catch (error) { tell((error as Error).message); }
      finally { if (button) button.disabled = false; }
    });
  }
}
