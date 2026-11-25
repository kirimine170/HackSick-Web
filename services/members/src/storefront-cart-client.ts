const storageKey = "hacksick-shop-cart";

export function readCart(): Map<string, number> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return new Map();
    return new Map(Object.entries(stored).filter(([sku, count]) =>
      /^[A-Z0-9_-]{1,64}$/.test(sku) && Number.isInteger(count) && count >= 1 && count <= 100));
  } catch {
    return new Map();
  }
}

export function updateCartCount() {
  const count = [...readCart().values()].reduce((sum, quantity) => sum + quantity, 0);
  document.getElementById("cart-count")!.textContent = String(count);
}

export function writeCart(cart: Map<string, number>) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(cart)));
  } catch {
    throw new Error("カートを保存できませんでした．ブラウザのサイトデータ設定をご確認ください．");
  }
  updateCartCount();
}
