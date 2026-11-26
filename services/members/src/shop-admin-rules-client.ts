import { initializeCouponForm, type CouponProduct } from "./coupon-admin-client.ts";

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
interface ProductRow { sku:string; square_item_id:string; name:string; description:string; unitPriceJpy:number; bags:number; required_status:string|null; fulfillment_source:string; enabled:number }
interface CouponRow { id:string; code:string; label:string; percent:number; expires_at:string; held_or_used:number; spent_jpy:number; revoked_at:string|null; allowed_skus_json:string; recipient_email:string|null; stack_member_discount:number; account_limit:number; use_limit:number|null; budget_jpy:number|null }
interface Roles { products:ProductRow[]; couponProducts:CouponProduct[]; coupons:CouponRow[]; statuses:{member_id:string;status_key:string;expires_at:string|null}[];staff:{email:string;enabled:number}[] }
async function request<T>(path: string, body?: unknown) {
  const response = await fetch(`/api/admin/shop/${path}`, body ? { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) } : {cache:"no-store"});
  const data = await response.json() as T & {error?:string};
  if (!response.ok) throw new Error(data.error ?? "保存できませんでした．");
  return data;
}
const tell = (message: string) => { byId("shop-rules-message").textContent = message; };
function line(value: string, button?: {label:string;run:()=>void}) {
  const row = document.createElement("div");
  row.className = "ops-record";
  const description = document.createElement("span");
  description.textContent = value;
  row.append(description);
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
let showCouponProducts: ReturnType<typeof initializeCouponForm>;

export async function loadShopRules() {
  const data = await request<Roles>("settings");
  byId("shop-status-list").replaceChildren(...data.statuses.map(row => line(`${row.member_id} ／ ${row.status_key}${row.expires_at ? ` ／ ${new Date(row.expires_at).toLocaleString("ja-JP", {timeZone:"Asia/Tokyo"})}まで` : ""}`, {
    label:"解除", run:()=>void save("status",{memberId:row.member_id,status:row.status_key,enabled:false}),
  })));
  byId("shop-product-list").replaceChildren(...data.products.map(row => {
    const result = line(`${row.name} ／ ${row.sku} ／ ${row.enabled ? "有効" : "停止中"}`, {label:"設定を編集",run:()=>loadProduct(row)});
    if (row.enabled) {
      const stop = document.createElement("button");
      stop.type = "button";
      stop.textContent = "販売停止";
      stop.onclick = () => void save("product", { sku: row.sku, enabled: false });
      result.append(" ", stop);
    }
    return result;
  }));
  if (!byId("shop-coupon-form").closest<HTMLElement>("[data-ops-view]")!.hidden) {
    showCouponProducts(data.couponProducts);
    const names = new Map(data.couponProducts.map(product => [product.sku, product.name]));
    byId("shop-coupon-list").replaceChildren(...data.coupons.map(row => {
      const state = row.revoked_at ? "停止済み" : Date.parse(row.expires_at) <= Date.now() ? "期限切れ" : "有効";
      const applied = (JSON.parse(row.allowed_skus_json) as string[]).map(sku => names.get(sku) ?? sku);
      const uses = row.use_limit ? `${row.held_or_used} / ${row.use_limit}回確保・利用` : `${row.held_or_used}回確保・利用`;
      const budget = `累計${row.spent_jpy.toLocaleString("ja-JP")}円${row.budget_jpy ? ` / 上限${row.budget_jpy.toLocaleString("ja-JP")}円` : ""}`;
      // 各利用で少なくとも1円を消費するため，累計枠で決まる回数は表示上省略する．
      const perAccount = !row.budget_jpy || row.account_limit < row.budget_jpy ? `1人${row.account_limit.toLocaleString("ja-JP")}回まで` : "";
      const record = line(`${row.code} ／ ${row.label} ${row.percent}％引き ／ ${state}`,
        state === "有効" ? { label:"停止", run:()=>void save("coupon",{revokeId:row.id}) } : undefined);
      const details = document.createElement("small");
      details.textContent = [
        row.recipient_email || "共通コード",
        row.stack_member_discount ? "会員割引と併用" : "割引額が大きい方を適用",
        `対象商品　${applied.join("，")}`,
        `${new Date(row.expires_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}まで`,
        [uses, perAccount, budget].filter(Boolean).join(" ／ "),
      ].join("\n");
      details.className = "coupon-record-details";
      record.append(details);
      return record;
    }));
  }
  byId("shop-staff-list").replaceChildren(...data.staff.map(row => line(`${row.email} ／ ${row.enabled ? "有効" : "停止中"}`)));
  for (const [id, label] of [["shop-product-list", "追加した商品"], ["shop-coupon-list", "発行済みのクーポン"],
    ["shop-status-list", "販売ステータスの付与"], ["shop-staff-list", "ESSEN発送担当者"]]) {
    const list = byId(id);
    if (!list.childElementCount) list.append(line(`${label}はまだありません．`));
  }
}
async function save(path: string, body: Record<string, unknown>) {
  try {
    await request(path,body);
    await loadShopRules();
    tell("保存しました．");
  } catch (error) { tell((error as Error).message); }
}
let configured = false;
export function initializeShopRules() {
  if (configured) return;
  configured = true;
  showCouponProducts = initializeCouponForm(
    query => request(`coupon-recipients?q=${encodeURIComponent(query)}`),
    body => request("coupon", body),
    loadShopRules,
  );
  for (const [name,path] of [["status","status"],["product","product"],["staff","fulfillment-staff"]]) {
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
        for (const field of ["unitPriceJpy","bags"]) {
          if (field in values) body[field] = values[field] === "" ? undefined : Number(values[field]);
        }
        await save(path,body);
      } catch (error) { tell((error as Error).message); }
      finally { if (button) button.disabled = false; }
    });
  }
}
