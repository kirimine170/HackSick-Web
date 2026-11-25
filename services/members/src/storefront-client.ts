import { loadCoffee } from "./coffee-client.ts";
import { loadShop, loadStorefrontOrders, prefillShippingAddress, productGallery, productPhoto, type Product, type ShippingAddress, type Shop } from "./shop-client.ts";
import { readCart, updateCartCount, writeCart } from "./storefront-cart-client.ts";

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const money = (amount: number) => `${amount.toLocaleString("ja-JP")}円`;
const query = new URLSearchParams(location.search);
const keyword = (query.get("q") ?? "").trim().slice(0, 100);
const category = query.get("category");
const sku = location.pathname.match(/^\/products\/([A-Z0-9_-]{1,64})$/)?.[1];
const page = sku ? "product" : location.pathname !== "/" ? location.pathname.slice(1)
  : query.get("view") === "cart" || location.hash === "#shop" ? "cart"
    : ["#coffee", "#storefront-coffee"].includes(location.hash) ? "coffee" : location.hash === "#login" ? "login" : "catalog";
const titles: Record<string, string> = { cart: "ショッピングカート", checkout: "お会計", orders: "購入状況", coffee: "珈琲の定期便", login: "ログイン" };

function node<T extends keyof HTMLElementTagNameMap>(tag: T, label = "", className = "") {
  const element = document.createElement(tag);
  element.textContent = label;
  if (className) element.className = className;
  return element;
}
function link(href: string, label: string, className = "") {
  const element = node("a", label, className);
  element.href = href;
  return element;
}
async function get<T>(path: string): Promise<T> {
  const result = await fetch(path, { cache: "no-store" });
  if (!result.ok) throw Error("情報を読み込めませんでした．ページを再読み込みしてください．");
  return result.json();
}
const searchable = (value: string) => value.normalize("NFKC").toLocaleLowerCase("ja-JP")
  .replaceAll("コーヒー", "珈琲").replaceAll("こーひー", "珈琲");

export function configureStorefront() {
  document.body.classList.add("storefront");
  document.title = titles[page] ? `${titles[page]}｜HackSickショップ` : "HackSickショップ";
  el("page-title").textContent = titles[page] ?? "HackSickショップ";
  el("page-title").classList.toggle("store-sr-only", page === "catalog" || page === "product");
  el("brand-label").textContent = "SHOP";
  el<HTMLAnchorElement>("brand-link").href = "/";
  el<HTMLAnchorElement>("shop-nav").href = "/";
  el("shop-nav").textContent = "商品一覧";
  el<HTMLAnchorElement>("coffee-nav").href = "/coffee";
  el<HTMLAnchorElement>("coffee-login").href = "/login?return=/coffee";
  el("member-eyebrow").hidden = true;
  el("store-search").hidden = false;
  el<HTMLInputElement>("store-search-input").value = keyword;
  el("cart-nav").hidden = false;
  el("orders-nav").hidden = false;
  el("login-eyebrow").hidden = true;
  el("login-title").textContent = "メールアドレスでログイン";
  el("login-description").textContent = "会員価格・クーポン・定期便にはメールでの本人確認が必要です．単発購入はゲストでもご利用いただけます．";
  el("email-label").textContent = "メールアドレス";
  el("login-note").textContent = "確認コードの有効期限は5分です．";
  updateCartCount();
  window.addEventListener("storage", updateCartCount);
  window.addEventListener("pageshow", event => {
    if (event.persisted && ["cart", "checkout"].includes(page)) location.reload();
    else updateCartCount();
  });
}

async function catalog() {
  el("storefront-catalog").hidden = false;
  el("storefront-hero").hidden = Boolean(keyword || category);
  const { products } = await get<{ products: Product[] }>("/api/storefront");
  const categories = [{ key: "coffee", label: "珈琲" }, { key: "books", label: "書籍" },
    ...products.some(product => product.category === "限定商品") ? [{ key: "limited", label: "限定商品" }] : []];
  const current = categories.find(option => option.key === category);
  el("store-categories").replaceChildren(...[{ key: "", label: "すべて" }, ...categories].map(option => {
    const params = new URLSearchParams();
    if (keyword) params.set("q", keyword);
    if (option.key) params.set("category", option.key);
    const tab = link(params.size ? `/?${params}` : "/", option.label);
    if (option.key === (current?.key ?? "")) tab.setAttribute("aria-current", "page");
    return tab;
  }));
  const words = searchable(keyword).split(/\s+/).filter(Boolean);
  const items = products.filter(product => {
    if (current && product.category !== current.label) return false;
    const aliases = product.category === "珈琲" ? "coffee ドリップ" : product.category === "書籍" ? "book 本 漫画" : "";
    const fields = searchable([product.name, product.category, product.description, product.sku, aliases].join(" "));
    return words.every(word => fields.includes(word));
  });
  el("storefront-title").textContent = keyword ? `「${keyword}」の検索結果` : current?.label ?? "すべての商品";
  el("store-search-result").textContent = `${items.length}件`;
  const container = el("storefront-products");
  container.replaceChildren(...items.map((product, index) => {
    const article = node("article", "", "store-card");
    const item = link(`/products/${product.sku}`, "");
    const photo = product.images?.[0];
    if (photo) {
      const image = node("img");
      image.src = photo.src;
      image.alt = photo.alt;
      if (index >= 3) image.loading = "lazy";
      image.decoding = "async";
      item.append(image);
    }
    const details = node("div", "", "store-card-copy");
    details.append(node("p", product.category, "store-category"), node("h3", product.name),
      node("p", `${money(product.unitPriceJpy)}（税込）`, "store-price"));
    item.append(details);
    article.append(item);
    return article;
  }));
  if (!items.length) {
    const empty = node("div", "", "store-empty");
    empty.append(node("p", "条件に一致する商品がありませんでした．"), link("/", "すべての商品を見る"));
    container.append(empty);
  }
}

async function productDetail() {
  const container = el("storefront-product");
  container.hidden = false;
  const shop = await get<Shop>("/api/shop");
  const product = shop.products.find(item => item.sku === sku);
  const referrer = new URL(document.referrer || location.origin);
  const listUrl = referrer.origin === location.origin && referrer.pathname === "/" ? "/" + referrer.search : "/";
  const back = link(listUrl, "商品一覧", "store-back");
  if (!product) {
    el("page-title").hidden = false;
    el("page-title").classList.remove("store-sr-only");
    el("page-title").textContent = "商品が見つかりません";
    container.replaceChildren(node("p", "公開中の商品をご確認ください．"), back);
    return;
  }
  document.title = `${product.name}｜HackSickショップ`;
  el("page-title").hidden = true;
  const layout = node("div", "", "store-product-layout");
  const photo = product.images?.[0];
  if (photo) layout.append(product.images!.length > 1 ? productGallery(product, product.images!) : productPhoto(photo));
  const info = node("div", "", "store-product-info");
  info.append(node("p", product.category, "store-category"), node("h1", product.name),
    node("p", `${money(product.unitPriceJpy)}（税込）`, "store-price"), node("p", product.description));
  if (product.workUrl) info.append(link(product.workUrl, "作品紹介を見る ↗"));
  const group = product.fulfillmentSource ?? "hacksick";
  if (group === "essen") info.append(node("p", "ESSEN直送", "small"));
  const form = node("form", "", "store-add");
  const add = readCart().get(product.sku) ?? 0;
  const remaining = Math.min(100, product.available) - add;
  const label = node("label", "数量");
  const quantity = node("input");
  quantity.type = "number"; quantity.min = "1"; quantity.max = String(Math.max(1, remaining));
  quantity.step = "1"; quantity.value = "1"; quantity.required = true;
  const submit = node("button", "カートに入れる", "store-action");
  submit.disabled = !shop.enabled || !shop.canPurchase || remaining <= 0;
  quantity.disabled = submit.disabled;
  const status = node("p", !shop.stock.available ? "在庫を確認できませんでした．" : !product.available ? "在庫切れ"
    : !shop.enabled || !shop.canPurchase ? "現在，購入受付を停止しています．"
      : remaining <= 0 ? "購入できる数量がカートに入っています．" : "在庫あり", "small");
  status.setAttribute("role", "status");
  label.append(quantity); form.append(label, submit);
  form.addEventListener("submit", event => {
    event.preventDefault();
    const cart = readCart();
    const amount = (cart.get(product.sku) ?? 0) + Number(quantity.value);
    if (!Number.isInteger(amount) || amount < 1 || amount > Math.min(100, product.available)) {
      status.textContent = "在庫数に合わせて数量を選び直してください．";
      return;
    }
    try { cart.set(product.sku, amount); writeCart(cart); }
    catch (error) { status.textContent = (error as Error).message; return; }
    location.assign(`/cart?from=${group}`);
  });
  info.append(status, form, node("p", "国内送料500円．割引前の税込商品代金5,000円以上で送料無料．通常は決済後5日以内に出荷します．", "store-shipping"));
  layout.append(info);
  container.replaceChildren(back, layout);
}

export async function loadStorefront(signedIn: boolean, coffeeAvailable: boolean) {
  el("notice").textContent = "";
  el("store-sign-in").hidden = signedIn || page === "login";
  el("logout").hidden = !signedIn;
  el("coffee-nav").hidden = !coffeeAvailable && page !== "coffee";
  if (page === "login") {
    if (signedIn) {
      const target = new URL(query.get("return") ?? "/", location.origin);
      location.replace(target.origin === location.origin && /^\/(?:cart|checkout|coffee|orders|)$/.test(target.pathname) ? target.href : "/");
      return;
    }
    el("login").hidden = false;
    return;
  }
  if (page === "cart" || page === "checkout") {
    el("shop-heading").hidden = true;
    el("shop-benefit-description").hidden = true;
    el("shop-order-section").hidden = true;
    el("shop-status").classList.add("small");
    el("shop").dataset.view = page;
    const back = link(page === "checkout" ? "/cart" : "/", page === "checkout" ? "カートに戻る" : "買い物を続ける", "store-back");
    el("shop").prepend(back);
    await loadShop(false, page);
    return;
  }
  if (page === "orders") {
    el("shop").hidden = false;
    el("shop-heading").hidden = true;
    el("shop-benefit-description").hidden = true;
    el("shop-status").hidden = true;
    el("shop-shipping-policy").hidden = true;
    el("checkout-form").hidden = true;
    el("shop-orders-title").hidden = true;
    await loadStorefrontOrders();
    return;
  }
  if (page === "coffee") {
    el("coffee").hidden = false;
    el("coffee-title").classList.add("store-sr-only");
    el("coffee-guest").hidden = signedIn || !coffeeAvailable;
    if (signedIn) {
      const [, { shippingAddress }] = await Promise.all([loadCoffee(), get<{ shippingAddress: ShippingAddress | null }>("/api/shop/shipping-address")]);
      prefillShippingAddress("coffee-form", shippingAddress);
    }
    return;
  }
  if (page === "product") await productDetail();
  else await catalog();
}
