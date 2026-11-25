import { initializeShopRules } from "./shop-admin-rules-client.ts";
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const money = (n: number) => `${n.toLocaleString("ja-JP")}円`;
const text = (tag: string, value: string, className = "") => { const node = document.createElement(tag); node.textContent = value; node.className = className; return node; };
async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json() as T & { error?: string }; if (!res.ok) throw new Error(data.error ?? "処理を完了できませんでした．"); return data;
}
interface ProductImage { src: string; alt: string; width?: number; height?: number }
type Source = "hacksick" | "essen";
interface Product { fulfillmentSource?: Source; sku: string; name: string; unitPriceJpy: number; bags: number; category: string; description: string; workUrl?: string; images?: ProductImage[] }
interface Shop { wallets?: boolean; essenLocationId?: string; products: (Product & { available: number })[]; policy: { discountPercent: number; recurringDiscountPercent: number; recurringCheckoutEnabled: boolean }; stock: { shared: boolean; available: boolean }; eligible: boolean; canPurchase: boolean; storefront: boolean; enabled: boolean; paymentFormPreview?:boolean; environment: string; applicationId: string; locationId: string; buyerEmail: string }
interface Quote { discountLabel?: string; fulfillmentSource?: Source; subtotalJpy: number; discountPercent: number; discountJpy: number; shippingJpy: number; totalJpy: number; fulfillmentHint?:string; lines?: { name: string; quantity: number }[] }
interface Shipment { label?: string; trackingNumbers: string[]; shippedAt: string; trackingUrl: string }
interface Checkout { dispatch?: {plannedDate:string|null;held:boolean} | null; id: string; state: string; quote: Quote; expiresAt: string; shipment?: Shipment | null }
interface AdminOrder {
  id: string;
  state: string;
  square_order_id: string | null;
  review_reason: string | null;
  quote_json: string;
  purchase_kind: string;
  order_channel?: string;
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
let currentQuote: Quote | null = null;
const cartQuantities = new Map<string, number>();
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
const couponCode = () => el<HTMLInputElement>("checkout-coupon").value.trim();
const selectedProduct = () => location.pathname.match(/^\/products\/([A-Z0-9_-]{1,64})$/)?.[1];
const quantities = () => [...el("shop-products").querySelectorAll<HTMLInputElement>("input[data-sku]")].map(input => ({ sku: input.dataset.sku!, quantity: Number(input.value) })).filter(l => l.quantity !== 0);
const message = (value: string) => { el("checkout-message").textContent = value; };
function buttonState() {
  el<HTMLButtonElement>("checkout-submit").disabled = !shop?.enabled || !shop.canPurchase || !currentQuote || !card || checkoutBusy;
  const walletsReady = Boolean(shop?.enabled && currentQuote && !checkoutBusy && walletRevision === revision);
  el("checkout-wallets").hidden = !walletsReady;
  el("checkout-submit").textContent = currentQuote ? `${money(currentQuote.totalJpy)}を支払って注文する` : "数量と合計金額を確認してください";
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
  el("checkout-returns").textContent = lines.some(line => shop.products.find(p => p.sku === line.sku)?.category === "書籍")
    ? "書籍のお客様都合の返品は受取日から8日以内にご連絡ください．返送料はお客様負担です．食品はお客様都合の返品・交換をお受けできません．不良品・誤配送の返送料はHackSick負担です．"
    : "食品のお客様都合による返品・交換はお受けできません．不良品・誤配送はHackSick負担で対応します．到着後7日以内を目安にshop@hacksick.comへご連絡ください．";
  if (!lines.length) { el("shop-quote").replaceChildren(text("p", "数量を選ぶと，送料を含む合計金額を確認できます．")); return; }
  if (!shop.canPurchase) return;
  const data = await api<Quote>("/api/shop/quote", { items: lines, couponCode: couponCode() }); if (version !== revision) return; currentQuote = data;
  const dl = document.createElement("dl"); dl.className = "price-summary";
  dl.append(text("dt", "商品代金（税込）"), text("dd", money(data.subtotalJpy)));
  if (data.discountJpy) dl.append(text("dt", data.discountLabel ?? `珈琲の会員特典${data.discountPercent}％`), text("dd", money(-data.discountJpy)));
  dl.append(text("dt", "送料"), text("dd", money(data.shippingJpy)), text("dt", "お支払い合計"), text("dd", money(data.totalJpy)));
  el("shop-quote").replaceChildren(dl); buttonState();
  void prepareWallets(version, data);
}
async function refreshOrders() {
  const result = await api<{ checkouts: Checkout[] }>("/api/shop/checkouts"); const container = el("shop-orders"); container.replaceChildren();
  if (!result.checkouts.length) { container.append(text("p", "購入履歴はまだありません．", "small")); return; }
  for (const original of result.checkouts) {
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
async function refreshShopState() {
  shop = await api<Shop>("/api/shop");
  el("shop-status").textContent = !shop.canPurchase ? "購入資格については運営へお問い合わせください．" : !shop.enabled ? "現在，購入受付を確認中です．" : !shop.products.some(p => p.available > 0) ? "現在在庫切れです．" : shop.environment === "sandbox" ? "テスト環境です．実際のカードでは購入しないでください．" : shop.eligible ? `珈琲の単発購入に会員特典${shop.policy.discountPercent}％を適用できます．` : "通常価格でご購入いただけます．";
  el("shop-benefit-description").textContent = `有効なHSAP・月額会員は，珈琲の単品と5袋セットが${shop.policy.discountPercent}％引きです．`;
}
function freezeForm(busy: boolean) {
  for (const field of el("checkout-form").querySelectorAll<HTMLInputElement | HTMLSelectElement>("input,select")) field.disabled = busy;
}
function productPhoto(photo: ProductImage) {
  const link = document.createElement("a"); link.href = photo.src; link.target = "_blank"; link.rel = "noopener"; link.className = "product-photo-link"; link.setAttribute("aria-label", `${photo.alt}の写真を拡大する`);
  const image = document.createElement("img"); image.src = photo.src; image.alt = photo.alt; if (photo.width) image.width = photo.width; if (photo.height) image.height = photo.height; image.loading = "lazy"; image.decoding = "async"; image.className = "product-photo"; link.append(image);
  return link;
}
function productCard(product: Product) {
  const node = text("article", "", "card product-card");
  if (product.images?.[0]) node.append(productPhoto(product.images[0]));
  node.append(text("p", product.category, "small"), text("h3", product.name), text("p", product.description));
  node.append(text("p", `${money(product.unitPriceJpy)}（税込）`));
  if (product.workUrl) {
    const work = text("a", "作品紹介を見る ↗") as HTMLAnchorElement;
    work.href = product.workUrl;
    node.append(work);
  }
  return node;
}

export async function loadStorefrontCatalog() {
  const data = await api<{ products: Product[] }>("/api/storefront");
  const sku = selectedProduct();
  el("catalog-all").hidden = !sku;
  const products = sku ? data.products.filter(product => product.sku === sku) : data.products;
  el("storefront-products").replaceChildren(...products.map(product => {
    const node = productCard(product);
    const link = text("a", sku ? "ログインして購入する" : "商品を見る") as HTMLAnchorElement;
    link.href = sku ? "#login" : `/products/${product.sku}`;
    node.append(link);
    return node;
  }));
  if (!products.length) el("storefront-products").append(text("p","公開中の商品が見つかりません．限定商品はログインしてご確認ください．"));
}

function renderCartProducts() {
  const products = el("shop-products");
  products.replaceChildren();
  const sku = selectedProduct();
  for (const product of shop.products.filter(product => (product.fulfillmentSource ?? "hacksick") === source())) {
    const node = productCard(product);
    node.append(text("p", shop.stock.available ? `在庫 ${product.available}${product.category === "書籍" ? "冊" : product.bags === 0 ? "点" : product.bags === 1 ? "袋" : "セット"}` : "在庫を確認中", "small"));
    if (product.images?.[1]) { const labelPhoto = document.createElement("details"); labelPhoto.className = "product-label-photo"; labelPhoto.append(text("summary", "裏面ラベルを見る"), productPhoto(product.images[1])); node.append(labelPhoto); }
    for (const photo of product.images?.slice(2) ?? []) {
      const scene = document.createElement("details");
      scene.className = "product-label-photo";
      scene.append(text("summary", "淹れている様子を見る"), productPhoto(photo));
      node.append(scene);
    }
    const label = document.createElement("label"); label.textContent = "数量"; const input = document.createElement("input"); input.type = "number"; input.min = "0"; input.max = String(Math.min(100, product.available)); input.step = "1"; input.value = String(Math.min(product.available, cartQuantities.get(product.sku) ?? (sku === product.sku && shop.canPurchase ? 1 : 0))); input.dataset.sku = product.sku;
    input.disabled = !shop.canPurchase || !product.available; input.addEventListener("input", () => { cartQuantities.set(product.sku, Number(input.value)); resetAcceptance(); void quote().catch(e => message(e.message)); }); label.append(input); node.append(label); products.append(node);
  }
}

export async function loadShop(manager: boolean) {
  el("shop").hidden = false;
  await refreshShopState();
  const hasEssen = shop.products.some(p => p.fulfillmentSource === "essen");
  el("checkout-source-label").hidden = !hasEssen;
  el("checkout-source-note").hidden = !hasEssen;
  el<HTMLSelectElement>("checkout-source").value = shop.products.find(p => p.sku === selectedProduct())?.fulfillmentSource ?? "hacksick";
  renderCartProducts();
  if (!initialized) {
    initialized = true;
    const prefectures = "北海道 青森県 岩手県 宮城県 秋田県 山形県 福島県 茨城県 栃木県 群馬県 埼玉県 千葉県 東京都 神奈川県 新潟県 富山県 石川県 福井県 山梨県 長野県 岐阜県 静岡県 愛知県 三重県 滋賀県 京都府 大阪府 兵庫県 奈良県 和歌山県 鳥取県 島根県 岡山県 広島県 山口県 徳島県 香川県 愛媛県 高知県 福岡県 佐賀県 長崎県 熊本県 大分県 宮崎県 鹿児島県 沖縄県".split(" ");
    for (const p of prefectures) { const option = document.createElement("option"); option.value = p; option.textContent = p; el("prefectures").append(option); }
    el("checkout-form").addEventListener("submit", event => { event.preventDefault(); if (card && cardLocation === (source() === "essen" ? shop.essenLocationId : shop.locationId)) void completePurchase(card, "card"); });
    el("checkout-apple").addEventListener("click", () => { if (apple) void completePurchase(apple, "apple"); });
    el("checkout-google").addEventListener("click", event => { event.preventDefault(); if (google) void completePurchase(google, "google"); });
    el("checkout-source").addEventListener("change", () => {
      resetAcceptance();
      ++revision; currentQuote = null; buttonState();
      renderCartProducts();
      void loadCard().then(quote).catch(error => message(error.message));
    });
    el("checkout-coupon").addEventListener("change", () => { resetAcceptance(); void quote().catch(error => message(error.message)); });
    for (const input of el("checkout-form").querySelectorAll<HTMLInputElement | HTMLSelectElement>(".shipping-form input:not([name=terms]),.shipping-form select")) {
      input.addEventListener("change", resetAcceptance);
    }
    el("orders-refresh").addEventListener("click", () => { void refreshOrders().catch(e => message(e.message)); });
  }
  await loadCard().catch(error=>message((error as Error).message)); await quote(); await refreshOrders(); if (manager) await loadShopAdmin();
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
  const items = quantities(), coupon = couponCode(), key = requestId;
  const acceptedTerms = el<HTMLInputElement>("checkout-terms").checked;
  const billingContact = { givenName: String(fields.name), email: shop.buyerEmail, phone: String(fields.phone),
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
    let result = await api<Checkout>("/api/shop/checkouts", { requestId: key, items, couponCode: coupon, shipping: { ...fields, country: "JP" }, acceptedTerms });
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
      message(`ご注文を受け付けました．お支払い ${money(result.quote.totalJpy)}．受付番号 ${result.id}`);
      resetAcceptance(); el<HTMLInputElement>("checkout-coupon").value = "";
      for (const input of el("shop-products").querySelectorAll<HTMLInputElement>("input")) {
        if (input.dataset.sku) cartQuantities.set(input.dataset.sku, 0);
        input.value = "0";
      }
    } else if (["failed","canceled"].includes(result.state)) {
      resetAcceptance(); message("お支払いは完了していません．購入状況を確認してからお試しください．");
    } else message("お支払い結果を確認中です．もう一度支払わず，購入状況をご確認ください．");
    await refreshShopState(); await refreshOrders();
  } catch (error) { message((error as Error).message); await refreshOrders().catch(() => {}); }
  finally {
    checkoutBusy = false; freezeForm(false);
    for (const input of el("shop-products").querySelectorAll<HTMLInputElement>("input")) {
      input.disabled = !shop.canPurchase || !shop.products.find(p => p.sku === input.dataset.sku)?.available;
    }
    void quote().catch(error => message(error.message));
  }
}
export async function loadShopAdmin() {
  el("shop-admin").hidden = false;
  initializeShopRules();
  await loadAdminOrders();
  const square = await api<{ connected: boolean; scopes: string[] }>("/api/admin/square");
  el("square-connection-status").textContent = square.connected ? `Squareと接続済み．許可した権限：${square.scopes.join("，")}` : "Squareは未接続，または認証の有効期限が切れています．";
  const stock = await api<{ shared: boolean; connected: boolean; products: { sku: string; available: number }[] }>("/api/admin/shop/stock");
  el("stock-status").textContent = stock.connected ? `一般ストア・POSと同じSquare在庫を使用します．${stock.products.map(p => `${p.sku}：${p.available}`).join(" ／ ")}` : "Square接続後に共通在庫を表示します．";
  await loadAdminCoffee();
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
el("admin-coffee-refresh").addEventListener("click",async()=>{const button=el<HTMLButtonElement>("admin-coffee-refresh");button.disabled=true;try{await api("/api/admin/coffee/reconcile",{});await loadAdminCoffee();await loadAdminOrders();}catch(error){el("admin-coffee-status").textContent=(error as Error).message;}finally{button.disabled=false;}});
async function loadAdminOrders() {
  const { checkouts } = await api<{ checkouts: AdminOrder[] }>("/api/admin/shop/checkouts");
  const list = el("admin-orders");
  list.replaceChildren();
  if (!checkouts.length) list.append(text("p", "注文の受付はありません．", "small"));
  const orderStates: Record<string, string> = { ready: "カード確認前", paying: "決済結果を確認中", paid: "支払済み", failed: "支払失敗", canceled: "受付終了", review: "運営確認が必要" };
  const noticeStates: Record<string, string> = { pending: "送信待ち", sending: "送信処理中", sent: "配信サービス受付済み", failed: "送信要確認", canceled: "送信取消" };
  for (const order of checkouts) {
    const row = text("article", "", "entry");
    const quote = JSON.parse(order.quote_json) as Quote;
    const kind = order.purchase_kind === "coffee-cycle" ? "定期便" : order.purchase_kind === "coffee-trial" ? "お試し便" : "単発購入";
    row.append(text("h3", `${order.fulfillment_source === "essen" ? "ESSEN直送" : "HackSick発送"} ／ ${kind} ／ ${orderStates[order.state] ?? order.state} ／ ${money(quote.totalJpy)}`),
      text("p", `受付 ${order.id} ／ Square注文 ${order.square_order_id ?? "未作成"}`, "small"));
    if (quote.lines?.length) row.append(text("p", quote.lines.map(line => `${line.name} × ${line.quantity}`).join("，"), "small"));
    if (order.review_reason) row.append(text("p", order.review_reason === "stock-conflict" ? "共通在庫の売却状況を確認してください．" : "決済記録の確認が必要です．", "small"));
    if (order.receipt_notice_state) row.append(text("p", `注文受付メール ／ ${noticeStates[order.receipt_notice_state]}`, "small"));
    if (order.shipment) {
      row.append(text("p", `発送済み ／ ${order.shipment.trackingNumbers.join("，")}`, "small"));
      if (order.shipping_notice_state) row.append(text("p", `発送メール ／ ${noticeStates[order.shipping_notice_state]}`, "small"));
    } else if (order.state === "paid" && order.square_order_id) {
      row.append(dispatchForm(order));
      if (!order.hold_reason) row.append(shipmentForm(order));
    }
    list.append(row);
  }
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
  form.append(label, confirmation, submit, status);
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
  try { const result = await api<{ url: string }>("/api/admin/square/authorize", {}); const url = new URL(result.url); if (!["connect.squareup.com", "connect.squareupsandbox.com"].includes(url.hostname) || url.protocol !== "https:") throw new Error("接続先を確認できません．"); window.location.assign(url.href); } catch (error) { message((error as Error).message); }
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
