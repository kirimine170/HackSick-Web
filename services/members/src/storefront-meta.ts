import { STOREFRONT_PRODUCTS } from "./checkout.ts";
import { shopProductMedia } from "./product-media.ts";

const name = "HackSickショップ";
const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function productNotFound(storefront: boolean) {
  const catalog = storefront ? "/" : "/shop";
  return new Response(`<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>商品が見つかりません｜HackSick</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body class="storefront">
  <header><a class="brand" href="${catalog}">HackSick</a></header>
  <main>
    <h1>商品が見つかりません</h1>
    <a class="store-back" href="${catalog}">商品一覧へ戻る</a>
  </main>
</body>
</html>`, { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export async function storefrontMetadata(response: Response, url: URL) {
  if (!response.ok || !response.headers.get("Content-Type")?.includes("text/html") || !response.body) return response;
  const [sku] = /^\/products\/([A-Z0-9_-]{1,64})$/.exec(url.pathname)?.slice(1) ?? [];
  const product = STOREFRONT_PRODUCTS.find(row => row.sku === sku);
  if (url.pathname !== "/" && !product) return response;

  const media = product ? shopProductMedia(product.bags) : null;
  const photo = media?.images[0] ?? { src: "/og.png", alt: "HackSickのビジュアル", width: 1200, height: 630 };
  const title = product ? `${product.name}｜${name}` : name;
  const description = media?.description ?? "HackSickのドリップバッグ珈琲と書籍を取り扱う公式ショップです．";
  const canonical = new URL(url.pathname, url.origin).href;
  const image = new URL(photo.src, url.origin).href;
  const values = {
    "og:type": "website", "og:locale": "ja_JP", "og:site_name": name, "og:title": title,
    "og:description": description, "og:url": canonical, "og:image": image,
    "og:image:type": photo.src.endsWith(".webp") ? "image/webp" : photo.src.endsWith(".png") ? "image/png" : "image/jpeg",
    "og:image:width": String(photo.width), "og:image:height": String(photo.height), "og:image:alt": photo.alt,
  };
  const tags = Object.entries(values).map(([key, value]) => `<meta property="${key}" content="${escape(value)}">`);
  const robots = url.hostname === "shop.hacksick.com" ? "" : '<meta name="robots" content="noindex,nofollow">';
  const html = (await response.text()).replace('<meta name="robots" content="noindex,nofollow">', [
    robots, `<link rel="canonical" href="${escape(canonical)}">`,
    `<meta name="description" content="${escape(description)}">`, ...tags,
    '<meta name="twitter:card" content="summary_large_image">', `<meta name="twitter:image" content="${escape(image)}">`,
  ].filter(Boolean).join("\n  ")).replace("<title>メンバーシップ｜HackSick</title>", `<title>${escape(title)}</title>`);
  const headers = new Headers(response.headers);
  for (const header of ["Content-Length", "Content-Encoding", "ETag"]) headers.delete(header);
  return new Response(html, { status: response.status, headers });
}
