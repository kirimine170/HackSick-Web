CREATE TABLE shop_coupon_stacking (
  coupon_id TEXT PRIMARY KEY NOT NULL REFERENCES shop_coupons(id) ON DELETE CASCADE
);
