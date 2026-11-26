import { initializeShopRules, loadShopRules } from "./shop-admin-rules-client.ts";
import { readCart, writeCart } from "./storefront-cart-client.ts";
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const money = (n: number) => `${n.toLocaleString("ja-JP")}円`;
const text = (tag: string, value: string, className = "") => { const node = document.createElement(tag); node.textContent = value; node.className = className; return node; };
class ShopRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json() as T & { error?: string }; if (!res.ok) throw new ShopRequestError(data.error ?? "処理を完了できませんでした．", res.status); return data;
}
interface ProductImage { src: string; alt: string; width?: number; height?: number }
export type ShippingAddress = Record<"name" | "phone" | "postalCode" | "prefecture" | "city" | "addressLine1" | "addressLine2", string>;
type Source = "hacksick" | "essen";
export interface Product { fulfillmentSource?: Source; sku: string; name: string; unitPriceJpy: number; bags: number; category: string; description: string; workUrl?: string; images?: ProductImage[]; maxPerOrder?: number; memberDiscountEligible?: boolean }
export const maximumQuantity = (product: Product & { available: number }) => Math.min(product.maxPerOrder ?? 100, product.available);
export interface Shop { wallets?: boolean; essenLocationId?: string; products: (Product & { available: number })[]; policy: { discountPercent: number; recurringDiscountPercent: number; recurringCheckoutEnabled: boolean }; stock: { shared: boolean; available: boolean }; eligible: boolean; canPurchase: boolean; storefront: boolean; enabled: boolean; paymentFormPreview?:boolean; environment: string; applicationId: string; locationId: string; buyerEmail: string | null; shippingAddress?: ShippingAddress | null }
interface Quote { coupon?: { id: string }; discountLabel?: string; memberDiscountJpy?: number; fulfillmentSource?: Source; subtotalJpy: number; discountPercent: number; discountJpy: number; shippingJpy: number; totalJpy: number; fulfillmentHint?:string; lines?: { name: string; quantity: number }[] }
interface Shipment { label?: string; trackingNumbers: string[]; shippedAt: string; trackingUrl: string }
interface Checkout { dispatch?: {plannedDate:string|null;held:boolean} | null; id: string; state: string; quote: Quote; expiresAt: string; shipment?: Shipment | null }
interface AdminOrder {
  id: string;
  state: string;
  square_order_id: string | null;
  created_at: string;
  review_reason: string | null;
  quote_json: string;
  purchase_kind: string;
  order_channel?: "members" | "shop";
  fulfillment_source?: Source;
  planned_date?: string | null;
  hold_reason?: string | null;
  receipt_notice_state: string | null;
  shipping_notice_state: string | null;
  shipment: Shipment | null;
}
interface SquareCard { attach(selector: string): Promise<void>; tokenize(details: Record<string, unknown>): Promise<{ status: string; token?: string }>; destroy(): Promise<void> }
interface SquareWallet {
  tokenize(): Promise<{ status: string; token?: string }>;
  destroy(): Promise<boolean>;
}
interface SquareGooglePay extends SquareWallet { attach(selector: string): Promise<void> }
interface SquarePayments {
  card(): Promise<SquareCard>;
  paymentRequest(options: Record<string, unknown>): unknown;
  applePay(request: unknown): Promise<SquareWallet>;
  googlePay(request: unknown): Promise<SquareGooglePay>;
  verifyBuyer(token: string, details: Record<string, unknown>): Promise<{token?:string}|null>;
}
declare global { interface Window { Square?: { payments(appId: string, locationId: string): SquarePayments } } }
let shop: Shop;
let requestId = crypto.randomUUID();
let revision = 0;
let checkoutBusy = false;
let initialized = false;
let view: "cart" | "checkout" = "cart";
let currentQuote: Quote | null = null;
let submittedCoupon = "";
let card: SquareCard | null = null;
let payments: SquarePayments | null = null;
let cardLocation = "";
let cardTask: Promise<void> = Promise.resolve();
let apple: SquareWallet | null = null;
let google: SquareGooglePay | null = null;
let walletRevision = -1;
let sdkLoading: Promise<void> | null = null;
let importSnapshot: Record<string, unknown> | null = null;
const source = () => el<HTMLSelectElement>("checkout-source").value as Source;
const couponInput = () => el<HTMLInputElement>("checkout-coupon");
const couponStatus = (message: string, state = "") => {
  const status = el("checkout-coupon-status");
  status.textContent = message;
  status.dataset.state = state;
};
const quantities = () => [...el("shop-products").querySelectorAll<HTMLInputElement>("input[data-sku]")].map(input => ({ sku: input.dataset.sku!, quantity: Number(input.value) })).filter(l => l.quantity !== 0);
const message = (value: string) => { el("checkout-message").textContent = value; };
function buttonState() {
  couponInput().readOnly = Boolean(submittedCoupon);
  const apply = el<HTMLButtonElement>("checkout-coupon-apply");
  const remove = el<HTMLButtonElement>("checkout-coupon-remove");
  apply.hidden = Boolean(submittedCoupon);
  apply.disabled = checkoutBusy || !shop?.buyerEmail || !shop.canPurchase || !couponInput().value.trim() || !quantities().length;
  remove.hidden = !submittedCoupon;
  remove.disabled = checkoutBusy;
  el<HTMLButtonElement>("checkout-submit").disabled = !shop?.enabled || !shop.canPurchase || !currentQuote || !card || checkoutBusy;
  const walletsReady = Boolean(shop?.enabled && currentQuote && !checkoutBusy && walletRevision === revision);
  el("checkout-wallets").hidden = !walletsReady;
  el("checkout-submit").textContent = currentQuote ? `${money(currentQuote.totalJpy)}を支払って注文する` : "数量と合計金額を確認してください";
  const checkoutLink = el<HTMLAnchorElement>("cart-checkout");
  checkoutLink.hidden = view !== "cart" || !shop?.enabled || !currentQuote;
  checkoutLink.href = `/checkout?from=${source()}`;
}
function loadCard() {
  cardTask = cardTask.catch(() => {}).then(loadCardForSource);
  return cardTask;
}
async function loadCardForSource() {
  const locationId = source() === "essen" ? shop.essenLocationId : shop.locationId;
  if (!locationId || (card && cardLocation === locationId) || (!shop.enabled && !shop.paymentFormPreview) || !shop.canPurchase) return;
  if (!sdkLoading) sdkLoading = new Promise((resolve, reject) => {
    const script = document.createElement("script"); script.src = shop.environment === "production" ? "https://web.squarecdn.com/v1/square.js" : "https://sandbox.web.squarecdn.com/v1/square.js";
    script.onload = () => resolve(); script.onerror = () => reject(new Error("カード入力欄を読み込めません．ページを再読み込みしてください．")); document.head.append(script);
  });
  await sdkLoading;
  if (!window.Square) throw new Error("カード入力欄を読み込めません．");
  if (card) await card.destroy();
  card = null;
  cardLocation = "";
  payments = window.Square.payments(shop.applicationId, locationId);
  const next = await payments.card();
  await next.attach("#card-container");
  card = next;
  cardLocation = locationId;
  el("card-section").hidden = false; el("card-preview-note").hidden=shop.enabled; buttonState();
}
async function quote() {
  const version = ++revision; currentQuote = null; buttonState();
  const lines = quantities();
  const summary = el("shop-quote");
  const candidate = shop.buyerEmail ? submittedCoupon : "";
  el("checkout-returns").textContent = lines.some(line => shop.products.find(p => p.sku === line.sku)?.category === "書籍")
    ? "書籍のお客様都合の返品は受取日から8日以内にご連絡ください．返送料はお客様負担です．食品はお客様都合の返品・交換をお受けできません．不良品・誤配送の返送料はHackSick負担です．"
    : "食品のお客様都合による返品・交換はお受けできません．不良品・誤配送はHackSick負担で対応します．到着後7日以内を目安にshop@hacksick.comへご連絡ください．";
  if (!lines.length) {
    if (candidate) {
      clearShopCoupon();
      couponInput().value = "";
      couponStatus("");
      buttonState();
    }
    summary.replaceChildren(text("p", "数量を選ぶと，送料を含む合計金額を確認できます．"));
    return;
  }
  if (!shop.canPurchase) return;
  if (lines.some(line => line.quantity > (shop.products.find(p => p.sku === line.sku)?.available ?? 0))) {
    if (candidate) couponStatus("数量を調整すると，クーポンを再確認します．");
    summary.replaceChildren(text("p", "在庫数に合わせて数量を調整してください．"));
    return;
  }
  if (candidate) couponStatus("クーポンを確認しています．");
  summary.replaceChildren(text("p", "商品代金と送料を確認しています．"));
  let data: Quote;
  let rejected = false;
  try {
    try {
      data = await api<Quote>("/api/shop/quote", { items: lines, couponCode: candidate });
    } catch (error) {
      if (version !== revision) return;
      if (!candidate || !(error instanceof ShopRequestError) || error.status !== 400) throw error;
      rejected = true;
      data = await api<Quote>("/api/shop/quote", { items: lines });
    }
  } catch (error) {
    if (version !== revision) return;
    if (candidate) {
      clearShopCoupon();
      couponStatus("クーポンを確認できませんでした．もう一度お試しください．", "error");
      buttonState();
    }
    summary.replaceChildren(text("p", (error as Error).message));
    return;
  }
  if (version !== revision) return;
  const memberDiscount = data.memberDiscountJpy ?? 0;
  const otherDiscount = data.discountJpy - memberDiscount;
  if (candidate && data.coupon) {
    rememberCoupon(candidate);
    const applied = `クーポンを適用しました．${money(otherDiscount)}引きです．`;
    couponStatus(memberDiscount ? `${applied}会員割引と併用しています．` : applied, "success");
  } else if (candidate) {
    clearShopCoupon();
    if (rejected) couponStatus("この注文にはクーポンを適用できません．コードと対象商品をご確認ください．", "error");
    else couponStatus("この注文では会員特典を適用します．クーポンの利用回数は減りません．");
  }
  currentQuote = data;
  const contents = text("ul", "", "checkout-line-summary");
  if (view === "checkout") contents.append(...(data.lines ?? []).map(line => text("li", `${line.name} × ${line.quantity}`)));
  const dl = document.createElement("dl"); dl.className = "price-summary";
  dl.append(text("dt", "商品代金（税込）"), text("dd", money(data.subtotalJpy)));
  if (memberDiscount) dl.append(text("dt", `珈琲の会員特典${shop.policy.discountPercent}％`), text("dd", money(-memberDiscount)));
  if (otherDiscount) dl.append(text("dt", data.discountLabel ?? `珈琲の会員特典${data.discountPercent}％`), text("dd", money(-otherDiscount)));
  dl.append(text("dt", "送料"), text("dd", money(data.shippingJpy)), text("dt", "お支払い合計"), text("dd", money(data.totalJpy)));
  summary.replaceChildren(...(view === "checkout" ? [contents, dl] : [dl])); buttonState();
  if (view !== "cart") void prepareWallets(version, data);
}
async function refreshOrders(storefront = false) {
  const response = await fetch("/api/shop/checkouts", { cache: "no-store" });
  if (!response.ok && !(storefront && response.status === 401)) throw new Error("購入状況を確認できませんでした．");
  const result: { checkouts: Checkout[] } = response.ok ? await response.json() : { checkouts: [] };
  const container = el("shop-orders"); container.replaceChildren();
  if (!result.checkouts.length) { container.append(text("p", "購入履歴はまだありません．", "small")); return; }
  const receipt = new URLSearchParams(location.search).get("receipt");
  const selected = result.checkouts.find(order => order.id === receipt);
  for (const original of selected ? [selected, ...result.checkouts.filter(order => order !== selected)] : result.checkouts) {
    let order = original;
    if (["paying", "review", "paid"].includes(order.state)) order = await api<Checkout>(`/api/shop/checkouts/${order.id}`);
    const row = text("article", "", "panel order-row");
    const states: Record<string, string> = { ready: "カード確認前の購入受付", paying: "お支払い結果を確認中です．もう一度支払わず，しばらくして購入状況を確認してください．", paid: "お支払いを確認しました．決済完了後5日以内を目安に出荷します．", failed: "お支払いは完了していません．別のカードで購入をやり直せます．", canceled: "受付終了（請求なし）", review: "運営で確認中です．再度のお支払いはせず，shop@hacksick.comへお問い合わせください．" };
    row.append(text("h3", order.state==="paid"&&order.quote.fulfillmentHint?`お支払いを確認しました．${order.quote.fulfillmentHint}．`:states[order.state] ?? "確認中"), text("p", `${money(order.quote.totalJpy)} ／ 受付番号 ${order.id}`, "small"));
    if (!order.shipment && order.dispatch?.held) row.append(text("p", "発送を保留しています．", "small"));
    if (!order.shipment && order.dispatch?.plannedDate) row.append(text("p", `発送予定日 ${order.dispatch.plannedDate}`, "small"));
    if (order.shipment) {
      const tracking = text("a", `${order.shipment.label ?? "配送業者"}で配送状況を確認する`) as HTMLAnchorElement;
      tracking.href = order.shipment.trackingUrl;
      row.append(text("p", `発送済み ／ お問い合わせ番号 ${order.shipment.trackingNumbers.join("，")}`, "small"), tracking);
    }
    if (order.state === "ready") {
      const cancel = text("button", "この受付を取り消す", "danger") as HTMLButtonElement; cancel.type = "button";
      cancel.addEventListener("click", async () => { cancel.disabled = true; try { await api(`/api/shop/checkouts/${order.id}/cancel`, {}); if (order.id === requestId) requestId = crypto.randomUUID(); await refreshOrders(); } catch (error) { message((error as Error).message); cancel.disabled = false; } }); row.append(cancel);
    }
    container.append(row);
  }
}
export async function loadStorefrontOrders() {
  el("orders-refresh").onclick = () => { void refreshOrders(true).catch(error => { el("notice").textContent = error.message; }); };
  await refreshOrders(true);
}
async function refreshShopState() {
  shop = await api<Shop>("/api/shop");
  el("shop-status").textContent = !shop.canPurchase ? "購入資格については運営へお問い合わせください．" : !shop.enabled ? "現在，購入受付を確認中です．" : !shop.products.some(p => p.available > 0) ? "現在在庫切れです．" : shop.environment === "sandbox" ? "テスト環境です．実際のカードでは購入しないでください．" : shop.eligible ? `珈琲の単発購入に会員特典${shop.policy.discountPercent}％を適用できます．` : "通常価格でご購入いただけます．";
}
export function prefillShippingAddress(formId: string, address = shop?.shippingAddress) {
  if (!address) return false;
  const form = el<HTMLFormElement>(formId);
  const fields = Object.entries(address).map(([name, value]) => ({
    field: form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement,
    value,
  }));
  if (fields.some(({ field }) => !field || field.value)) return false;
  fields.forEach(({ field, value }) => { field.value = value; });
  return true;
}
function freezeForm(busy: boolean) {
  for (const field of el("checkout-form").querySelectorAll<HTMLInputElement | HTMLSelectElement>("input,select")) field.disabled = busy;
}
export function productPhoto(photo: ProductImage) {
  const link = document.createElement("a"); link.href = photo.src; link.target = "_blank"; link.rel = "noopener"; link.className = "product-photo-link"; link.setAttribute("aria-label", `${photo.alt}の写真を拡大する`);
  const image = document.createElement("img"); image.src = photo.src; image.alt = photo.alt; if (photo.width) image.width = photo.width; if (photo.height) image.height = photo.height; image.loading = "lazy"; image.decoding = "async"; image.className = "product-photo"; link.append(image);
  return link;
}
export function productGallery(product: Product, photos: ProductImage[]) {
  const gallery = text("div", "", "product-gallery");
  gallery.setAttribute("role", "group");
  gallery.setAttribute("aria-roledescription", "カルーセル");
  gallery.setAttribute("aria-label", `${product.name}の写真`);
  const slides = text("div", "", "product-gallery-slides");
  slides.tabIndex = 0;
  slides.setAttribute("aria-label", "左右キーまたはスワイプで写真を切り替え");
  slides.append(...photos.map(productPhoto));
  const previous = text("button", "‹", "product-gallery-arrow") as HTMLButtonElement;
  const next = text("button", "›", "product-gallery-arrow") as HTMLButtonElement;
  previous.type = next.type = "button";
  previous.setAttribute("aria-label", "前の写真");
  next.setAttribute("aria-label", "次の写真");
  const thumbnails = text("div", "", "product-gallery-thumbnails");
  const buttons = photos.map((photo, index) => {
    const button = text("button", "", "product-gallery-thumbnail") as HTMLButtonElement;
    button.type = "button";
    button.setAttribute("aria-label", `${index + 1}枚目を表示．${photo.alt}`);
    const image = document.createElement("img");
    image.src = photo.src;
    image.alt = "";
    image.loading = "lazy";
    button.append(image);
    button.addEventListener("click", () => select(index));
    return button;
  });
  let current = 0;
  function update(index: number) {
    current = index;
    buttons.forEach((button, position) => button.setAttribute("aria-current", String(position === current)));
  }
  function select(index: number) {
    update((index + photos.length) % photos.length);
    slides.scrollTo({ left: slides.clientWidth * current, behavior: "instant" });
  }
  slides.addEventListener("scroll", () => {
    const index = Math.round(slides.scrollLeft / slides.clientWidth);
    if (index >= 0 && index < photos.length && index !== current) update(index);
  }, { passive: true });
  slides.addEventListener("keydown", event => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    select(current + (event.key === "ArrowRight" ? 1 : -1));
  });
  previous.addEventListener("click", () => select(current - 1));
  next.addEventListener("click", () => select(current + 1));
  update(0);
  thumbnails.append(...buttons);
  const controls = text("div", "", "product-gallery-controls");
  controls.append(previous, thumbnails, next);
  gallery.append(slides, controls);
  return gallery;
}
function renderStorefrontCart() {
  const cart = readCart();
  const products = el("shop-products");
  products.replaceChildren();
  const items = shop.products.filter(product => cart.has(product.sku));
  const groups = new Set(items.map(product => product.fulfillmentSource ?? "hacksick"));
  const selector = el<HTMLSelectElement>("checkout-source");
  for (const option of selector.options) option.disabled = !groups.has(option.value as Source);
  if (view === "cart" && !groups.has(source())) selector.value = groups.values().next().value ?? "hacksick";
  el("checkout-source-label").hidden = view !== "cart" || groups.size < 2;
  el("checkout-source-note").hidden = view !== "cart" || groups.size < 2;
  const selected = items.filter(product => (product.fulfillmentSource ?? "hacksick") === source());
  const unavailable = [...cart.keys()].filter(sku => !items.some(item => item.sku === sku));
  if (view === "cart" && unavailable.length) {
    const notice = text("div", "", "cart-unavailable");
    const remove = text("button", "購入できない商品を削除", "store-secondary") as HTMLButtonElement;
    remove.type = "button";
    remove.addEventListener("click", () => {
      for (const sku of unavailable) cart.delete(sku);
      saveStorefrontCart(cart);
    });
    notice.append(text("p", "現在購入できない商品がカートに入っています．"), remove);
    products.append(notice);
  }
  if (!selected.length) {
    products.append(text("p", "カートに商品が入っていません．"));
    return false;
  }
  for (const product of selected) {
    const input = document.createElement("input");
    input.type = view === "cart" ? "number" : "hidden";
    input.min = "1";
    input.max = String(maximumQuantity(product));
    input.value = String(cart.get(product.sku));
    input.dataset.sku = product.sku;
    if (view === "checkout") {
      products.append(input);
      continue;
    }
    input.addEventListener("change", () => {
      const amount = Number(input.value);
      if (!Number.isInteger(amount) || amount < 1 || amount > (product.maxPerOrder ?? 100)) { input.value = String(cart.get(product.sku)); return; }
      cart.set(product.sku, amount);
      saveStorefrontCart(cart);
    });
    const row = text("article", "", "store-cart-row");
    const photo = product.images?.[0];
    if (photo) row.append(productPhoto(photo));
    const details = text("div", "", "store-cart-product");
    const productLink = text("a", product.name) as HTMLAnchorElement;
    productLink.href = `/products/${product.sku}`;
    details.append(productLink, text("p", `${money(product.unitPriceJpy)}（税込）`, "small"));
    if (product.maxPerOrder) details.append(text("p", `1注文 ${product.maxPerOrder}セットまで`, "small"));
    if (product.available < Number(input.value)) details.append(text("p", product.available ? `現在の在庫 ${product.available}点` : "在庫切れ", "small"));
    const controls = text("div", "", "store-cart-controls");
    const label = text("label", "数量", "small");
    input.setAttribute("aria-label", `${product.name}の数量`);
    label.append(input);
    const remove = text("button", "削除", "store-secondary") as HTMLButtonElement;
    remove.type = "button";
    remove.setAttribute("aria-label", `${product.name}を削除`);
    remove.addEventListener("click", () => { cart.delete(product.sku); saveStorefrontCart(cart); });
    controls.append(label, remove);
    row.append(details, controls);
    products.append(row);
  }
  return true;
}

function saveStorefrontCart(cart: Map<string, number>) {
  try { writeCart(cart); }
  catch (error) { el("notice").textContent = (error as Error).message; }
  resetAcceptance();
  renderStorefrontCart();
  void quote();
}

const couponKey = "hacksick-shop-applied-coupon";
function rememberCoupon(code: string) {
  try {
    if (code) sessionStorage.setItem(couponKey, code);
    else sessionStorage.removeItem(couponKey);
  } catch { /* 遷移後に入力し直せる． */ }
}
export function clearShopCoupon() {
  submittedCoupon = "";
  rememberCoupon("");
}
function applyCoupon() {
  if (el<HTMLButtonElement>("checkout-coupon-apply").disabled) return;
  submittedCoupon = couponInput().value.trim().toUpperCase();
  couponInput().value = submittedCoupon;
  resetAcceptance();
  void quote();
}
function removeCoupon() {
  clearShopCoupon();
  couponInput().value = "";
  couponStatus("クーポンを取り消しました．");
  resetAcceptance();
  void quote();
  couponInput().focus();
}

export async function loadShop(page: typeof view) {
  view = page;
  el<HTMLFormElement>("checkout-form").noValidate = view === "cart";
  el("shop").hidden = false;
  const previousEmail = shop?.buyerEmail;
  await refreshShopState();
  if (previousEmail !== undefined && previousEmail !== shop.buyerEmail) resetAcceptance();
  const guest = shop.storefront && !shop.buyerEmail;
  const email = el<HTMLInputElement>("checkout-email");
  email.required = guest;
  email.disabled = !guest;
  el("checkout-email-label").hidden = !guest;
  el("guest-benefits").hidden = !guest;
  if (guest) el("guest-benefits").querySelector("a")!.href = `/login?return=${encodeURIComponent(`/${view}${location.search}`)}`;
  el("checkout-coupon-entry").hidden = guest;
  const selected = new URLSearchParams(location.search).get("from");
  el<HTMLSelectElement>("checkout-source").value = selected === "essen" ? "essen" : "hacksick";
  const hasItems = renderStorefrontCart();
  el("checkout-shipping").hidden = view === "cart" || !hasItems;
  el("checkout-summary-title").hidden = false;
  el("checkout-summary").hidden = view === "checkout" && !hasItems;
  el("checkout-items").hidden = view === "checkout" && hasItems;
  if (shop.buyerEmail) {
    try { submittedCoupon = sessionStorage.getItem(couponKey) ?? ""; }
    catch { submittedCoupon = ""; }
    couponInput().value = submittedCoupon;
  }
  if (!initialized) {
    initialized = true;
    const prefectures = "北海道 青森県 岩手県 宮城県 秋田県 山形県 福島県 茨城県 栃木県 群馬県 埼玉県 千葉県 東京都 神奈川県 新潟県 富山県 石川県 福井県 山梨県 長野県 岐阜県 静岡県 愛知県 三重県 滋賀県 京都府 大阪府 兵庫県 奈良県 和歌山県 鳥取県 島根県 岡山県 広島県 山口県 徳島県 香川県 愛媛県 高知県 福岡県 佐賀県 長崎県 熊本県 大分県 宮崎県 鹿児島県 沖縄県".split(" ");
    for (const p of prefectures) { const option = document.createElement("option"); option.value = p; option.textContent = p; el("prefectures").append(option); }
    el("checkout-form").addEventListener("submit", event => {
      event.preventDefault();
      if (view === "cart") return;
      if (card && cardLocation === (source() === "essen" ? shop.essenLocationId : shop.locationId)) void completePurchase(card, "card");
    });
    el("checkout-apple").addEventListener("click", () => { if (apple) void completePurchase(apple, "apple"); });
    el("checkout-google").addEventListener("click", event => { event.preventDefault(); if (google) void completePurchase(google, "google"); });
    el("checkout-source").addEventListener("change", () => {
      resetAcceptance();
      ++revision; currentQuote = null; buttonState();
      renderStorefrontCart();
      void quote();
    });
    el("checkout-coupon-apply").addEventListener("click", applyCoupon);
    el("checkout-coupon-remove").addEventListener("click", removeCoupon);
    couponInput().addEventListener("input", () => {
      couponStatus(couponInput().value.trim() ? "「適用」を押すと合計金額を更新します．" : "");
      buttonState();
    });
    couponInput().addEventListener("keydown", event => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      applyCoupon();
    });
    for (const input of el("checkout-form").querySelectorAll<HTMLInputElement | HTMLSelectElement>(".shipping-form input:not([name=terms]),.shipping-form select")) {
      input.addEventListener("change", resetAcceptance);
    }
    el("orders-refresh").addEventListener("click", () => { void refreshOrders().catch(e => message(e.message)); });
  }
  if (view !== "cart" && prefillShippingAddress("checkout-form")) el("shipping-address-note").hidden = false;
  if (view === "checkout" && quantities().length && shop.canPurchase) await loadCard().catch(error => message(error.message));
  await quote();
}
function resetAcceptance() {
  requestId = crypto.randomUUID();
  el<HTMLInputElement>("checkout-terms").checked = false;
}
let walletTask: Promise<void> = Promise.resolve();
function prepareWallets(version: number, data: Quote) {
  walletTask = walletTask.catch(() => {}).then(async () => {
    if (version !== revision || !payments || !shop.enabled || !shop.wallets) return;
    const active = payments;
    await Promise.allSettled([apple?.destroy(), google?.destroy()]);
    apple = google = null;
    const paymentRequest = () => active.paymentRequest({ countryCode: "JP", currencyCode: "JPY",
      total: { amount: String(data.totalJpy), label: "HackSickストア" } });
    const [a, g] = await Promise.allSettled([active.applePay(paymentRequest()), active.googlePay(paymentRequest())]);
    if (version !== revision || payments !== active) {
      await Promise.allSettled([a.status === "fulfilled" ? a.value.destroy() : undefined, g.status === "fulfilled" ? g.value.destroy() : undefined]);
      return;
    }
    if (a.status === "fulfilled") apple = a.value;
    if (g.status === "fulfilled") {
      try { await g.value.attach("#checkout-google"); google = g.value; }
      catch { await g.value.destroy().catch(() => {}); }
    }
    el("checkout-apple").hidden = !apple;
    walletRevision = apple || google ? version : -1;
    buttonState();
  });
  return walletTask;
}
async function completePurchase(method: SquareCard | SquareWallet, kind: "card" | "apple" | "google") {
  const total = currentQuote?.totalJpy;
  const form = el<HTMLFormElement>("checkout-form");
  if (checkoutBusy || !shop.enabled || !total || !form.reportValidity() || (kind !== "card" && walletRevision !== revision)) return;
  const fields = Object.fromEntries(new FormData(form).entries());
  const items = quantities(), coupon = currentQuote?.coupon ? submittedCoupon : "", key = requestId;
  const acceptedTerms = el<HTMLInputElement>("checkout-terms").checked;
  const contactEmail = shop.buyerEmail ?? String(fields.contactEmail).trim();
  const billingContact = { givenName: String(fields.name), email: contactEmail, phone: String(fields.phone),
    countryCode: "JP", postalCode: String(fields.postalCode).replaceAll("-", ""), state: String(fields.prefecture), city: String(fields.city),
    addressLines: [String(fields.addressLine1), ...(fields.addressLine2 ? [String(fields.addressLine2)] : [])] };
  const verification = { amount: String(total), currencyCode: "JPY", intent: "CHARGE", billingContact };
  checkoutBusy = true;
  try {
    // ウォレットはクリックのユーザー操作を維持してシートを開く．請求はサーバー再検証後のみ．
    const tokenizing = kind === "card" ? (method as SquareCard).tokenize({ ...verification, customerInitiated: true, sellerKeyedIn: false })
      : (method as SquareWallet).tokenize();
    freezeForm(true); buttonState(); message("お支払いの内容を確認しています．");
    const token = await tokenizing;
    if (token.status !== "OK" || !token.token) throw new Error("お支払い方法を確認できませんでした．");
    const walletVerification = kind !== "card" ? await payments?.verifyBuyer(token.token, verification) : undefined;
    let result = await api<Checkout>("/api/shop/checkouts", { requestId: key, items, couponCode: coupon, contactEmail, shipping: { ...fields, country: "JP" }, acceptedTerms });
    if (result.state === "ready") {
      if (result.quote.totalJpy !== total) {
        await api(`/api/shop/checkouts/${result.id}/cancel`, {}).catch(() => {});
        resetAcceptance();
        throw new Error("合計金額が更新されました．金額を確認してからお試しください．");
      }
      message("お支払いを処理しています．ページを閉じずにお待ちください．");
      result = await api<Checkout>(`/api/shop/checkouts/${result.id}/pay`, { sourceId: token.token, verificationToken: walletVerification?.token, confirmedTotalJpy: total });
    }
    if (result.state === "paid") {
      const cart = readCart();
      for (const line of items) {
        const remaining = (cart.get(line.sku) ?? 0) - line.quantity;
        if (remaining > 0) cart.set(line.sku, remaining);
        else cart.delete(line.sku);
      }
      try { writeCart(cart); } catch { /* 注文は支払済みのため，先に購入状況を案内する． */ }
      couponInput().value = "";
      clearShopCoupon();
      location.assign(`/orders?receipt=${result.id}`);
      return;
    }
    if (!["failed", "canceled"].includes(result.state)) {
      location.assign(`/orders?receipt=${result.id}`);
      return;
    }
    resetAcceptance();
    message("お支払いは完了していません．購入状況を確認してからお試しください．");
    await refreshShopState();
  } catch (error) { message((error as Error).message); }
  finally {
    checkoutBusy = false; freezeForm(false);
    el<HTMLInputElement>("checkout-email").disabled = Boolean(shop.buyerEmail);
    for (const input of el("shop-products").querySelectorAll<HTMLInputElement>("input")) {
      input.disabled = !shop.canPurchase || !shop.products.find(p => p.sku === input.dataset.sku)?.available;
    }
    void quote().catch(error => message(error.message));
  }
}
export async function loadShopAdmin(view: string) {
  if (view === "orders") return loadAdminOrders();
  if (view === "coffee") return loadAdminCoffee();
  if (view === "coupons") return loadShopRules();
  if (view === "products") {
    await Promise.all([loadShopRules(), loadAdminStock()]);
  }
  if (view === "connections") {
    await Promise.all([loadShopRules(), loadSquareConnection()]);
  }
}

async function loadSquareConnection() {
  const square = await api<{ connected: boolean; scopes: string[] }>("/api/admin/square");
  el("square-connection-status").textContent = square.connected ? `Squareと接続済み．許可した権限：${square.scopes.join("，")}` : "Squareは未接続，または認証の有効期限が切れています．";
}

async function loadAdminStock() {
  const stock = await api<{ connected: boolean; products: { sku: string; available: number }[] }>("/api/admin/shop/stock");
  el("stock-status").textContent = stock.connected ? "Squareの在庫を一般ショップ・会員ショップ・POSで共用しています．" : "Square接続後に共通在庫を表示します．";
  const names: Record<string, string> = { "HS-COFFEE-MOCHA-10G": "珈琲 1袋", "HS-COFFEE-MOCHA-5PACK": "珈琲 5袋セット", "HS-BOOK-ANOKOTO-A5": "あのことの関係性について" };
  el("admin-stock").replaceChildren(...stock.products.map(product => {
    const card = text("article", "", "ops-metric");
    card.append(text("h3", names[product.sku] ?? product.sku), text("strong", String(product.available)), text("p", product.sku, "small number"));
    return card;
  }));
}
async function loadAdminCoffee() {
  const result = await api<{enabled:boolean;needsAuthorization:boolean;enrollments:{id:string;member_id:string;plan_id:string;state:string;next_billing_date:string}[]}>("/api/admin/coffee");
  el("admin-coffee-status").textContent = result.enabled ? "定期便の受付は有効です．" : result.needsAuthorization ? "カード保存用の顧客作成権限が未許可です．Squareとの接続を更新してください．" : "定期便の受付は停止しています．";
  const list = el("admin-coffee"); list.replaceChildren();
  const names:Record<string,string>={"coffee-daily-30":"毎日30袋","coffee-weekday-20":"平日20袋","coffee-weekend-8":"休日8袋"};
  const states:Record<string,string>={ready:"支払前",activating:"申込確認中",card_required:"カード登録待ち",active:"継続中",action_required:"支払・在庫の確認が必要",review:"決済結果の確認が必要",canceled:"解約済み"};
  if(!result.enrollments.length) list.append(text("p","定期便の申込はありません．","small"));
  for(const enrollment of result.enrollments){
    const row=text("article","","entry");
    row.append(text("h3",`${names[enrollment.plan_id]??enrollment.plan_id}／${states[enrollment.state]??enrollment.state}`),text("p",`会員 ${enrollment.member_id} ／ 申込 ${enrollment.id}`,"small"),text("p",`通常便の次回決済予定 ${enrollment.next_billing_date}`,"small")); list.append(row);
  }
}
const orderStates: Record<string, string> = { ready: "カード確認前", paying: "決済結果を確認中", paid: "支払済み", failed: "支払失敗", canceled: "受付終了", review: "運営確認が必要" };
const noticeStates: Record<string, string> = { pending: "送信待ち", sending: "送信処理中", sent: "配信サービス受付済み", failed: "送信要確認", canceled: "送信取消" };
const orderFilters: Record<string, string> = { pending: "発送待ち", held: "発送保留", review: "決済確認中", shipped: "発送済み" };
const orderDate = new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Tokyo" });
let adminOrders: AdminOrder[] = [];
function orderGroup(order: AdminOrder) {
  if (order.shipment) return "shipped";
  if (order.state === "paid") return order.hold_reason ? "held" : "pending";
  if (["paying", "review"].includes(order.state)) return "review";
  return "";
}

async function loadAdminOrders() {
  const { checkouts } = await api<{ checkouts: AdminOrder[] }>("/api/admin/shop/checkouts");
  adminOrders = checkouts;
  renderAdminOrders();
}

function renderAdminOrders() {
  const filter = el<HTMLSelectElement>("admin-order-filter");
  const query = el<HTMLInputElement>("admin-order-query").value.trim().normalize("NFKC").toLowerCase();
  el("ops-order-summary").replaceChildren(...Object.entries(orderFilters).map(([key, label]) => {
    const button = text("button", "", "ops-metric") as HTMLButtonElement;
    button.type = "button";
    button.setAttribute("aria-pressed", String(key === filter.value));
    button.append(text("span", label), text("strong", String(adminOrders.filter(order => orderGroup(order) === key).length)));
    button.addEventListener("click", () => {
      filter.value = filter.value === key ? "all" : key;
      renderAdminOrders();
      el("ops-order-summary").querySelectorAll<HTMLButtonElement>("button")[Object.keys(orderFilters).indexOf(key)]?.focus();
    });
    return button;
  }));
  const list = el("admin-orders");
  list.replaceChildren();
  for (const order of adminOrders) {
    const group = orderGroup(order);
    if (filter.value !== "all" && filter.value !== group) continue;
    const quote = JSON.parse(order.quote_json) as Quote;
    const lines = quote.lines?.map(line => `${line.name} × ${line.quantity}`).join("，") ?? "";
    if (query && ![order.id, order.square_order_id, lines].join(" ").normalize("NFKC").toLowerCase().includes(query)) continue;
    const row = text("article", "", "ops-order");
    const kind = order.purchase_kind === "coffee-cycle" ? "定期便" : order.purchase_kind === "coffee-trial" ? "お試し便" : "単発購入";
    const title = text("div", "", "ops-heading");
    const badge = text("span", orderFilters[group] ?? orderStates[order.state] ?? order.state, "ops-state");
    badge.dataset.state = group;
    title.append(text("h3", lines || kind), badge);
    row.append(title, text("p", `${orderDate.format(new Date(order.created_at))} ／ ${order.order_channel === "shop" ? "一般ショップ" : "会員ショップ"} ／ ${order.fulfillment_source === "essen" ? "ESSEN直送" : "HackSick発送"} ／ ${kind}`, "small"),
      text("p", `${money(quote.totalJpy)} ／ ${orderStates[order.state] ?? order.state}`, "ops-total"),
      text("p", `受付 ${order.id}`, "small number"));
    if (order.square_order_id) {
      const square = text("a", "Squareで注文を開く ↗", "small") as HTMLAnchorElement;
      square.href = `https://app.squareup.com/dashboard/orders/overview/${encodeURIComponent(order.square_order_id)}`;
      square.target = "_blank";
      square.rel = "noopener noreferrer";
      row.append(square);
    }
    if (order.planned_date && !order.shipment) row.append(text("p", `発送予定日 ${order.planned_date}`, "small"));
    if (order.hold_reason && !order.shipment) row.append(text("p", `保留理由 ${order.hold_reason}`, "small"));
    if (order.review_reason) row.append(text("p", order.review_reason === "stock-conflict" ? "共通在庫の売却状況を確認してください．" : "決済記録の確認が必要です．", "small"));
    if (order.receipt_notice_state) row.append(text("p", `注文受付メール ／ ${noticeStates[order.receipt_notice_state]}`, "small"));
    if (order.shipment) {
      row.append(text("p", `お問い合わせ番号 ${order.shipment.trackingNumbers.join("，")}`, "small"));
      if (order.shipping_notice_state) row.append(text("p", `発送メール ／ ${noticeStates[order.shipping_notice_state]}`, "small"));
    } else if (order.state === "paid" && order.square_order_id) {
      const actions = document.createElement("details");
      actions.append(text("summary", "発送予定・保留を編集"), dispatchForm(order));
      row.append(actions);
      if (!order.hold_reason) {
        const shipment = document.createElement("details");
        shipment.append(text("summary", "発送を登録する"), shipmentForm(order));
        row.append(shipment);
      }
    }
    list.append(row);
  }
  if (!list.childElementCount) list.append(text("p", adminOrders.length ? "条件に一致する注文がありません．" : "注文の受付はありません．", "ops-empty"));
}

function dispatchForm(order: AdminOrder) {
  const form = document.createElement("form");
  const dateLabel = text("label", "発送予定日");
  const date = document.createElement("input"); date.type = "date"; date.value = order.planned_date ?? ""; dateLabel.append(date);
  const holdLabel = text("label", "保留理由（空欄で解除）");
  const hold = document.createElement("input"); hold.maxLength = 240; hold.value = order.hold_reason ?? ""; holdLabel.append(hold);
  const save = text("button", "発送予定・保留を保存");
  form.append(dateLabel, holdLabel, save);
  form.onsubmit = async event => {
    event.preventDefault();
    try { await api(`/api/admin/shop/checkouts/${order.id}/dispatch`, { plannedDate: date.value, holdReason: hold.value }); await loadAdminOrders(); }
    catch(error) { el("admin-orders-status").textContent = (error as Error).message; }
  };
  return form;
}
function shipmentForm(order: AdminOrder) {
  const form = document.createElement("form");
  const label = text("label", "クリックポストのお問い合わせ番号（複数は1行ずつ）");
  const numbers = document.createElement("textarea");
  numbers.required = true;
  numbers.maxLength = 400;
  numbers.rows = 2;
  label.append(numbers);
  const confirmation = text("label", "", "check");
  const dispatched = document.createElement("input");
  dispatched.type = "checkbox";
  dispatched.required = true;
  confirmation.append(dispatched, "投函または配送業者への引き渡しが済みました");
  const carriers = document.createElement("select");
  for (const [value, label] of [["clickpost","クリックポスト"],["japanpost","日本郵便"],["yamato","ヤマト運輸"],["sagawa","佐川急便"]]) carriers.add(new Option(label, value));
  const submit = text("button", "発送を記録して通知する") as HTMLButtonElement;
  submit.type = "submit";
  const status = text("p", "", "small");
  status.setAttribute("role", "status");
  form.append(text("p", "発送登録と同時に，購入者への発送メールを処理します．", "small"),
    label, confirmation, submit, status);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    submit.disabled = true;
    try {
      await api(`/api/admin/shop/checkouts/${order.id}/shipment`, { trackingNumbers: numbers.value, dispatched: dispatched.checked, carrier: carriers.value });
      el("admin-orders-status").textContent = "発送を記録しました．注文欄で通知状況を確認できます．";
      await loadAdminOrders();
    } catch (error) {
      status.textContent = (error as Error).message;
      submit.disabled = false;
    }
  });
  if (order.fulfillment_source === "essen") { const label = text("label", "配送業者"); label.append(carriers); form.prepend(label); }
  return form;
}

export function initializeAdminShopControls() {
  initializeShopRules();
  el("admin-order-filter").addEventListener("change", renderAdminOrders);
  el("admin-order-query").addEventListener("input", renderAdminOrders);
  el("admin-coffee-refresh").addEventListener("click",async()=>{const button=el<HTMLButtonElement>("admin-coffee-refresh");button.disabled=true;try{await api("/api/admin/coffee/reconcile",{});await loadAdminCoffee();}catch(error){el("admin-coffee-status").textContent=(error as Error).message;}finally{button.disabled=false;}});
  el("admin-orders-refresh").addEventListener("click", async () => {
    const button = el<HTMLButtonElement>("admin-orders-refresh");
    button.disabled = true;
    try {
      await api("/api/admin/shop/reconcile", {});
      await loadAdminOrders();
      el("admin-orders-status").textContent = "注文と通知の状況を更新しました．";
    } catch (error) {
      el("admin-orders-status").textContent = (error as Error).message;
    } finally {
      button.disabled = false;
    }
  });
  el("billing-sync").addEventListener("click",async()=>{const button=el<HTMLButtonElement>("billing-sync");button.disabled=true;try{const result=await api<{synced:{paidUntil:string|null}[]}>("/api/admin/billing/sync",{});el("billing-sync-status").textContent=`${result.synced.length}件を照合しました．支払済みの対象期間がある資格は${result.synced.filter(s=>s.paidUntil).length}件です．`;}catch(error){el("billing-sync-status").textContent=(error as Error).message;}finally{button.disabled=false;}});
  el("square-connect").addEventListener("click", async () => {
    try { const result = await api<{ url: string }>("/api/admin/square/authorize", {}); const url = new URL(result.url); if (!["connect.squareup.com", "connect.squareupsandbox.com"].includes(url.hostname) || url.protocol !== "https:") throw new Error("接続先を確認できません．"); window.location.assign(url.href); } catch (error) { el("square-connection-status").textContent = (error as Error).message; }
  });
  el("hsap-import-form").addEventListener("submit", async event => {
    event.preventDefault(); importSnapshot = null; el("hsap-import-commit").hidden = true;
    try { const form = event.currentTarget as HTMLFormElement; const parsed = JSON.parse(String(new FormData(form).get("snapshot"))) as Record<string, unknown>;
      const snapshot = { rows: parsed.rows, source: "https://docs.google.com/spreadsheets/d/1K3RDvJEdyA11cEr6c9Arf4jXgDj6edDKuKADrOzgyf0/edit" };
      const preview = await api("/api/admin/imports/hsap", snapshot); el("hsap-preview").textContent = JSON.stringify(preview, null, 2); importSnapshot = snapshot; el("hsap-import-commit").hidden = false;
    } catch (error) { el("hsap-preview").textContent = (error as Error).message; }
  });
  el("hsap-import-commit").addEventListener("click", async () => {
    const button = el<HTMLButtonElement>("hsap-import-commit");
    if (!importSnapshot || !el<HTMLInputElement>("hsap-emails-verified").checked) { el("hsap-preview").textContent = "本人のメールであることを確認してください．"; return; }
    button.disabled = true;
    try { const result = await api("/api/admin/imports/hsap", { ...importSnapshot, confirmed: true, emailsVerified: true }); el("hsap-preview").textContent = JSON.stringify(result, null, 2); importSnapshot = null; button.hidden = true; } catch (error) { el("hsap-preview").textContent = (error as Error).message; } finally { button.disabled = false; }
  });
}
