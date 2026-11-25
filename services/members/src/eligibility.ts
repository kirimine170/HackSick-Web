import type { Grant } from "./types.ts";
import { BUSINESS_POLICY } from "./business-policy.ts";

/** 有効期間はUTCの [開始，終了)．月末の計算や支払期間の推測は行わない． */
export function eligibility(memberStatus: string, grants: Grant[], now = new Date()) {
  const instant = now.getTime();
  const active = memberStatus === "active" ? grants.filter((grant) => {
    if (grant.kind === "MONTHLY" && grant.valid_until === null) return false;
    const start = Date.parse(grant.valid_from);
    const end = grant.valid_until === null ? Infinity : Date.parse(grant.valid_until);
    const revoked = grant.revoked_at === null ? Infinity : Date.parse(grant.revoked_at);
    return instant < revoked && Number.isFinite(start) && start <= instant && instant < end;
  }) : [];
  return {
    eligible: active.length > 0,
    discountPercent: active.length > 0 ? BUSINESS_POLICY.commerce.memberDiscountPercent : 0,
    reasons: [...new Set(active.map((grant) => grant.kind))],
  };
}

export class InputError extends Error {}

export function requiredText(value: unknown, field: string, max = 255) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new InputError(`${field}を確認してください．`);
  return value.trim();
}

export function normalizeEmail(value: unknown) {
  const email = requiredText(value, "メールアドレス", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new InputError("メールアドレスを確認してください．");
  return email;
}

export function validateGrant(body: Record<string, unknown>) {
  if (body.kind !== "HSAP" && body.kind !== "MONTHLY") throw new InputError("資格の種類を確認してください．");
  const validFrom = timestamp(body.validFrom);
  const validUntil = body.validUntil ? timestamp(body.validUntil) : null;
  if (body.kind === "MONTHLY" && !validUntil) throw new InputError("月額会員には支払確認済み期間の終了日時が必要です．");
  if (validUntil && validUntil <= validFrom) throw new InputError("終了日時は開始日時より後にしてください．");
  return {
    kind: body.kind,
    validFrom,
    validUntil,
    evidenceId: requiredText(body.evidenceId, body.kind === "MONTHLY" ? "確認済みのSquare Payment ID" : "HSAP台帳の会員ID"),
    reason: requiredText(body.reason, "確認内容", 1000),
  };
}

export function timestamp(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new InputError("日時にはタイムゾーンを含めてください．");
  }
  const [year, month, day, hour, minute, second] = value.slice(0, 19).split(/[-T:]/).map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) {
    throw new InputError("日時を確認してください．");
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new InputError("日時を確認してください．");
  return date.toISOString();
}
