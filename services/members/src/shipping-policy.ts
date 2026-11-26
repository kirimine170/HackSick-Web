// 公開中の通常購入と，会員向け定期便の料金試算で共通の送料条件．
// 送料500円は税込の顧客負担額．商品代金の割引前・税込額で送料無料を判定する．
export const SHIPPING_POLICY = {
  shippingFeeJpy: 500,
  freeShippingThresholdJpy: 5000,
  freeShippingBasis: "goods-before-discount-including-tax",
} as const;
export const JAPAN_POST_TRACKING_URL = "https://trackings.post.japanpost.jp/services/srv/search";
