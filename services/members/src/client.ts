import { createAuthClient } from "better-auth/client";
import { emailOTPClient } from "better-auth/client/plugins";
import { initializeAdminShopControls, loadShop, loadShopAdmin, prefillShippingAddress } from "./shop-client.ts";
import { configureStorefront, loadStorefront } from "./storefront-client.ts";
import { MEMBER_PRICING } from "./member-pricing.ts";
import { loadCoffee } from "./coffee-client.ts";
import { initLtCheckIn, initMemberPass } from "./member-pass-client.ts";

const auth = createAuthClient({ plugins: [emailOTPClient()] });
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const show = (id: string, visible: boolean) => { el(id).hidden = !visible; };
const notice = (message: string) => { el("notice").textContent = message; };
const date = (value: string | null) => value ? new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Tokyo" }).format(new Date(value)) : "期限の設定なし";
let manager = false;
let selected: string | null = null;
let next: string | null = null;
let email = "";
let coffeePublicEnabled = false;
let storefront = false;
let storefrontUrl: string | undefined;
let coffeeIntent = location.hash === "#coffee" || location.hash === "#storefront-coffee";

interface Grant { id: string; kind: string; valid_from: string; valid_until: string | null; revoked_at: string | null; evidence_id?: string; active?: boolean }
interface Member { id: string; display_name: string; hsap_id: string | null; claim_email?: string; auth_user_id?: string | null; status: string }
interface Me { user: { id: string; email: string }; operator: string | null; member: Member | null; grants: Grant[]; benefit: { eligible: boolean; discountPercent: number } }

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "処理を完了できませんでした．");
  return data;
}

const showMemberPass = initMemberPass(api);
let showLtCheckIn: ReturnType<typeof initLtCheckIn> | undefined;
const shopAdminIntent = location.hash === "#shop-admin";

function text(tag: string, value: string, className?: string) {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}

function bindForm(id: string, callback: (body: Record<string, string>) => Promise<void>) {
  el<HTMLFormElement>(id).addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const button = form.querySelector("button")!;
    button.disabled = true;
    try { await callback(Object.fromEntries(new FormData(form).entries()) as Record<string, string>); }
    catch (error) { notice(error instanceof Error ? error.message : "処理を完了できませんでした．"); }
    finally { button.disabled = false; }
  });
}

async function refresh() {
  const session = await auth.getSession();
  if (session.error) throw new Error("ログイン状態を確認できませんでした．接続を確認して再読み込みしてください．");
  const signedIn = Boolean(session.data);
  if (storefront) {
    if (signedIn) await api<Me>("/api/me");
    await loadStorefront(signedIn, coffeePublicEnabled);
    return;
  }
  show("login", !signedIn);
  show("shop-preview", !signedIn);
  show("logout", signedIn);
  show("account", signedIn);
  show("shop", signedIn);
  el("public-member-offer").textContent = coffeePublicEnabled
    ? `珈琲の定期便は，初めての方もメールアドレスでお申し込みいただけます．対象会員は通常便の基本料金から${MEMBER_PRICING.recurringDiscountPercent}％引きです．`
    : `対象会員は珈琲の単発購入が${MEMBER_PRICING.oneTimeDiscountPercent}％引きです．`;
  const shopNav = el<HTMLAnchorElement>("shop-nav");
  shopNav.href = storefrontUrl ?? "https://shop.hacksick.com/";
  const showLocalCoffee = signedIn || coffeePublicEnabled;
  show("coffee", showLocalCoffee);
  show("coffee-nav", showLocalCoffee || Boolean(storefrontUrl));
  show("coffee-guest", !signedIn);
  show("coffee-member", false);
  show("coffee-public-timeline", true);
  if (!signedIn) {
    showMemberPass(false);
    showLtCheckIn?.(false);
    notice("会員情報を確認するには，ログインしてください．");
    if (coffeeIntent && !el("coffee").hidden) el("coffee").scrollIntoView();
    return;
  }
  const me = await api<Me>("/api/me");
  manager = me.operator === "manager";
  showMemberPass(me.benefit.eligible);
  showLtCheckIn?.(manager && !el("admin").hidden);
  show("admin-toggle", Boolean(me.operator));
  el("signed-in-email").textContent = me.user.email;
  const box = el("membership"); box.replaceChildren();
  if (!me.member) {
    box.append(text("h3", "会員情報との照合待ちです．"), text("p", "会員登録時のメールアドレスでログインしているかをご確認ください．別のメールをご利用の場合は運営へご連絡ください．"));
  } else {
    box.append(text("p", me.member.display_name), text("p", me.member.hsap_id ?? me.member.id, "number"), text("h3", me.member.status === "blocked" ? "会員資格の利用を停止しています．" : me.benefit.eligible ? "有効な会員資格があります．" : "現在有効な会員資格はありません．"));
    if (me.benefit.eligible) {
      box.append(text("p", `対象特典：単発購入の商品代金${me.benefit.discountPercent}％引き．下の会員ショップからご利用ください．`, "small"));
      const buy=text("a","会員価格で購入する") as HTMLAnchorElement;buy.href="#shop";box.append(buy);
    }
  }
  const cards = el("qualifications"); cards.replaceChildren();
  for (const grant of me.grants) {
    const card = text("article", "", "card");
    const state = grant.revoked_at ? "取消済み" : me.member?.status === "blocked" ? "利用停止" : grant.active ? "有効" : Date.parse(grant.valid_from) > Date.now() ? "開始前" : "有効期間外";
    card.append(text("span", grant.kind === "HSAP" ? "HSAP" : "HACKSICK MEMBERSHIP", "badge"), text("p", `${date(grant.valid_from)} 〜 ${date(grant.valid_until)}`), text("p", state, "small"));
    cards.append(card);
  }
  notice("ログインしました．");
  await Promise.all([loadShop(), loadCoffeeSection(), me.operator && shopAdminIntent ? openAdmin() : Promise.resolve()]);
  prefillShippingAddress("coffee-form");
  if (location.hash === "#shop") el("shop").scrollIntoView();
}

async function loadCoffeeSection() {
  if (el("coffee").hidden) return;
  await loadCoffee();
  if (coffeeIntent) {
    history.replaceState(null, "", "#coffee");
    el("coffee").scrollIntoView();
  }
}

el("coffee-login").addEventListener("click", () => { coffeeIntent = true; });

async function list(after?: string) {
  const q = el<HTMLInputElement>("search").value;
  const data = await api<{ members: Member[]; next: string | null }>(`/api/admin/members?q=${encodeURIComponent(q)}&after=${encodeURIComponent(after ?? "")}`);
  const container = el("member-list");
  if (!after) container.replaceChildren();
  if (!data.members.length && !after) container.append(text("p", "該当する会員はありません．", "small"));
  for (const member of data.members) {
    const button = text("button", "", "member-row") as HTMLButtonElement;
    button.dataset.member = member.id;
    button.setAttribute("aria-pressed", String(member.id === selected));
    button.append(text("strong", member.display_name), text("small", `${member.hsap_id ?? member.id} ／ ${member.auth_user_id ? "本人紐付け済み" : "初回ログイン待ち"}`));
    button.addEventListener("click", () => void detail(member.id).catch(error => notice(error.message)));
    container.append(button);
  }
  next = data.next; show("next", Boolean(next));
}

async function detail(memberId: string) {
  selected = memberId;
  const data = await api<{ member: Member; grants: Grant[]; billing: { square_customer_id: string; square_subscription_id: string }[]; history: { actor_name: string; action: string; detail: string; created_at: string }[] }>(`/api/admin/members/${encodeURIComponent(memberId)}`);
  show("member-detail", true);
  el("detail-title").textContent = data.member.display_name;
  el("detail-meta").textContent = `${data.member.claim_email} ／ ${data.member.id} ／ ${data.member.status === "active" ? "利用可" : "利用停止"}`;
  for (const button of document.querySelectorAll<HTMLButtonElement>(".member-row")) button.setAttribute("aria-pressed", String(button.dataset.member === memberId));
  const grants = el("detail-grants"); grants.replaceChildren(text("h3", "会員資格"));
  for (const grant of data.grants) {
    const row = text("div", "", "entry");
    row.append(text("p", `${grant.kind} ／ ${date(grant.valid_from)} 〜 ${date(grant.valid_until)}${grant.revoked_at ? " ／ 取消済み" : ""}`));
    if (manager && !grant.revoked_at) {
      const button = text("button", "資格を取り消す", "danger") as HTMLButtonElement;
      button.addEventListener("click", async () => {
        const reason = window.prompt("取消理由を入力してください．");
        if (!reason?.trim()) return;
        button.disabled = true;
        try { await api(`/api/admin/grants/${grant.id}/revoke`, { reason }); await detail(memberId); notice("資格を取り消しました．"); }
        catch (error) { notice((error as Error).message); button.disabled = false; }
      });
      row.append(button);
    }
    grants.append(row);
  }
  if (!data.grants.length) grants.append(text("p", "資格は未登録です．", "small"));
  el("detail-billing").replaceChildren(text("h3", "Square契約の紐付け"), ...data.billing.map(link => text("p", `${link.square_customer_id} ／ ${link.square_subscription_id}`, "small number")));
  const actions: Record<string, string> = { "member.create": "会員登録", "member.claim": "初回ログインの紐付け", "member.status": "利用状態の変更", "grant.create": "会員資格の追加", "grant.revoke": "会員資格の取消", "billing.link": "Square契約の登録", "benefit.redeem": "特典の提供記録" };
  el("history").replaceChildren(...data.history.map(item => {
    const detail = JSON.parse(item.detail) as { reason?: string; context?: { eventId?: string } };
    const event = detail.context?.eventId ? ` ／ ${detail.context.eventId}` : "";
    return text("p", `${date(item.created_at)} ／ ${item.actor_name} ／ ${actions[item.action] ?? "登録内容の変更"}${event}${detail.reason ? ` ／ ${detail.reason}` : ""}`, "entry");
  }));
  (el<HTMLFormElement>("status-form").elements.namedItem("status") as HTMLSelectElement).value = data.member.status;
  const form = el<HTMLFormElement>("grant-form");
  (form.elements.namedItem("evidenceId") as HTMLInputElement).value = data.member.hsap_id ?? "";
}

el("google").addEventListener("click", async () => {
  try { const result = await auth.signIn.social({ provider: "google", callbackURL: shopAdminIntent ? "/#shop-admin" : coffeeIntent ? "/#coffee" : "/" }); if (result.error) notice("Googleログインを開始できませんでした．"); }
  catch { notice("Googleログインを開始できませんでした．"); }
});
bindForm("email-form", async () => {
  email = el<HTMLInputElement>("email").value.trim();
  const result = await auth.emailOtp.sendVerificationOtp({ email, type: "sign-in" });
  if (result.error) throw new Error("コードを送信できませんでした．時間をおいて再度お試しください．");
  show("otp-form", true); notice("確認コードを送信しました．メールをご確認ください．"); el("otp").focus();
});
bindForm("otp-form", async () => {
  const result = await auth.signIn.emailOtp({ email, otp: el<HTMLInputElement>("otp").value });
  if (result.error) throw new Error("コードが正しくないか，有効期限が切れています．");
  await refresh();
});
el("logout").addEventListener("click", async () => { await auth.signOut(); location.reload(); });
el<HTMLButtonElement>("admin-toggle").addEventListener("click", async event => {
  const toggle = event.currentTarget as HTMLButtonElement;
  if (!el("admin").hidden) { show("admin", false); showLtCheckIn?.(false); return; }
  toggle.disabled = true;
  try { await openAdmin(); }
  catch (error) { notice((error as Error).message); }
  finally { toggle.disabled = false; }
});

async function openAdmin() {
  const panel = el("admin");
  if (!panel.firstElementChild) {
    const fragment = await fetch("/api/admin/panel", { cache: "no-store" });
    if (!fragment.ok) throw Error("運営画面を開けませんでした．運営アカウントをご確認ください．");
    panel.innerHTML = await fragment.text();
    showLtCheckIn = initLtCheckIn(api);
    initializeAdminShopControls();
    bindForm("search-form", async () => { await list(); });
    el("next").addEventListener("click", () => { if (next) void list(next).catch(error => notice(error.message)); });
    bindForm("create-form", async body => { const result = await api<{ id: string }>("/api/admin/members", body); el<HTMLFormElement>("create-form").reset(); await list(); await detail(result.id); notice("会員を登録しました．資格を確認して追加してください．"); });
    bindForm("grant-form", async body => {
      if (!selected) return;
      const tokyo = (value: string) => value ? new Date(`${value}:00+09:00`).toISOString() : null;
      await api(`/api/admin/members/${selected}/grants`, { ...body, validFrom: tokyo(body.validFrom), validUntil: tokyo(body.validUntil) });
      el<HTMLFormElement>("grant-form").reset(); await detail(selected); notice("会員資格を追加しました．");
    });
    bindForm("billing-form", async body => { if (selected) { await api(`/api/admin/members/${selected}/billing-links`, body); el<HTMLFormElement>("billing-form").reset(); await detail(selected); notice("照合済み契約を登録しました．"); } });
    bindForm("status-form", async body => { if (selected) { await api(`/api/admin/members/${selected}/status`, body); await detail(selected); notice("利用状態を変更しました．"); } });
  }
  panel.hidden = false;
  show("create-section", manager);
  show("manager-actions", manager);
  showLtCheckIn?.(manager);
  const shopPanel = el<HTMLDetailsElement>("shop-admin");
  if (shopAdminIntent && manager) shopPanel.open = true;
  await Promise.all([list(), manager ? loadShopAdmin() : Promise.resolve()]);
  if (shopAdminIntent && manager) shopPanel.scrollIntoView();
}

void (async () => {
  const config = await api<{ google: boolean; email: boolean; coffee?: boolean; storefront?: boolean; shopUrl?: string }>("/api/config");
  coffeePublicEnabled = config.coffee === true;
  storefront = config.storefront === true;
  storefrontUrl = config.shopUrl;

  if (storefront) configureStorefront();
  else if (coffeePublicEnabled) {
    el("login-description").textContent = "HSAPの方はHackSickのGoogleアカウントをご利用ください．月額会員の方は登録済みのメールアドレスで，定期便をご希望の方は普段お使いのメールアドレスでログインできます．";
    el("email-label").textContent = "メールアドレス";
  }
  show("google", config.google);
  el<HTMLFormElement>("email-form").querySelector<HTMLButtonElement>("button")!.disabled = !config.email;
  await refresh();
  if (!config.google && !config.email) notice("ログインの設定が完了していません．運営へお問い合わせください．");
})().catch(error => notice(error.message));
