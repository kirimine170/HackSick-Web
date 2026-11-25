import { test } from "node:test";
import assert from "node:assert/strict";
import { eligibility, normalizeEmail, validateGrant } from "../src/eligibility.ts";
import type { Grant } from "../src/types.ts";

const now = new Date("2026-11-03T12:00:00Z");
const paid: Grant = { id: "grant-1", kind: "MONTHLY", valid_from: "2026-10-31T15:00:00.000Z", valid_until: "2026-11-30T15:00:00.000Z", revoked_at: null, evidence_id: "confirmed-payment" };
const hsap: Grant = { ...paid, id: "grant-2", kind: "HSAP", valid_until: null, evidence_id: "HSAP-000001" };

test("HSAPと月額会員の重複資格でも割引は10％", () => {
  assert.deepEqual(eligibility("active", [paid, hsap], now), { eligible: true, discountPercent: 10, reasons: ["MONTHLY", "HSAP"] });
});

test("開始日時は含み，終了日時は含まない", () => {
  assert.equal(eligibility("active", [paid], new Date(paid.valid_from)).eligible, true);
  assert.equal(eligibility("active", [paid], new Date(paid.valid_until!)).eligible, false);
});

test("次の支払済み期間があっても，未払い期間の穴は埋めない", () => {
  const old = { ...paid, valid_until: "2026-11-01T00:00:00Z" };
  const future = { ...paid, id: "future", valid_from: "2026-11-05T00:00:00Z" };
  assert.equal(eligibility("active", [old, future], now).eligible, false);
});

test("利用停止，取消，期限不正，月額の無期限資格は対象外", () => {
  assert.equal(eligibility("blocked", [paid, hsap], now).eligible, false);
  assert.equal(eligibility("active", [{ ...paid, revoked_at: "2026-11-02T00:00:00Z" }], now).eligible, false);
  assert.equal(eligibility("active", [{ ...paid, valid_until: null }], now).eligible, false);
  assert.equal(eligibility("active", [{ ...paid, valid_from: "invalid" }], now).eligible, false);
});

test("月額資格は入金根拠と終了日時を必須にする", () => {
  const body = { kind: "MONTHLY", validFrom: "2026-11-01T00:00:00+09:00", validUntil: "2026-12-01T00:00:00+09:00", evidenceId: "payment-confirmed", reason: "請求と入金の対象期間を照合済み" };
  assert.equal(validateGrant(body).validUntil, "2026-11-30T15:00:00.000Z");
  assert.throws(() => validateGrant({ ...body, validUntil: null }));
  assert.throws(() => validateGrant({ ...body, evidenceId: "" }));
  assert.throws(() => validateGrant({ ...body, validUntil: body.validFrom }));
  assert.throws(() => validateGrant({ ...body, validFrom: "2026-11-01T00:00:00" }));
  assert.throws(() => validateGrant({ ...body, validFrom: "2026-02-30T00:00:00Z" }));
});

test("メールの大文字・小文字を統一し，アドレス形式を検証する", () => {
  assert.equal(normalizeEmail(" Member@Example.COM "), "member@example.com");
  assert.throws(() => normalizeEmail("shared address"));
});
