-- cronの重複起動は，注文決済の直列化とは別のリースで防ぐ．
CREATE TABLE coffee_billing_lock (
  id INTEGER PRIMARY KEY CHECK(id=1),
  owner TEXT,
  expires_at TEXT NOT NULL
);
INSERT INTO coffee_billing_lock VALUES (1,NULL,'1970-01-01T00:00:00.000Z');
