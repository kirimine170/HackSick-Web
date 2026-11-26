import { InputError, normalizeEmail, requiredText } from "./eligibility.ts";
import { CheckoutConflict } from "./checkout.ts";
import type { Member } from "./types.ts";

export const HSAP_SOURCE = "https://docs.google.com/spreadsheets/d/1K3RDvJEdyA11cEr6c9Arf4jXgDj6edDKuKADrOzgyf0/edit";
export interface HsapRow { hsapId: string; displayName: string; email: string; workspaceEmail?: string | null; status: string; departedAt?: string | null }

export function normalizeHsapRows(input: unknown) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 100) throw new InputError("台帳の確認済み行を1〜100件指定してください．");
  const ids = new Set<string>(); const emails = new Set<string>();
  return input.map(raw => {
    if (!raw || typeof raw !== "object") throw new InputError("台帳の行を確認してください．");
    const row = raw as HsapRow;
    const hsapId = requiredText(row.hsapId, "HSAP ID", 40);
    if (!/^HSAP-\d{6}$/.test(hsapId) || ids.has(hsapId)) throw new InputError("HSAP IDの形式・重複を確認してください．");
    ids.add(hsapId);
    const email = normalizeEmail(row.email);
    const workspaceEmail = row.workspaceEmail ? normalizeEmail(row.workspaceEmail) : null;
    if (workspaceEmail && !workspaceEmail.endsWith("@hacksick.com")) throw new InputError("確定Workspaceメールを確認してください．");
    const aliases = [...new Set([email, ...(workspaceEmail ? [workspaceEmail] : [])])];
    for (const alias of aliases) { if (emails.has(alias)) throw new InputError("複数人に同じログインメールを割り当てることはできません．"); emails.add(alias); }
    const status = requiredText(row.status, "管理ステータス", 40);
    return { hsapId, displayName: requiredText(row.displayName, "表示名", 100), email, workspaceEmail, aliases,
      active: status === "承認済" && !row.departedAt, status };
  });
}

/** 元の台帳は編集しない．取込前に差分を返し，確認されたスナップショットだけ保存する． */
export async function importHsap(db: D1Database, actor: string, body: Record<string, unknown>) {
  if (body.source !== HSAP_SOURCE) throw new InputError("取り込み元の台帳を確認してください．");
  const rows = normalizeHsapRows(body.rows);
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  const preview = [];
  for (const row of rows) {
    const member = await db.prepare("SELECT * FROM members WHERE hsap_id = ?").bind(row.hsapId)
      .first<Member & { hsap_workspace_only: number }>();
    const memberId = member?.id ?? `HS-${crypto.randomUUID()}`;
    let aliases = row.aliases;
    if (member?.hsap_workspace_only === 1) {
      const verified = normalizeEmail(member.claim_email);
      if (!verified.endsWith("@hacksick.com") || (row.workspaceEmail && row.workspaceEmail !== verified)) {
        throw new CheckoutConflict(`${row.hsapId} の照合先メールが登録済みのWorkspaceメールと一致しません．`);
      }
      aliases = [verified];
    }
    for (const email of aliases) {
      const collision = await db.prepare("SELECT id FROM members WHERE claim_email = ? COLLATE NOCASE AND id <> ? UNION SELECT member_id AS id FROM member_emails WHERE email = ? COLLATE NOCASE AND member_id <> ?")
        .bind(email, memberId, email, memberId).first();
      if (collision) throw new CheckoutConflict(`${row.hsapId} のメールが別の会員に登録されています．本人確認のうえ個別に紐付けてください．`);
    }
    const evidence = `hsap-master:${row.hsapId}`;
    const current = member ? await db.prepare("SELECT id FROM membership_grants WHERE member_id = ? AND kind = 'HSAP' AND evidence_id = ? AND revoked_at IS NULL").bind(memberId, evidence).first<{ id: string }>() : null;
    preview.push({ hsapId: row.hsapId, action: !member ? "create" : "update", active: row.active, googleReady: Boolean(row.workspaceEmail || member?.hsap_workspace_only), blocked: member?.status === "blocked" });
    if (!member) statements.push(db.prepare("INSERT INTO members (id,display_name,claim_email,hsap_id,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)").bind(memberId, row.displayName, row.email, row.hsapId, now, now));
    for (const email of aliases) statements.push(db.prepare("INSERT INTO member_emails (email,member_id,source,created_at) VALUES (?,?,?,?) ON CONFLICT(email) DO UPDATE SET source = excluded.source WHERE member_emails.member_id = excluded.member_id").bind(email, memberId, HSAP_SOURCE, now));
    if (row.active && !current) statements.push(db.prepare("INSERT INTO membership_grants (id,member_id,kind,valid_from,valid_until,evidence_id,confirmed_by,reason,created_at) VALUES (?,?,'HSAP',?,NULL,?,?,?,?)")
      .bind(crypto.randomUUID(), memberId, now, evidence, actor, "HSAP台帳の承認済み・退会日なしを確認", now));
    if (!row.active && current) statements.push(db.prepare("UPDATE membership_grants SET revoked_at = ? WHERE id = ?").bind(now, current.id));
    statements.push(db.prepare("INSERT INTO audit_log (id,actor_user_id,member_id,action,detail,created_at) VALUES (?,?,?,'hsap.import',?,?)")
      .bind(crypto.randomUUID(), actor, memberId, JSON.stringify({ source: HSAP_SOURCE, hsapId: row.hsapId, active: row.active, workspaceConfirmed: Boolean(row.workspaceEmail) }), now));
  }
  if (body.confirmed !== true) return { dryRun: true, rows: preview };
  if (body.emailsVerified !== true) throw new InputError("ログインメールが各会員本人のものであることを確認してください．");
  await db.batch(statements);
  return { dryRun: false, rows: preview };
}
