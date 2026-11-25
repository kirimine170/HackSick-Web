-- Squareの在庫反映は非同期．売却の調整記録と集計時刻を確認するまで確保を継続する．
ALTER TABLE member_orders ADD COLUMN inventory_synced INTEGER NOT NULL DEFAULT 0 CHECK(inventory_synced IN (0,1));
CREATE INDEX member_orders_inventory_pending ON member_orders(state,inventory_synced);
