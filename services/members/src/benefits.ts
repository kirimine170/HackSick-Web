import { BUSINESS_POLICY } from "./business-policy.ts";
import { eligibility, timestamp, InputError } from "./eligibility.ts";
import type { Grant } from "./types.ts";

export type BenefitKind = "LT_WAIVER" | "JOIN_STICKER" | "LOYALTY_STICKER" | "SPEAKER_STICKER" | "FIRST_TALK_COFFEE";
export interface Redemption { kind: BenefitKind; benefit_key: string; event_id: string | null }
export interface BenefitContext { eventId?: string; eventAt?: string; speakerConfirmed?: boolean; firstTalkConfirmed?: boolean }

export function tokyoMonth(at: Date) {
  return new Date(at.getTime() + 9 * 3600000).toISOString().slice(0, 7);
}

/** 日本時間の暦月．月末は移動先の最終日に丸め，常に元の開始日を基準にする． */
export function addTokyoMonths(from: string, months: number) {
  const local = new Date(Date.parse(from) + 9 * 3600000);
  const endOfMonth = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + months, Math.min(local.getUTCDate(), endOfMonth), local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds(), local.getUTCMilliseconds()) - 9 * 3600000).toISOString();
}

export function continuousMembershipStart(grants: Grant[], now: Date) {
  const intervals = grants.flatMap(grant => {
    if (grant.kind === "MONTHLY" && grant.valid_until === null) return [];
    const start = Date.parse(grant.valid_from);
    const end = Math.min(grant.valid_until === null ? Infinity : Date.parse(grant.valid_until), grant.revoked_at === null ? Infinity : Date.parse(grant.revoked_at));
    return Number.isFinite(start) && end > start ? [{ start, end }] : [];
  }).sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end); else merged.push({ ...interval });
  }
  const current = merged.find(interval => interval.start <= now.getTime() && now.getTime() < interval.end);
  return current ? new Date(current.start).toISOString() : null;
}

export function nextLoyaltySticker(grants: Grant[], redemptions: Redemption[], now: Date) {
  const start = continuousMembershipStart(grants, now);
  if (!start) return null;
  for (let months = BUSINESS_POLICY.gifts.stickerIntervalMonths; ; months += BUSINESS_POLICY.gifts.stickerIntervalMonths) {
    const due = addTokyoMonths(start, months);
    if (Date.parse(due) > now.getTime()) return null;
    if (!redemptions.some(row => row.kind === "LOYALTY_STICKER" && row.benefit_key === due)) return due;
  }
}

export function decideBenefit(input: { kind: BenefitKind; memberStatus: string; grants: Grant[]; redemptions: Redemption[]; context?: BenefitContext }, now = new Date()) {
  const context = input.context ?? {};
  const eventBenefit = ["LT_WAIVER", "SPEAKER_STICKER", "FIRST_TALK_COFFEE"].includes(input.kind);
  if (eventBenefit && (!context.eventId?.trim() || !context.eventAt)) throw new InputError("イベントIDと開催日時が必要です．");
  const at = eventBenefit ? new Date(timestamp(context.eventAt)) : now;
  const member = eligibility(input.memberStatus, input.grants, at);
  let key: string;
  let funding: "HSAP" | "MONTHLY" | "PROMOTION" = "PROMOTION";
  if (input.memberStatus !== "active") return { allowed: false as const, reason: "利用状態を確認してください．" };
  if (input.kind === "LT_WAIVER") {
    if (!member.eligible) return { allowed: false as const, reason: "開催日時に有効な会員資格がありません．" };
    key = tokyoMonth(at);
    // 両方の資格がある場合は月額会員枠を優先し，HSAPへ二重配賦しない．
    funding = member.reasons.includes("MONTHLY") ? "MONTHLY" : "HSAP";
  } else if (input.kind === "JOIN_STICKER") {
    if (!member.eligible) return { allowed: false as const, reason: "有効な会員資格がありません．" };
    key = "first-join";
  } else if (input.kind === "LOYALTY_STICKER") {
    if (!member.eligible) return { allowed: false as const, reason: "有効な会員資格がありません．" };
    const due = nextLoyaltySticker(input.grants, input.redemptions, now);
    if (!due) return { allowed: false as const, reason: "未提供の継続6か月特典はありません．" };
    key = due;
  } else if (input.kind === "SPEAKER_STICKER" || input.kind === "FIRST_TALK_COFFEE") {
    if (!context.speakerConfirmed) return { allowed: false as const, reason: "登壇者であることの確認が必要です．" };
    if (input.kind === "FIRST_TALK_COFFEE" && !context.firstTalkConfirmed) return { allowed: false as const, reason: "初登壇の確認が必要です．履歴が空という理由だけでは認定しません．" };
    key = input.kind === "SPEAKER_STICKER" ? context.eventId!.trim() : "first-talk";
  } else { throw new InputError("特典の種類を確認してください．"); }
  const prior = input.redemptions.find(row => row.kind === input.kind && row.benefit_key === key);
  if (prior) return { allowed: false as const, reason: "この期間・イベントの特典は提供済みです．" };
  return {
    allowed: true as const, key, funding, occurredAt: at.toISOString(),
    internalAllocationJpy: input.kind === "LT_WAIVER" && funding === "HSAP" ? BUSINESS_POLICY.events.hsapAllocationPerWaiverJpy : 0,
  };
}

export async function recordBenefit(db: D1Database, input: {
  memberId: string;
  actorId: string;
  kind: BenefitKind;
  context: BenefitContext;
  reason: string;
  decision: Extract<ReturnType<typeof decideBenefit>, { allowed: true }>;
  now: string;
  expectedAuthUserId?: string;
}) {
  const { memberId, actorId, kind, context, reason, decision, now } = input;
  const redemptionId = crypto.randomUUID();
  const needsMembership = ["LT_WAIVER", "JOIN_STICKER", "LOYALTY_STICKER"].includes(kind);
  const requiredKind = kind === "LT_WAIVER" ? decision.funding : null;
  const expectedAuthUserId = input.expectedAuthUserId ?? null;
  const detail = { redemptionId, kind, key: decision.key, funding: decision.funding,
    internalAllocationJpy: decision.internalAllocationJpy, reason, context, policyVersion: BUSINESS_POLICY.version };
  const [result] = await db.batch([
    db.prepare(`INSERT INTO benefit_redemptions (id, member_id, kind, benefit_key, event_id, occurred_at, funding, internal_allocation_jpy, confirmed_by, reason, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM members m WHERE m.id = ? AND m.status = 'active'
      AND (? IS NULL OR m.auth_user_id = ?)
      AND (? = 0 OR EXISTS (SELECT 1 FROM membership_grants g WHERE g.member_id = m.id AND (? IS NULL OR g.kind = ?)
        AND g.valid_from <= ? AND (g.valid_until IS NULL OR ? < g.valid_until) AND (g.revoked_at IS NULL OR ? < g.revoked_at)
        AND (g.kind <> 'MONTHLY' OR g.valid_until IS NOT NULL)))
      ON CONFLICT(member_id, kind, benefit_key) DO NOTHING`)
      .bind(redemptionId, memberId, kind, decision.key, context.eventId ?? null, decision.occurredAt,
        decision.funding, decision.internalAllocationJpy, actorId, reason, now, memberId, expectedAuthUserId, expectedAuthUserId,
        needsMembership ? 1 : 0, requiredKind, requiredKind, decision.occurredAt, decision.occurredAt, decision.occurredAt),
    db.prepare("INSERT INTO audit_log (id, actor_user_id, member_id, action, detail, created_at) SELECT ?, ?, ?, 'benefit.redeem', ?, ? WHERE changes() = 1")
      .bind(crypto.randomUUID(), actorId, memberId, JSON.stringify(detail), now),
  ]);
  if (result.meta.changes !== 1) return null;
  return { id: redemptionId, funding: decision.funding, internalAllocationJpy: decision.internalAllocationJpy };
}
