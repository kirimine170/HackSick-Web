import { COUPON_TEMPLATES, isPromotionKind } from "./coupon-templates.ts";

export interface CouponProduct {
  sku: string;
  name: string;
  category: string;
  unitPriceJpy: number;
  selectable: boolean;
}

interface Recipient { email: string; name: string; hsapId: string | null; hasAccount: number }

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const yen = (amount: number) => `${amount.toLocaleString("ja-JP")}円`;
const searchKey = (value: string) => value.trim().normalize("NFKC").toLowerCase()
  .replaceAll("コーヒー", "珈琲").replaceAll("こーひー", "珈琲");

export function initializeCouponForm(
  search: (query: string) => Promise<{ recipients: Recipient[]; more: boolean }>,
  issue: (body: Record<string, unknown>) => Promise<{ code: string }>,
  refresh: () => Promise<void>,
) {
  const form = el<HTMLFormElement>("shop-coupon-form");
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
  const selected = new Set<string>();
  const query = el<HTMLInputElement>("coupon-product-query");
  const category = el<HTMLSelectElement>("coupon-product-category");
  const recipientQuery = el<HTMLInputElement>("coupon-recipient-search");
  const recipientSearch = el<HTMLButtonElement>("coupon-search-recipient");
  const recipientStatus = el("coupon-recipient-status");
  const resultsBox = el("coupon-recipient-results");
  const shared = form.querySelector<HTMLInputElement>('input[name="audience"][value="shared"]')!;
  const personal = form.querySelector<HTMLInputElement>('input[name="audience"][value="personal"]')!;
  const submit = el<HTMLButtonElement>("coupon-issue");
  const result = el("coupon-issued");
  const issuedCode = el<HTMLInputElement>("coupon-issued-code");
  const status = el("coupon-issue-status");
  let products: CouponProduct[] = [];
  let loaded = false;
  let issuing = false;
  let recipientVersion = 0;

  function renderPreview() {
    const template = field("template").value;
    const fraction = isPromotionKind(template) ? COUPON_TEMPLATES[template].percent : field("percent").value;
    const expires = field("expiresAt").value.replace("T", " ");
    const photos = Number(field("photos").value);
    const budget = template === "supporter" ? COUPON_TEMPLATES.supporter.maxDiscountJpy
      : template === "photographer" ? photos * COUPON_TEMPLATES.photographer.creditPerPhotoJpy
        : Number(field("budgetJpy").value);
    const audience = personal.checked ? field("email").value.trim() || "利用者を選択してください" : "共通コード";
    const perAccount = template === "lt" || template === "supporter" ? 1
      : Number(field("accountLimit").value) || (template === "custom" ? 1 : 0);
    el("coupon-preview").textContent = [
      audience, fraction ? `${fraction}％引き` : "割引率を入力してください", `対象 ${selected.size}商品`,
      field("memberDiscountMode").value === "stack" ? "会員割引と併用" : "割引額が大きい方を適用",
      expires ? `${expires}（日本時間）まで` : "発行から30日間",
      perAccount ? `1人${perAccount.toLocaleString("ja-JP")}回まで` : "",
      field("useLimit").value ? `全体で${field("useLimit").value}回まで` : "",
      budget > 0 ? `累計${yen(budget)}まで` : "",
    ].filter(Boolean).join(" ／ ");
    const names = products.filter(product => selected.has(product.sku)).map(product => product.name);
    el("coupon-products-selected").textContent = names.length ? `選択中の${names.length}商品　${names.join("，")}` : "対象商品を1点以上選んでください．";
    submit.disabled = !loaded || issuing || !selected.size;
  }

  function renderProducts() {
    const words = searchKey(query.value).split(/\s+/).filter(Boolean);
    const options = products.filter(product => (!category.value || product.category === category.value) &&
      words.every(word => searchKey(`${product.name} ${product.sku} ${product.category}`).includes(word)));
    const list = el("coupon-product-options");
    list.replaceChildren(...options.map(product => {
      const choice = document.createElement("label");
      choice.className = "coupon-product";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = selected.has(product.sku);
      input.addEventListener("change", () => {
        if (input.checked) selected.add(product.sku);
        else selected.delete(product.sku);
        renderPreview();
      });
      const info = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = product.name;
      const details = document.createElement("small");
      details.textContent = `${product.category} ／ ${yen(product.unitPriceJpy)} ／ ${product.sku}`;
      info.append(name, details);
      choice.append(input, info);
      return choice;
    }));
    if (!options.length) list.textContent = loaded ? "条件に一致する商品がありません．" : "対象商品の一覧を読み込んでいます．";
  }

  function renderConditions() {
    const template = field("template").value;
    shared.disabled = template === "photographer" || template === "supporter";
    if (shared.disabled) personal.checked = true;
    field("email").disabled = !personal.checked;
    field("email").required = personal.checked;
    el("coupon-personal").hidden = !personal.checked;
    el("coupon-audience-help").hidden = personal.checked;
    for (const label of form.querySelectorAll<HTMLLabelElement>("[data-coupon-templates]")) {
      label.hidden = !label.dataset.couponTemplates!.split(" ").includes(template);
      label.querySelector("input")!.disabled = label.hidden;
    }
    renderPreview();
  }

  async function searchRecipients() {
    const keyword = recipientQuery.value.trim();
    if (!keyword || !personal.checked) return;
    const version = ++recipientVersion;
    resultsBox.replaceChildren();
    recipientStatus.textContent = "利用者を検索しています．";
    recipientSearch.disabled = true;
    try {
      const { recipients, more } = await search(keyword);
      if (version !== recipientVersion || !personal.checked) return;
      recipientStatus.textContent = recipients.length ? more ? "上位20件を表示しています．検索語を追加して絞り込めます．" : `${recipients.length}件見つかりました．`
        : "該当する利用者はいません．ログイン用メールアドレスを直接入力できます．";
      resultsBox.replaceChildren(...recipients.map(recipient => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "coupon-recipient";
        const name = document.createElement("strong");
        name.textContent = recipient.name;
        const description = document.createElement("small");
        description.textContent = [recipient.email, recipient.hsapId, recipient.hasAccount ? "ログイン用メール" : "台帳の登録メール"].filter(Boolean).join(" ／ ");
        button.append(name, description);
        button.addEventListener("click", () => {
          field("email").value = recipient.email;
          resultsBox.replaceChildren();
          recipientStatus.textContent = `${recipient.name}さんを選びました．`;
          field("email").focus();
          renderPreview();
        });
        return button;
      }));
    } catch (error) {
      if (version === recipientVersion) recipientStatus.textContent = (error as Error).message;
    } finally {
      if (version === recipientVersion) recipientSearch.disabled = false;
    }
  }

  function clearRecipientResults() {
    ++recipientVersion;
    recipientSearch.disabled = !recipientQuery.value.trim();
    recipientStatus.textContent = "";
    resultsBox.replaceChildren();
  }
  recipientQuery.addEventListener("input", clearRecipientResults);
  recipientQuery.addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    void searchRecipients();
  });
  recipientSearch.addEventListener("click", () => void searchRecipients());
  query.addEventListener("input", renderProducts);
  category.addEventListener("change", renderProducts);
  form.addEventListener("input", renderPreview);
  form.addEventListener("change", event => {
    const input = event.target as HTMLInputElement;
    if (input.name === "audience" || input.name === "template") {
      renderConditions();
      if (!personal.checked) clearRecipientResults();
    }
  });

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (submit.disabled) return;
    const values = Object.fromEntries(new FormData(form));
    const { template, label, code, email, expiresAt, costConfirmed, memberDiscountMode } = values;
    const body: Record<string, unknown> = { template, label, code, email, memberDiscountMode, costConfirmed: costConfirmed === "on", skus: [...selected] };
    if (expiresAt) {
      const expiry = new Date(`${expiresAt}+09:00`);
      if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()) {
        status.textContent = "未来の有効期限を指定してください．";
        field("expiresAt").focus();
        return;
      }
      body.expiresAt = expiry.toISOString();
    }
    for (const key of ["percent", "useLimit", "accountLimit", "budgetJpy", "photos"]) {
      if (values[key]) body[key] = Number(values[key]);
    }
    issuing = true;
    submit.disabled = true;
    status.textContent = "クーポンを発行しています．";
    try {
      const { code: created } = await issue(body);
      form.reset();
      selected.clear();
      clearRecipientResults();
      renderConditions();
      renderProducts();
      issuedCode.value = created;
      result.hidden = false;
      issuedCode.focus();
      status.textContent = "クーポンを発行しました．";
      try { await refresh(); }
      catch { status.textContent = "クーポンを発行しました．発行済み一覧はページを再読み込みして確認してください．"; }
    } catch (error) {
      status.textContent = (error as Error).message;
    } finally {
      issuing = false;
      renderPreview();
    }
  });

  el("coupon-copy-code").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(issuedCode.value);
      status.textContent = "コードをコピーしました．";
    } catch {
      issuedCode.select();
      status.textContent = "表示したコードをコピーしてください．";
    }
  });
  clearRecipientResults();
  renderConditions();

  return (catalog: CouponProduct[]) => {
    products = catalog.filter(product => product.selectable);
    const categories = [...new Set(products.map(product => product.category))];
    const previous = category.value;
    category.replaceChildren(new Option("すべて", ""), ...categories.map(value => new Option(value, value)));
    category.value = categories.includes(previous) ? previous : "";
    for (const sku of selected) {
      if (!products.some(product => product.sku === sku)) selected.delete(sku);
    }
    loaded = true;
    renderProducts();
    renderPreview();
  };
}
