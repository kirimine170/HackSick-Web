// 商品の写真を同一オリジンで配信する．
export const COFFEE_IMAGES = [
  { src: "/images/burn-the-midnight-oil-front.jpg", alt: "Burn the midnight oilのドリップバッグ個包装，表面", width: 1536, height: 1024 },
  { src: "/images/burn-the-midnight-oil-back.jpg", alt: "Burn the midnight oilのドリップバッグ個包装，原材料・内容量・賞味期限などを記載した裏面ラベル", width: 1536, height: 1024 },
] as const;

export const COFFEE_SET_IMAGE = {
  src: "/images/burn-the-midnight-oil-5pack.jpg",
  alt: "Burn the midnight oilのドリップバッグ個包装を5袋並べた写真",
  width: 1800,
  height: 1201,
} as const;

export const COFFEE_BREWING_IMAGE = {
  src: "/images/burn-the-midnight-oil-brewing.jpg",
  alt: "カップに掛けたドリップバッグにお湯を注いで珈琲を淹れている様子",
  width: 1800,
  height: 1201,
} as const;

export function shopProductMedia(bags: number) {
  if (bags > 0) return {
    category: "珈琲",
    description: "イエメン・モカマタリのフィルター付きドリップバッグ．1袋10g．",
    images: bags > 1
      ? [COFFEE_SET_IMAGE, COFFEE_IMAGES[1], COFFEE_BREWING_IMAGE]
      : [...COFFEE_IMAGES, COFFEE_BREWING_IMAGE],
  };
  return {
    category: "書籍",
    description: "松見公園による漫画短編集．A5判・四編収録．",
    workUrl: "https://hacksick.com/works/anokoto-no-kankeisei-ni-tsuite/",
    images: [{ src: "/images/anokoto-cover.webp", alt: "『あのことの関係性について』の表紙", width: 640, height: 908 }],
  };
}
